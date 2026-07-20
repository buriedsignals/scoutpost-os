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
  classifyAisSampleResult,
  hasActiveSatelliteScouts,
  sampleAisWindowWithStatus,
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

interface SamplerOutcome {
  status: "succeeded" | "noop";
  connected?: boolean | null;
  providerErrored?: boolean | null;
  framesReceived?: number;
  itemsParsed?: number;
  itemsWritten?: number;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
}

class SamplerFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Partial<SamplerOutcome> = {},
  ) {
    super(message);
    this.name = "SamplerFailure";
  }
}

async function updateSamplerRun(
  svc: SupabaseClient,
  runId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await svc
    .from("transport_sampler_runs")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) throw new Error(`sampler run update failed: ${error.message}`);
}

async function trackSamplerRun(
  svc: SupabaseClient,
  runId: string,
  task: "ais" | "gp",
  work: () => Promise<SamplerOutcome>,
): Promise<void> {
  await updateSamplerRun(svc, runId, { status: "running" });
  try {
    const outcome = await work();
    await updateSamplerRun(svc, runId, {
      status: outcome.status,
      connected: outcome.connected ?? null,
      provider_errored: outcome.providerErrored ?? null,
      frames_received: outcome.framesReceived ?? 0,
      items_parsed: outcome.itemsParsed ?? 0,
      items_written: outcome.itemsWritten ?? 0,
      error_code: outcome.errorCode ?? null,
      error_message: null,
      metadata: outcome.metadata ?? {},
      completed_at: new Date().toISOString(),
    });
  } catch (error) {
    const code = error instanceof SamplerFailure
      ? error.code
      : "sampler_unhandled_error";
    const message = error instanceof Error ? error.message : String(error);
    try {
      const details = error instanceof SamplerFailure ? error.details : {};
      await updateSamplerRun(svc, runId, {
        status: "failed",
        connected: details.connected ?? null,
        provider_errored: details.providerErrored ?? null,
        frames_received: details.framesReceived ?? 0,
        items_parsed: details.itemsParsed ?? 0,
        items_written: details.itemsWritten ?? 0,
        metadata: details.metadata ?? {},
        error_code: code,
        error_message: message.slice(0, 500),
        completed_at: new Date().toISOString(),
      });
    } catch (updateError) {
      logEvent({
        level: "error",
        fn: "transport-sampler",
        event: "run_status_update_failed",
        run_id: runId,
        msg: updateError instanceof Error
          ? updateError.message
          : String(updateError),
      });
    }
    logEvent({
      level: "error",
      fn: "transport-sampler",
      event: "tracked_run_failed",
      run_id: runId,
      task,
      error_code: code,
      msg: message,
    });
    throw error;
  }
}

function runInBackground(work: Promise<void>): void {
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
): Promise<SamplerOutcome> {
  const scoutBoxes = await activeVesselBoxes(svc);
  if (scoutBoxes.length === 0) {
    logEvent({
      level: "info",
      fn: "transport-sampler",
      event: "ais_noop",
      msg: "no active vessel scouts",
    });
    return { status: "noop", errorCode: "no_active_vessel_scouts" };
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
    throw new SamplerFailure(
      "ais_api_key_missing",
      "AIS_API_KEY not configured",
    );
  }

  const sample = await sampleAisWindowWithStatus({
    apiKey,
    boxes: toSubscriptionBoxes(merged),
    windowMs,
  });
  const positions = coalesceFrames(sample.frames);
  const sampleError = classifyAisSampleResult(sample, positions.length);
  if (sampleError) {
    throw new SamplerFailure(
      sampleError,
      `AIS sample failed: connected=${sample.connected}, errored=${sample.errored}, frames=${sample.frames.length}, positions=${positions.length}`,
      {
        connected: sample.connected,
        providerErrored: sample.errored,
        framesReceived: sample.frames.length,
        itemsParsed: positions.length,
        metadata: {
          active_scout_boxes: scoutBoxes.length,
          merged_subscription_boxes: merged.length,
        },
      },
    );
  }
  let written: number;
  try {
    written = await upsertPositions(svc, positions);
  } catch (error) {
    throw new SamplerFailure(
      "ais_upsert_failed",
      error instanceof Error ? error.message : String(error),
      {
        connected: sample.connected,
        providerErrored: sample.errored,
        framesReceived: sample.frames.length,
        itemsParsed: positions.length,
      },
    );
  }
  logEvent({
    level: "info",
    fn: "transport-sampler",
    event: "ais_sample",
    msg:
      `${scoutBoxes.length} scout box(es) → ${merged.length} merged, ${sample.frames.length} frames, ${written} vessels upserted`,
  });
  return {
    status: "succeeded",
    connected: sample.connected,
    providerErrored: sample.errored,
    framesReceived: sample.frames.length,
    itemsParsed: positions.length,
    itemsWritten: written,
    metadata: {
      active_scout_boxes: scoutBoxes.length,
      merged_subscription_boxes: merged.length,
    },
  };
}

async function runGpRefresh(svc: SupabaseClient): Promise<SamplerOutcome> {
  // GP refresh is gated on satellite scouts (guard in the EF, not the cron),
  // so an all-vessel or idle deployment never hits CelesTrak.
  if (!(await hasActiveSatelliteScouts(svc))) {
    logEvent({
      level: "info",
      fn: "transport-sampler",
      event: "gp_noop",
      msg: "no active satellite scouts",
    });
    return { status: "noop", errorCode: "no_active_satellite_scouts" };
  }
  const result = await refreshGpCache(svc);
  logEvent({
    level: "info",
    fn: "transport-sampler",
    event: "gp_done",
    msg: `${result.status}, ${result.cached} cached`,
  });
  return {
    status: "succeeded",
    itemsWritten: result.cached,
    metadata: { provider_status: result.status },
  };
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
    const samplerRunId = crypto.randomUUID();
    const { error: insertError } = await svc
      .from("transport_sampler_runs")
      .insert({
        id: samplerRunId,
        task: parsed.data.task,
        status: "accepted",
        requested_window_ms: parsed.data.task === "ais" ? windowMs : null,
      });
    if (insertError) {
      return jsonFromError(
        new Error(`failed to create sampler run: ${insertError.message}`),
      );
    }

    if (parsed.data.task === "gp") {
      // Satellite GP refresh — no-op when no active satellite scouts exist.
      runInBackground(
        trackSamplerRun(svc, samplerRunId, "gp", () => runGpRefresh(svc)),
      );
      return jsonOk(
        { status: "accepted", task: "gp", run_id: samplerRunId },
        202,
      );
    }

    // 202 + background: the window outlives the pg_net request.
    runInBackground(
      trackSamplerRun(
        svc,
        samplerRunId,
        "ais",
        () => runAisSampler(svc, windowMs),
      ),
    );
    return jsonOk(
      { status: "accepted", task: "ais", run_id: samplerRunId },
      202,
    );
  })();
});
