/**
 * social-execute Edge Function: queued Social Scout worker.
 *
 * Called by scout-dispatch-drain with a run_id from the dispatch queue. Answers
 * 202 at once and finishes under EdgeRuntime.waitUntil (the same pattern as
 * scout-beat-execute); the drain parks the 202 as `waiting` and
 * reconcile_waiting_scout_dispatches closes the run if this worker dies.
 * Without EdgeRuntime (self-host, `deno test`) it runs inline and answers
 * with the result.
 *
 * Auth: shared service auth.
 * Body: { scout_id: uuid, run_id: uuid, user_id?: uuid }  (run_id required)
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient, type SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { AuthError, ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { classifyRunError, markRunError } from "../_shared/run_lifecycle.ts";
import { processSocialRun } from "../_shared/social_run.ts";

declare const EdgeRuntime:
  | { waitUntil(promise: Promise<unknown>): void }
  | undefined;

const InputSchema = z.object({
  scout_id: z.string().uuid(),
  run_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
});

const TERMINAL_RUN_STATUSES = new Set(["success", "error", "skipped"]);

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return jsonError("method not allowed", 405);

  try {
    requireServiceKey(req);
  } catch (e) {
    return jsonFromError(e instanceof AuthError ? e : new AuthError());
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonFromError(new ValidationError("invalid JSON body"));
  }
  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonFromError(
      new ValidationError(parsed.error.issues.map((i) => i.message).join("; ")),
    );
  }
  const { scout_id, run_id } = parsed.data;
  const svc = getServiceClient();

  const background = typeof EdgeRuntime !== "undefined" &&
    EdgeRuntime?.waitUntil;
  if (background) {
    EdgeRuntime!.waitUntil(executeInBackground(svc, scout_id, run_id));
    return jsonOk({ status: "accepted", run_id }, 202);
  }
  try {
    const outcome = await processSocialRun(svc, {
      scoutId: scout_id,
      runId: run_id,
    });
    if (outcome.status === "claim_failed") {
      // Not claimed: let the drain count a failed attempt and retry.
      return jsonError(outcome.message, 503, "claim_failed");
    }
    return jsonOk({ status: outcome.status, run_id, outcome });
  } catch (e) {
    await closeRunIfOpen(svc, run_id, e);
    return jsonFromError(e);
  }
});

/**
 * processSocialRun records its own failures and refunds a charge before it
 * marks the run. A throw that still escapes it came after the claim and is
 * either database trouble loading the scout, or `markRunError` failing inside
 * its failure handler (the refund was already issued by then). Either way
 * this invocation owns the run, so closeRunIfOpen retries the marking. A run
 * this invocation never claimed is never closed here (processSocialRun
 * returns `claim_failed` instead of throwing).
 */
async function executeInBackground(
  svc: SupabaseClient,
  scoutId: string,
  runId: string,
): Promise<void> {
  try {
    await processSocialRun(svc, { scoutId, runId });
  } catch (e) {
    await closeRunIfOpen(svc, runId, e);
  }
}

async function closeRunIfOpen(
  svc: SupabaseClient,
  runId: string,
  error: unknown,
): Promise<void> {
  logEvent({
    level: "error",
    fn: "social-execute",
    event: "unhandled",
    run_id: runId,
    msg: error instanceof Error ? error.message : String(error),
  });
  const { data } = await svc
    .from("scout_runs")
    .select("status")
    .eq("id", runId)
    .maybeSingle();
  if (data && !TERMINAL_RUN_STATUSES.has(String(data.status))) {
    const classified = classifyRunError(error, "dispatch");
    await markRunError(svc, runId, {
      stage: classified.stage,
      errorClass: classified.errorClass,
      message: classified.message,
    });
  }
}
