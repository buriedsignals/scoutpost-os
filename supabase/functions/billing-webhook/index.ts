/**
 * billing-webhook Edge Function — MuckRock webhook receiver.
 *
 * Ports cojournalist/backend/app/routers/auth.py:250-353.
 *
 * Verifies HMAC-SHA256:
 *   signature == HMAC(timestamp + type + uuids.join(""), CLIENT_SECRET)
 * Rejects stale timestamps (> 2 minutes) and unsigned requests.
 *
 * Dispatches by event type:
 *   "user"         — fetch userinfo, run applyUserEvent
 *   "organization" — fetch org, either applyIndividualOrgChange,
 *                    applyTeamOrgTopup, or cancelTeamOrg
 *
 * Failure per UUID is logged and suppressed so a single bad record doesn't
 * block the rest of the batch.
 */

import { handleCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonOk } from "../_shared/responses.ts";
import { logEvent } from "../_shared/log.ts";
import { MuckrockClient } from "../_shared/muckrock.ts";
import {
  applyIndividualOrgChange,
  applyTeamOrgTopup,
  applyUserEvent,
  cancelTeamOrg,
  isCojournalistTeamEntitlement,
} from "../_shared/entitlements.ts";

interface WebhookBody {
  timestamp: string;
  type: string;
  uuids: string[];
  signature: string;
}

const MAX_TIMESTAMP_DRIFT_SECONDS = 120;

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function computeHmac(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return jsonError("method not allowed", 405);

  let body: WebhookBody;
  try {
    body = (await req.json()) as WebhookBody;
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  if (!body.timestamp || !body.type || !body.uuids?.length || !body.signature) {
    return jsonError("missing required webhook fields", 400);
  }

  const secret = Deno.env.get("MUCKROCK_CLIENT_SECRET");
  if (!secret) {
    return jsonError(
      "server misconfigured: MUCKROCK_CLIENT_SECRET not set",
      500,
    );
  }

  const message = `${body.timestamp}${body.type}${body.uuids.join("")}`;
  const expected = await computeHmac(secret, message);
  if (!constantTimeEquals(body.signature, expected)) {
    return jsonError("invalid webhook signature", 401);
  }

  const ts = Number(body.timestamp);
  if (!Number.isFinite(ts)) {
    return jsonError("invalid timestamp", 400);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_TIMESTAMP_DRIFT_SECONDS) {
    return jsonError("webhook timestamp expired", 401);
  }

  const svc = getServiceClient();
  const muckrock = new MuckrockClient();
  let processed = 0;

  for (const uuid of body.uuids) {
    try {
      if (body.type === "user") {
        const userinfo = await muckrock.fetchUserData(uuid);
        await applyUserEvent(svc, userinfo);
      } else if (body.type === "organization") {
        const org = await muckrock.fetchOrgData(uuid);
        if (org.individual) {
          await applyIndividualOrgChange(svc, org);
        } else {
          const teamEnt = (org.entitlements ?? []).find(
            isCojournalistTeamEntitlement,
          );
          if (teamEnt) {
            await applyTeamOrgTopup(svc, org, teamEnt);
          } else {
            await cancelTeamOrg(svc, uuid);
          }
        }
      } else {
        logEvent({
          level: "warn",
          fn: "billing-webhook",
          event: "unknown_event_type",
          msg: body.type,
        });
        continue;
      }
      processed += 1;
    } catch (err) {
      logEvent({
        level: "error",
        fn: "billing-webhook",
        event: "process_failed",
        msg: `${body.type} ${uuid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  return jsonOk({ status: "ok", processed, received: body.uuids.length });
});
