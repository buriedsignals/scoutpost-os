/**
 * execute-scout Edge Function — scout run dispatcher.
 *
 * Triggered by pg_cron (via pg_net.http_post using X-Service-Key) or by
 * the authenticated frontend through `trigger_scout_run`. The dispatcher
 * resolves the scout's type and forwards the request to the type-specific
 * worker Edge Function over HTTP (fire-and-forget with a short timeout).
 *
 * Auth: either a valid user JWT (requireUser) OR shared service auth
 *       (X-Service-Key, with service-role bearer fallback for tooling).
 *
 * Body: { scout_id: uuid, run_id?: uuid, user_id?: uuid }
 *
 * Dispatch table:
 *   web    -> POST /functions/v1/scout-web-execute
 *   beat  -> POST /functions/v1/scout-beat-execute
 *   civic  -> POST /functions/v1/civic-execute
 *   social -> POST /functions/v1/social-kickoff
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import {
  internalServiceAuthHeaders,
  requireServiceKey,
  requireUser,
} from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import {
  AuthError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";

const DispatchSchema = z.object({
  scout_id: z.string().uuid(),
  run_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

const WORKERS: Record<string, string> = {
  web: "scout-web-execute",
  beat: "scout-beat-execute",
  civic: "civic-execute",
  social: "social-kickoff",
  transport: "scout-transport-execute",
};

const WORKER_TIMEOUT_MS = 5_000;

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  // Accept either service auth (pg_cron / dispatcher) OR a valid user JWT
  // (frontend-initiated run via trigger_scout_run).
  let isServiceCaller = false;
  let callerId = "service";
  let callerUserId: string | null = null;
  try {
    requireServiceKey(req);
    isServiceCaller = true;
  } catch {
    try {
      const user = await requireUser(req);
      callerId = user.id;
      callerUserId = user.id;
    } catch (e) {
      return jsonFromError(e instanceof AuthError ? e : new AuthError());
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonFromError(new ValidationError("invalid JSON body"));
  }

  const parsed = DispatchSchema.safeParse(body);
  if (!parsed.success) {
    return jsonFromError(
      new ValidationError(parsed.error.issues.map((i) => i.message).join("; ")),
    );
  }
  const { scout_id, run_id, user_id } = parsed.data;

  const svc = getServiceClient();

  try {
    const { data: scout, error: scoutErr } = await svc
      .from("scouts")
      .select("id, type, is_active, user_id")
      .eq("id", scout_id)
      .maybeSingle();
    if (scoutErr) throw new Error(scoutErr.message);
    if (!scout) throw new NotFoundError("scout");
    if (!isServiceCaller && scout.user_id !== callerUserId) {
      throw new NotFoundError("scout");
    }
    if (scout.is_active === false) {
      throw new ConflictError("scout is paused");
    }

    const worker = WORKERS[scout.type as string];
    if (!worker) {
      throw new ValidationError(`unknown scout type: ${scout.type}`);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!supabaseUrl) throw new Error("SUPABASE_URL not configured");
    const serviceHeaders = internalServiceAuthHeaders();

    const workerUrl = `${supabaseUrl}/functions/v1/${worker}`;
    const forwardBody = JSON.stringify({
      scout_id,
      run_id,
      user_id: user_id ?? scout.user_id,
    });

    logEvent({
      level: "info",
      fn: "execute-scout",
      event: "dispatching",
      scout_id,
      run_id,
      scout_type: scout.type,
      worker,
      caller: callerId,
    });

    // Fire-and-forget with a short timeout. If the worker takes longer than
    // WORKER_TIMEOUT_MS we return 202 anyway — the worker keeps running server
    // side. Deno doesn't expose ctx.waitUntil, so we do a bounded await.
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), WORKER_TIMEOUT_MS);
      let workerRes: Response | null = null;
      try {
        workerRes = await fetch(workerUrl, {
          method: "POST",
          headers: {
            ...serviceHeaders,
            "Content-Type": "application/json",
          },
          body: forwardBody,
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (workerRes && !workerRes.ok) {
        const detail = await safeText(workerRes);
        const isInsufficientCredits = workerRes.status === 402;
        logEvent({
          level: "error",
          fn: "execute-scout",
          event: "worker_failed",
          scout_id,
          status: workerRes.status,
          msg: detail.slice(0, 500),
        });
        await markRunTerminal(
          svc,
          run_id,
          isInsufficientCredits ? "skipped" : "error",
          `worker ${worker} responded ${workerRes.status}: ${
            detail.slice(0, 2000)
          }`,
        );
        // Do NOT increment consecutive_failures here. The worker ran and owns
        // its own failure accounting: it calls increment_scout_failures via its
        // transient-error classification (shouldIncrementScoutFailure) before
        // returning non-2xx. Incrementing again double-counts one failed run and
        // wrongly counts non-transient errors the worker deliberately skips. The
        // dispatcher only counts dispatch_error, where the worker never ran.
        if (isInsufficientCredits) {
          return new Response(detail, {
            status: 402,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "application/json",
            },
          });
        }
        return jsonError(
          `worker ${worker} responded ${workerRes.status}: ${
            detail.slice(0, 500)
          }`,
          502,
          "worker_failed",
        );
      }

      // workerRes is null only if the fetch threw (caught below); if it's
      // OK, drain the body so the connection can be reused.
      if (workerRes) await workerRes.body?.cancel();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // AbortError => took longer than WORKER_TIMEOUT_MS: treat as dispatched.
      const isTimeout = e instanceof DOMException && e.name === "AbortError";
      if (!isTimeout) {
        logEvent({
          level: "error",
          fn: "execute-scout",
          event: "dispatch_error",
          scout_id,
          msg,
        });
        await markRunTerminal(
          svc,
          run_id,
          "error",
          `dispatch to ${worker} failed: ${msg.slice(0, 2000)}`,
        );
        await svc.rpc("increment_scout_failures", { p_scout_id: scout_id });
        return jsonError(
          `dispatch to ${worker} failed: ${msg}`,
          502,
          "dispatch_error",
        );
      }
      logEvent({
        level: "info",
        fn: "execute-scout",
        event: "worker_timeout_ok",
        scout_id,
        msg: "worker still running; returning 202",
      });
    }

    return jsonOk({ dispatched: scout.type, scout_id, run_id }, 202);
  } catch (e) {
    await markRunTerminal(
      svc,
      run_id,
      "error",
      (e instanceof Error ? e.message : String(e)).slice(0, 2000),
    );
    logEvent({
      level: "error",
      fn: "execute-scout",
      event: "unhandled",
      scout_id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function markRunTerminal(
  svc: ReturnType<typeof getServiceClient>,
  runId: string | undefined,
  status: "error" | "skipped",
  errorMessage: string,
): Promise<void> {
  if (!runId) return;
  const { error } = await svc
    .from("scout_runs")
    .update({
      status,
      error_message: errorMessage.slice(0, 2000),
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) {
    logEvent({
      level: "error",
      fn: "execute-scout",
      event: "mark_run_terminal_failed",
      run_id: runId,
      msg: error.message,
    });
  }
}
