/**
 * scout-dispatch-drain — claim and launch scrape-heavy scout runs.
 *
 * A database lease owns global concurrency. This function may be invoked by
 * overlapping pg_cron requests without exceeding SCOUT_DISPATCH_CONCURRENCY.
 */

import { handleCors } from "../_shared/cors.ts";
import {
  internalServiceAuthHeaders,
  requireServiceKey,
} from "../_shared/auth.ts";
import { getServiceClient, type SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { AuthError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { resolveScoutDispatchConfig } from "../_shared/scout_dispatch_config.ts";
import { drainScoutDispatchInWaves } from "../_shared/scout_dispatch_drain.ts";

declare const EdgeRuntime:
  | { waitUntil(promise: Promise<unknown>): void }
  | undefined;

const WORKERS: Record<string, string> = {
  web: "scout-web-execute",
  beat: "scout-beat-execute",
  civic: "civic-execute",
};

interface DispatchClaim {
  queue_id: string;
  run_id: string;
  scout_id: string;
  user_id: string;
  scout_type: string;
  source: string;
  attempt: number;
}

export interface ScoutDispatchHandlerDependencies {
  getServiceClient?: () => SupabaseClient;
  fetch?: typeof fetch;
  logEvent?: typeof logEvent;
  randomUUID?: () => string;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Construct the production handler with narrow dependency seams for the
 * local-only runtime integration test. Production callers use the defaults.
 */
export function createScoutDispatchHandler(
  dependencies: ScoutDispatchHandlerDependencies = {},
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const logger = dependencies.logEvent ?? logEvent;
    const cors = handleCors(req);
    if (cors) return cors;

    if (req.method !== "POST") {
      return jsonError("method not allowed", 405);
    }

    try {
      requireServiceKey(req);
    } catch (error) {
      return jsonFromError(
        error instanceof AuthError ? error : new AuthError(),
      );
    }

    const {
      concurrency: capacity,
      maxLaunchesPerDrain,
      leaseSeconds,
      maxAttempts,
    } = resolveScoutDispatchConfig();
    const workerId = dependencies.randomUUID?.() ?? crypto.randomUUID();
    const svc = dependencies.getServiceClient?.() ?? getServiceClient();

    let claims: DispatchClaim[];
    try {
      claims = await claimDispatchBatch(
        svc,
        workerId,
        capacity,
        Math.min(capacity, maxLaunchesPerDrain),
        leaseSeconds,
        maxAttempts,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger({
        level: "error",
        fn: "scout-dispatch-drain",
        event: "claim_failed",
        msg: message,
      });
      return jsonFromError(new Error(message));
    }

    if (claims.length === 0) {
      return jsonOk({
        status: "idle",
        claimed: 0,
        capacity,
        max_launches_per_drain: maxLaunchesPerDrain,
      });
    }

    const work = drainScoutDispatchInWaves({
      initialClaims: claims,
      capacity,
      maxLaunches: maxLaunchesPerDrain,
      claimNext: (limit) =>
        claimDispatchBatch(
          svc,
          workerId,
          capacity,
          limit,
          leaseSeconds,
          maxAttempts,
        ),
      dispatch: (claim) =>
        dispatchClaim(
          svc,
          workerId,
          claim,
          dependencies.fetch ?? globalThis.fetch,
          logger,
        ),
    }).then((result) => {
      logger({
        level: result.dispatchRejections === 0 ? "info" : "error",
        fn: "scout-dispatch-drain",
        event: "drain_completed",
        worker_id: workerId,
        launched: result.launched,
        waves: result.waves,
        dispatch_rejections: result.dispatchRejections,
        ceiling_reached: result.ceilingReached,
        capacity,
        max_launches_per_drain: maxLaunchesPerDrain,
      });
    }).catch((error) => {
      logger({
        level: "error",
        fn: "scout-dispatch-drain",
        event: "drain_failed",
        worker_id: workerId,
        msg: error instanceof Error ? error.message : String(error),
      });
    });

    if (dependencies.waitUntil) {
      dependencies.waitUntil(work);
    } else if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(work);
    } else {
      // Keeps local/self-hosted runtimes correct when waitUntil is unavailable.
      await work;
    }

    logger({
      level: "info",
      fn: "scout-dispatch-drain",
      event: "batch_claimed",
      worker_id: workerId,
      claimed: claims.length,
      capacity,
      max_launches_per_drain: maxLaunchesPerDrain,
      run_ids: claims.map((claim) => claim.run_id),
    });

    return jsonOk({
      status: "accepted",
      claimed: claims.length,
      capacity,
      max_launches_per_drain: maxLaunchesPerDrain,
      run_ids: claims.map((claim) => claim.run_id),
    }, 202);
  };
}

async function claimDispatchBatch(
  svc: SupabaseClient,
  workerId: string,
  capacity: number,
  limit: number,
  leaseSeconds: number,
  maxAttempts: number,
): Promise<DispatchClaim[]> {
  const { data, error } = await svc.rpc("claim_scout_dispatch_batch", {
    p_worker_id: workerId,
    p_capacity: capacity,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
    p_max_attempts: maxAttempts,
  });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as DispatchClaim[];
}

async function dispatchClaim(
  svc: SupabaseClient,
  workerId: string,
  claim: DispatchClaim,
  fetcher: typeof fetch,
  logger: typeof logEvent,
): Promise<void> {
  const worker = WORKERS[claim.scout_type];
  if (!worker) {
    await finishDispatch(svc, workerId, claim, false, {
      code: "unknown_scout_type",
      message: `no worker configured for scout type ${claim.scout_type}`,
    }, logger);
    return;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    await finishDispatch(svc, workerId, claim, false, {
      code: "dispatch_configuration_error",
      message: "SUPABASE_URL not configured",
    }, logger);
    return;
  }

  logger({
    level: "info",
    fn: "scout-dispatch-drain",
    event: "dispatching",
    queue_id: claim.queue_id,
    run_id: claim.run_id,
    scout_id: claim.scout_id,
    scout_type: claim.scout_type,
    source: claim.source,
    attempt: claim.attempt,
    worker,
  });

  try {
    const response = await fetcher(`${supabaseUrl}/functions/v1/${worker}`, {
      method: "POST",
      headers: {
        ...internalServiceAuthHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scout_id: claim.scout_id,
        run_id: claim.run_id,
        user_id: claim.user_id,
      }),
    });

    if (!response.ok) {
      const detail = await safeText(response);
      await finishDispatch(svc, workerId, claim, false, {
        code: `worker_http_${response.status}`,
        message: `worker ${worker} responded ${response.status}: ${
          detail.slice(0, 1500)
        }`,
      }, logger);
      return;
    }

    await response.body?.cancel();
    if (response.status === 202) {
      await parkDispatch(svc, workerId, claim, logger);
    } else {
      await finishDispatch(svc, workerId, claim, true, undefined, logger);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishDispatch(svc, workerId, claim, false, {
      code: "dispatch_network_error",
      message: `dispatch to ${worker} failed: ${message.slice(0, 1500)}`,
    }, logger);
    await svc.rpc("increment_scout_failures", {
      p_scout_id: claim.scout_id,
    });
  }
}

async function parkDispatch(
  svc: SupabaseClient,
  workerId: string,
  claim: DispatchClaim,
  logger: typeof logEvent,
): Promise<void> {
  const { data, error } = await svc.rpc("park_scout_dispatch", {
    p_queue_id: claim.queue_id,
    p_worker_id: workerId,
  });
  if (error || data !== true) {
    logger({
      level: "error",
      fn: "scout-dispatch-drain",
      event: "park_failed",
      queue_id: claim.queue_id,
      run_id: claim.run_id,
      msg: error?.message ?? "lease no longer owned by this worker",
    });
    return;
  }
  logger({
    level: "info",
    fn: "scout-dispatch-drain",
    event: "worker_waiting",
    queue_id: claim.queue_id,
    run_id: claim.run_id,
    scout_id: claim.scout_id,
  });
}

async function finishDispatch(
  svc: SupabaseClient,
  workerId: string,
  claim: DispatchClaim,
  success: boolean,
  error?: { code: string; message: string },
  logger: typeof logEvent = logEvent,
): Promise<void> {
  const { data, error: finishError } = await svc.rpc("finish_scout_dispatch", {
    p_queue_id: claim.queue_id,
    p_worker_id: workerId,
    p_success: success,
    p_error_code: error?.code ?? null,
    p_error_message: error?.message ?? null,
  });

  if (finishError || data !== true) {
    logger({
      level: "error",
      fn: "scout-dispatch-drain",
      event: "finish_failed",
      queue_id: claim.queue_id,
      run_id: claim.run_id,
      msg: finishError?.message ?? "lease no longer owned by this worker",
    });
    return;
  }

  logger({
    level: success ? "info" : "error",
    fn: "scout-dispatch-drain",
    event: success ? "worker_completed" : "worker_failed",
    queue_id: claim.queue_id,
    run_id: claim.run_id,
    scout_id: claim.scout_id,
    error_code: error?.code,
    msg: error?.message,
  });
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
