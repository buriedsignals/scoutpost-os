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

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  try {
    requireServiceKey(req);
  } catch (error) {
    return jsonFromError(error instanceof AuthError ? error : new AuthError());
  }

  const capacity = envInt("SCOUT_DISPATCH_CONCURRENCY", 3, 1, 20);
  const leaseSeconds = envInt("SCOUT_DISPATCH_LEASE_SECONDS", 900, 60, 3600);
  const maxAttempts = envInt("SCOUT_DISPATCH_MAX_ATTEMPTS", 3, 1, 10);
  const workerId = crypto.randomUUID();
  const svc = getServiceClient();

  const { data, error } = await svc.rpc("claim_scout_dispatch_batch", {
    p_worker_id: workerId,
    p_capacity: capacity,
    p_limit: capacity,
    p_lease_seconds: leaseSeconds,
    p_max_attempts: maxAttempts,
  });
  if (error) {
    logEvent({
      level: "error",
      fn: "scout-dispatch-drain",
      event: "claim_failed",
      msg: error.message,
    });
    return jsonFromError(new Error(error.message));
  }

  const claims = (Array.isArray(data) ? data : []) as DispatchClaim[];
  if (claims.length === 0) {
    return jsonOk({ status: "idle", claimed: 0, capacity });
  }

  const work = Promise.allSettled(
    claims.map((claim) => dispatchClaim(svc, workerId, claim)),
  ).then(() => undefined);

  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(work);
  } else {
    // Keeps local/self-hosted runtimes correct when waitUntil is unavailable.
    await work;
  }

  logEvent({
    level: "info",
    fn: "scout-dispatch-drain",
    event: "batch_claimed",
    worker_id: workerId,
    claimed: claims.length,
    capacity,
    run_ids: claims.map((claim) => claim.run_id),
  });

  return jsonOk({
    status: "accepted",
    claimed: claims.length,
    capacity,
    run_ids: claims.map((claim) => claim.run_id),
  }, 202);
});

async function dispatchClaim(
  svc: SupabaseClient,
  workerId: string,
  claim: DispatchClaim,
): Promise<void> {
  const worker = WORKERS[claim.scout_type];
  if (!worker) {
    await finishDispatch(svc, workerId, claim, false, {
      code: "unknown_scout_type",
      message: `no worker configured for scout type ${claim.scout_type}`,
    });
    return;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    await finishDispatch(svc, workerId, claim, false, {
      code: "dispatch_configuration_error",
      message: "SUPABASE_URL not configured",
    });
    return;
  }

  logEvent({
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
    const response = await fetch(`${supabaseUrl}/functions/v1/${worker}`, {
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
      });
      return;
    }

    await response.body?.cancel();
    await finishDispatch(svc, workerId, claim, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishDispatch(svc, workerId, claim, false, {
      code: "dispatch_network_error",
      message: `dispatch to ${worker} failed: ${message.slice(0, 1500)}`,
    });
    await svc.rpc("increment_scout_failures", {
      p_scout_id: claim.scout_id,
    });
  }
}

async function finishDispatch(
  svc: SupabaseClient,
  workerId: string,
  claim: DispatchClaim,
  success: boolean,
  error?: { code: string; message: string },
): Promise<void> {
  const { data, error: finishError } = await svc.rpc("finish_scout_dispatch", {
    p_queue_id: claim.queue_id,
    p_worker_id: workerId,
    p_success: success,
    p_error_code: error?.code ?? null,
    p_error_message: error?.message ?? null,
  });

  if (finishError || data !== true) {
    logEvent({
      level: "error",
      fn: "scout-dispatch-drain",
      event: "finish_failed",
      queue_id: claim.queue_id,
      run_id: claim.run_id,
      msg: finishError?.message ?? "lease no longer owned by this worker",
    });
    return;
  }

  logEvent({
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

function envInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Deno.env.get(name);
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
