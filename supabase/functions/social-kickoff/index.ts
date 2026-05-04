/**
 * social-kickoff Edge Function — Social Scout async kickoff.
 *
 * Starts an Apify actor run for a given social scout and records a
 * pending/running row in apify_run_queue. The Apify webhook (handled by
 * the sibling `apify-callback` function) eventually flips the row to
 * succeeded/failed and triggers downstream processing.
 *
 * Auth: service-role Bearer only (invoked by execute-scout dispatcher or
 *       directly by pg_cron-style jobs).
 *
 * Body: { scout_id: uuid, run_id?: uuid }
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import {
  getServiceClient,
  getServiceRoleKey,
  getSupabaseUrl,
  SupabaseClient,
} from "../_shared/supabase.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import {
  AuthError,
  NotFoundError,
  ValidationError,
} from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import {
  decrementOrThrow,
  getSocialMonitoringCost,
  InsufficientCreditsError,
  insufficientCreditsResponse,
  refundCredits,
  SOCIAL_MONITORING_KEYS,
} from "../_shared/credits.ts";
import { repairMissingSocialBaseline } from "../_shared/baseline_repair.ts";
import {
  buildSocialActorInput,
  SOCIAL_APIFY_ACTORS,
} from "../_shared/social_baseline.ts";

const KickoffSchema = z.object({
  scout_id: z.string().uuid(),
  run_id: z.string().uuid().optional(),
});

// Actor IDs confirmed against production cojournalist backend
// (backend/app/workflows/apify_client.py). Do NOT change these without
// testing — the input shape below is actor-specific, different IDs produce
// different JSON payloads.
const APIFY_ACTORS: Record<string, string> = Object.fromEntries(
  Object.entries(SOCIAL_APIFY_ACTORS).map(([platform, actor]) => [
    platform,
    actor.id,
  ]),
);

const ERROR_MAX = 2_000;

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  let serviceKey = "";
  try {
    requireServiceKey(req);
    serviceKey = Deno.env.get("INTERNAL_SERVICE_KEY") || getServiceRoleKey();
  } catch (e) {
    if (e instanceof AuthError) return jsonFromError(e);
    return jsonFromError(new AuthError("service-role required"));
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonFromError(new ValidationError("invalid JSON body"));
  }
  const parsed = KickoffSchema.safeParse(body);
  if (!parsed.success) {
    return jsonFromError(
      new ValidationError(parsed.error.issues.map((i) => i.message).join("; ")),
    );
  }
  const { scout_id, run_id } = parsed.data;

  const svc = getServiceClient();

  try {
    return await startApifyRun(svc, scout_id, serviceKey, run_id);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "social-kickoff",
      event: "unhandled",
      scout_id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

async function startApifyRun(
  svc: SupabaseClient,
  scoutId: string,
  serviceKey: string,
  existingRunId: string | undefined,
): Promise<Response> {
  // 1. Load scout.
  const { data: scout, error: scoutErr } = await svc
    .from("scouts")
    .select("id, user_id, platform, profile_handle, baseline_established_at")
    .eq("id", scoutId)
    .maybeSingle();
  if (scoutErr) throw new Error(scoutErr.message);
  if (!scout) throw new NotFoundError("scout");

  const platform = scout.platform as string | null;
  const handle = scout.profile_handle as string | null;
  if (!platform) throw new ValidationError("scout.platform is required");
  if (!handle) throw new ValidationError("scout.profile_handle is required");
  const actorId = APIFY_ACTORS[platform];
  if (!actorId) throw new ValidationError(`unknown platform: ${platform}`);

  // 2a. Reuse the scout_runs row the dispatcher (execute-scout / trigger_scout_run
  //     pg_cron) already created. Only create one here for standalone callers
  //     (manual tests). Previous code *always* inserted, leaving the dispatcher's
  //     row stuck at status=running forever — one orphan per scheduled run.
  let runId: string;
  if (existingRunId) {
    runId = existingRunId;
  } else {
    const { data: runRow, error: runErr } = await svc
      .from("scout_runs")
      .insert({
        scout_id: scoutId,
        user_id: scout.user_id,
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (runErr) throw new Error(runErr.message);
    runId = runRow.id as string;
  }

  const { data: snapshot, error: snapshotErr } = await svc
    .from("post_snapshots")
    .select("id, post_count")
    .eq("scout_id", scoutId)
    .maybeSingle();
  if (snapshotErr) throw new Error(snapshotErr.message);
  if (!snapshot) {
    const detail =
      "social scout has no baseline snapshot; recreate or reschedule the scout so creation can establish one before Run Now";
    await svc
      .from("scout_runs")
      .update({
        status: "error",
        error_message: detail,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    throw new ValidationError(detail);
  }

  if (!scout.baseline_established_at) {
    const repair = await repairMissingSocialBaseline(svc, scoutId);
    if (repair.repaired) {
      logEvent({
        level: "info",
        fn: "social-kickoff",
        event: "baseline_backfilled_from_social_snapshot",
        scout_id: scoutId,
        repaired_at: repair.repairedAt,
      });
    }
  }

  // 2b. Decrement credits before spending money on Apify, after baseline
  //     presence is confirmed so Run Now never bootstraps the first baseline.
  try {
    const cost = getSocialMonitoringCost(platform);
    const operation = SOCIAL_MONITORING_KEYS[platform] ??
      "social_monitoring_instagram";
    await decrementOrThrow(svc, {
      userId: scout.user_id,
      cost,
      scoutId,
      scoutType: "social",
      operation,
    });
  } catch (e) {
    if (e instanceof InsufficientCreditsError) {
      return insufficientCreditsResponse(e.required, e.current);
    }
    throw e;
  }

  // 3b. Insert apify_run_queue row (pending), linking to the run.
  const { data: queueRow, error: qErr } = await svc
    .from("apify_run_queue")
    .insert({
      user_id: scout.user_id,
      scout_id: scoutId,
      scout_run_id: runId,
      platform,
      handle,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (qErr) throw new Error(qErr.message);
  const queueId = queueRow.id as string;

  // 3. If APIFY_API_TOKEN isn't configured, fail/refund immediately. Leaving
  //    the queue pending hides an operator misconfiguration and charges users
  //    for work that can never start.
  const apifyToken = Deno.env.get("APIFY_API_TOKEN") ?? "";
  if (!apifyToken) {
    const detail = "APIFY_API_TOKEN not configured";
    await markQueueFailed(svc, queueId, detail, {
      userId: scout.user_id as string,
      scoutId,
      platform,
      runId,
    });
    logEvent({
      level: "warn",
      fn: "social-kickoff",
      event: "no_apify_token",
      scout_id: scoutId,
      queue_id: queueId,
    });
    return jsonError(detail, 503, "apify_not_configured");
  }

  // 4. Start the actor run. Per Apify API v2, ad-hoc run webhooks must be
  //    supplied as a base64-encoded JSON query parameter — a top-level
  //    `webhooks` field in the JSON body is silently dropped (verified live
  //    2026-04-21: webhook-dispatches=0 for every body-passed registration).
  const supabaseUrl = getSupabaseUrl();
  const webhookUrl = `${supabaseUrl}/functions/v1/apify-callback`;
  const input = buildActorInput(platform, handle);
  const webhookSpec = [
    {
      eventTypes: [
        "ACTOR.RUN.SUCCEEDED",
        "ACTOR.RUN.FAILED",
        "ACTOR.RUN.TIMED_OUT",
        "ACTOR.RUN.ABORTED",
      ],
      requestUrl: webhookUrl,
      headersTemplate: JSON.stringify({
        "Authorization": `Bearer ${serviceKey}`,
        "X-Service-Key": serviceKey,
        "Content-Type": "application/json",
        "X-Apify-Webhook-Signature": "{{signature}}",
      }),
    },
  ];
  // Apify requires the webhooks JSON array to be base64-encoded and sent as a
  // query parameter. Standard base64 includes `+` `/` and `=` so URL-encode
  // before appending — without this, the query string parses as garbled
  // characters and Apify silently drops the webhook (verified live 2026-04-21).
  const webhooksB64 = encodeURIComponent(btoa(JSON.stringify(webhookSpec)));
  const runsUrl =
    `https://api.apify.com/v2/acts/${actorId}/runs?webhooks=${webhooksB64}`;

  let apifyRes: Response;
  try {
    apifyRes = await fetch(
      runsUrl,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apifyToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markQueueFailed(svc, queueId, `network error: ${msg}`, {
      userId: scout.user_id as string,
      scoutId,
      platform,
      runId,
    });
    logEvent({
      level: "error",
      fn: "social-kickoff",
      event: "apify_network_error",
      scout_id: scoutId,
      queue_id: queueId,
      msg,
    });
    return jsonError(`apify network error: ${msg}`, 502, "apify_network");
  }

  if (!apifyRes.ok) {
    const text = await safeText(apifyRes);
    const detail = `${apifyRes.status}: ${text}`.slice(0, ERROR_MAX);
    await markQueueFailed(svc, queueId, detail, {
      userId: scout.user_id as string,
      scoutId,
      platform,
      runId,
    });
    logEvent({
      level: "error",
      fn: "social-kickoff",
      event: "apify_non_2xx",
      scout_id: scoutId,
      queue_id: queueId,
      status: apifyRes.status,
    });
    return jsonError(
      `apify returned ${apifyRes.status}: ${text}`,
      502,
      "apify_failed",
    );
  }

  const body = await apifyRes.json().catch(() => ({}));
  const apifyRunId = body?.data?.id as string | undefined;
  if (!apifyRunId) {
    await markQueueFailed(svc, queueId, "apify response missing data.id", {
      userId: scout.user_id as string,
      scoutId,
      platform,
      runId,
    });
    return jsonError("apify response missing data.id", 502, "apify_failed");
  }

  // 5. Mark running.
  const { error: updErr } = await svc
    .from("apify_run_queue")
    .update({
      status: "running",
      apify_run_id: apifyRunId,
      started_at: new Date().toISOString(),
    })
    .eq("id", queueId);
  if (updErr) throw new Error(updErr.message);

  logEvent({
    level: "info",
    fn: "social-kickoff",
    event: "started",
    scout_id: scoutId,
    queue_id: queueId,
    apify_run_id: apifyRunId,
    platform,
  });

  return jsonOk(
    { status: "started", queue_id: queueId, apify_run_id: apifyRunId },
    202,
  );
}

// Input shapes mirror the production Python start_*_scraper_async helpers
// (backend/app/workflows/apify_client.py). The apidojo actors expect
// `startUrls` + `maxItems`; the cleansyntax facebook actor uses an
// endpoint/urls_text/max_posts shape.
function buildActorInput(
  platform: string,
  handle: string,
): Record<string, unknown> {
  return buildSocialActorInput(
    platform as "instagram" | "x" | "facebook" | "tiktok",
    handle,
  );
}

async function markQueueFailed(
  svc: SupabaseClient,
  queueId: string,
  detail: string,
  refund?: {
    userId: string;
    scoutId: string;
    platform: string;
    runId?: string;
  },
): Promise<void> {
  try {
    await svc
      .from("apify_run_queue")
      .update({
        status: "failed",
        last_error: detail.slice(0, ERROR_MAX),
        completed_at: new Date().toISOString(),
      })
      .eq("id", queueId);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "social-kickoff",
      event: "mark_failed_failed",
      queue_id: queueId,
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  if (refund?.runId) {
    try {
      await svc
        .from("scout_runs")
        .update({
          status: "error",
          error_message: detail.slice(0, ERROR_MAX),
          completed_at: new Date().toISOString(),
        })
        .eq("id", refund.runId);
    } catch (e) {
      logEvent({
        level: "error",
        fn: "social-kickoff",
        event: "mark_run_failed_failed",
        queue_id: queueId,
        run_id: refund.runId,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Refund the pre-charge — Apify never ran to completion, so the user
  // shouldn't eat the social_monitoring_* credits.
  if (refund) {
    const cost = getSocialMonitoringCost(refund.platform);
    const operation = SOCIAL_MONITORING_KEYS[refund.platform] ??
      "social_monitoring_instagram";
    await refundCredits(svc, {
      userId: refund.userId,
      cost,
      scoutId: refund.scoutId,
      scoutType: "social",
      operation,
    });
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
