/**
 * transport-sampler Edge Function — shared VesselAPI positions + GP refresh.
 *
 * Invoked by two pg_cron jobs with a task discriminator:
 *   { task: "ais" }  hourly — exact-MMSI VesselAPI position refresh
 *   { task: "gp" }   daily  — satellite GP refresh
 *
 * Both tasks return 202 immediately and run under EdgeRuntime.waitUntil so
 * provider work outlives pg_net's short request window. Auth uses the shared
 * internal service-key boundary.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient, type SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { AuthError, ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import {
  activeVesselWatchIds,
  hasActiveSatelliteScouts,
  upsertPositions,
} from "./sampler.ts";
import { refreshGpCache } from "./gp.ts";
import {
  sampleVesselApiPositions,
  VesselApiRequestError,
} from "./vesselapi.ts";

const InputSchema = z.object({
  task: z.enum(["ais", "gp"]).default("ais"),
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

async function runVesselApiSampler(
  svc: SupabaseClient,
): Promise<SamplerOutcome> {
  const watchIds = await activeVesselWatchIds(svc);
  if (watchIds.length === 0) {
    logEvent({
      level: "info",
      fn: "transport-sampler",
      event: "vesselapi_noop",
      msg: "no active vessel watch IDs",
    });
    return {
      status: "noop",
      errorCode: "no_active_vessel_scouts",
      metadata: { provider: "vesselapi" },
    };
  }
  const apiKey = Deno.env.get("VESSELAPI_API_KEY")?.trim();
  if (!apiKey) {
    throw new SamplerFailure(
      "vesselapi_api_key_missing",
      "VESSELAPI_API_KEY not configured",
      { metadata: { provider: "vesselapi" } },
    );
  }

  let sample;
  try {
    sample = await sampleVesselApiPositions({ apiKey, watchIds });
  } catch (error) {
    const code = error instanceof VesselApiRequestError
      ? error.code
      : "vesselapi_unhandled_error";
    throw new SamplerFailure(
      code,
      error instanceof Error ? error.message : String(error),
      {
        connected: false,
        providerErrored: true,
        metadata: {
          provider: "vesselapi",
          requested_watch_count: watchIds.length,
        },
      },
    );
  }

  let written: number;
  try {
    written = await upsertPositions(svc, sample.positions);
  } catch (error) {
    throw new SamplerFailure(
      "vesselapi_upsert_failed",
      error instanceof Error ? error.message : String(error),
      {
        connected: true,
        providerErrored: false,
        framesReceived: sample.rowsReceived,
        itemsParsed: sample.positions.length,
        metadata: {
          provider: "vesselapi",
          requested_watch_count: sample.requestedCount,
          missing_watch_count: sample.missingIds.length,
        },
      },
    );
  }

  logEvent({
    level: sample.missingIds.length > 0 ? "warn" : "info",
    fn: "transport-sampler",
    event: "vesselapi_sample",
    msg:
      `${sample.requestedCount} watched, ${sample.rowsReceived} rows, ${written} positions, ${sample.missingIds.length} missing`,
    provider: "vesselapi",
    requested_watch_count: sample.requestedCount,
    missing_watch_count: sample.missingIds.length,
    quota_remaining: sample.quotaRemaining,
    latency_ms: sample.latencyMs,
  });
  return {
    status: "succeeded",
    connected: true,
    providerErrored: false,
    framesReceived: sample.rowsReceived,
    itemsParsed: sample.positions.length,
    itemsWritten: written,
    metadata: {
      provider: "vesselapi",
      requested_watch_count: sample.requestedCount,
      missing_watch_count: sample.missingIds.length,
      response_has_more: sample.hasMore,
      quota_remaining: sample.quotaRemaining,
      provider_latency_ms: sample.latencyMs,
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
      // Empty body is fine — defaults to the vessel-position task.
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
    const samplerRunId = crypto.randomUUID();
    const { error: insertError } = await svc
      .from("transport_sampler_runs")
      .insert({
        id: samplerRunId,
        task: parsed.data.task,
        status: "accepted",
        requested_window_ms: null,
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

    // 202 + background: provider work outlives the pg_net request.
    runInBackground(
      trackSamplerRun(
        svc,
        samplerRunId,
        "ais",
        () => runVesselApiSampler(svc),
      ),
    );
    return jsonOk(
      { status: "accepted", task: "ais", run_id: samplerRunId },
      202,
    );
  })();
});
