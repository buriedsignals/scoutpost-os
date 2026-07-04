/**
 * transport-sampler Edge Function — shared AIS position sampler (+ GP stub).
 *
 * Invoked by two pg_cron jobs (migration 00073) with a task discriminator:
 *   { task: "ais" }  every 30 min — the vessel position sampler (this unit)
 *   { task: "gp" }   daily        — satellite GP refresh (U4 stub here)
 *
 * AIS flow: returns 202 immediately and runs the sampling window in
 * EdgeRuntime.waitUntil (the pg_net caller times out in ~5s; the work must
 * outlive the request — precedent: execute-scout's fire-and-forget dispatch).
 * The window opens ONE WebSocket to aisstream.io subscribed to the merged
 * bounding boxes of all active vessel scouts, coalesces latest-position-per-
 * MMSI in memory, and flushes a few batched upserts to transport_positions.
 * No-op (no connection) when there are zero active vessel scouts.
 *
 * Measured load (2026-07-03, Hormuz+Malacca+Dover): 2.2 msg/s, 168 vessels/90s
 * — the 120s window and batched writes sit far inside Edge CPU limits.
 *
 * Auth: shared service auth (X-Service-Key / service-role bearer).
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient, type SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { AuthError, ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import {
  type BBox,
  coalesceFrames,
  fitToBoxLimit,
  MAX_SUBSCRIPTION_BOXES,
  toSubscriptionBoxes,
  unionBoxes,
} from "./ais.ts";
import {
  activeVesselBoxes,
  hasActiveSatelliteScouts,
  sampleAisWindow,
  upsertPositions,
} from "./sampler.ts";
import { refreshGpCache } from "./gp.ts";

const InputSchema = z.object({
  task: z.enum(["ais", "gp"]).default("ais"),
  /** Optional override for the sampling window (ms); defaults to 120s. */
  window_ms: z.number().int().min(10_000).max(150_000).optional(),
});

declare const EdgeRuntime:
  | { waitUntil(p: Promise<unknown>): void }
  | undefined;

function runInBackground(work: Promise<unknown>): void {
  const guarded = work.catch((err) =>
    logEvent({
      level: "error",
      fn: "transport-sampler",
      event: "background_failed",
      msg: err instanceof Error ? err.message : String(err),
    })
  );
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(guarded);
  } else {
    // Local/self-host without the Supabase wrapper: run synchronously.
    void guarded;
  }
}

async function runAisSampler(
  svc: SupabaseClient,
  windowMs: number,
): Promise<void> {
  const scoutBoxes = await activeVesselBoxes(svc);
  if (scoutBoxes.length === 0) {
    logEvent({
      level: "info",
      fn: "transport-sampler",
      event: "ais_noop",
      msg: "no active vessel scouts",
    });
    return;
  }
  // Merge overlaps, then coarsen (never drop) to the subscription-box cap.
  const unioned = unionBoxes(scoutBoxes);
  const merged: BBox[] = fitToBoxLimit(unioned, MAX_SUBSCRIPTION_BOXES);
  if (unioned.length > MAX_SUBSCRIPTION_BOXES) {
    logEvent({
      level: "info",
      fn: "transport-sampler",
      event: "boxes_coarsened",
      msg:
        `${unioned.length} disjoint areas coarsened to ${merged.length} boxes (coverage preserved via over-fetch)`,
    });
  }
  const apiKey = Deno.env.get("AIS_API_KEY");
  if (!apiKey) {
    logEvent({
      level: "warn",
      fn: "transport-sampler",
      event: "ais_no_key",
      msg: "AIS_API_KEY not set; skipping sample",
    });
    return;
  }

  const frames = await sampleAisWindow({
    apiKey,
    boxes: toSubscriptionBoxes(merged),
    windowMs,
  });
  const positions = coalesceFrames(frames);
  const written = await upsertPositions(svc, positions);
  logEvent({
    level: "info",
    fn: "transport-sampler",
    event: "ais_sample",
    msg:
      `${scoutBoxes.length} scout box(es) → ${merged.length} merged, ${frames.length} frames, ${written} vessels upserted`,
  });
}

async function runGpRefresh(svc: SupabaseClient): Promise<void> {
  // GP refresh is gated on satellite scouts (guard in the EF, not the cron),
  // so an all-vessel or idle deployment never hits CelesTrak.
  if (!(await hasActiveSatelliteScouts(svc))) {
    logEvent({
      level: "info",
      fn: "transport-sampler",
      event: "gp_noop",
      msg: "no active satellite scouts",
    });
    return;
  }
  const result = await refreshGpCache(svc);
  logEvent({
    level: "info",
    fn: "transport-sampler",
    event: "gp_done",
    msg: `${result.status}, ${result.cached} cached`,
  });
}

Deno.serve((req: Request): Response | Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return jsonError("method not allowed", 405);

  try {
    requireServiceKey(req);
  } catch (e) {
    return jsonFromError(e instanceof AuthError ? e : new AuthError());
  }

  return (async () => {
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      // Empty body is fine — defaults to the AIS task.
    }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonFromError(
        new ValidationError(
          parsed.error.issues.map((i) => i.message).join("; "),
        ),
      );
    }
    const svc = getServiceClient();
    const windowMs = parsed.data.window_ms ?? 120_000;

    if (parsed.data.task === "gp") {
      // Satellite GP refresh — no-op when no active satellite scouts exist.
      runInBackground(runGpRefresh(svc));
      return jsonOk({ status: "accepted", task: "gp" }, 202);
    }

    // 202 + background: the window outlives the pg_net request.
    runInBackground(runAisSampler(svc, windowMs));
    return jsonOk({ status: "accepted", task: "ais" }, 202);
  })();
});
