/**
 * scout-transport-execute Edge Function — transport scout worker.
 *
 * Called internally by execute-scout for scouts of type `transport`. Flow:
 *   1. Load scout (incl. config JSONB).
 *   2. Overlap guard: a fresh `running` row for this scout skips the run so
 *      concurrent dispatches (cron + Run Now) cannot double-alert.
 *   3. Create (or reuse) a scout_runs row, status='running', 30-day TTL.
 *   4. Non-billable pre-checks: config parse/validation.
 *   5. Charge credits, then execute the mode pipeline.
 *   6. On any throw after charging: refund + markRunError + failure counter.
 *
 * U1 scaffolding: no mode executor is implemented yet (aircraft lands in U2,
 * vessel in U3, satellite in U4), so step 5 completes the run as an unbilled
 * `skipped` with an explanatory message. The lifecycle around it — dispatch,
 * overlap guard, validation, charge/refund seams — is real and tested.
 *
 * Auth: shared service auth (X-Service-Key / service-role bearer).
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import {
  AuthError,
  NotFoundError,
  ValidationError,
} from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { markRunError, markRunStage } from "../_shared/run_lifecycle.ts";
import {
  IMPLEMENTED_MODES,
  overlapCutoffIso,
  precheckTransportScout,
  shouldYieldToPeer,
  transportRunExpiresAt,
} from "./lib.ts";

const InputSchema = z.object({
  scout_id: z.string().uuid(),
  run_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

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

  const svc = getServiceClient();
  const { scout_id } = parsed.data;
  let { run_id } = parsed.data;

  // 1. Load scout.
  const { data: scout, error: scoutErr } = await svc
    .from("scouts")
    .select("id, user_id, type, name, config, is_active")
    .eq("id", scout_id)
    .maybeSingle();
  if (scoutErr) return jsonFromError(new Error(scoutErr.message));
  if (!scout) return jsonFromError(new NotFoundError("scout"));
  if (scout.type !== "transport") {
    return jsonFromError(
      new ValidationError(`scout ${scout_id} is not a transport scout`),
    );
  }

  // 2. Ensure OUR scout_runs row exists first (30-day TTL — sub-daily
  // volume). Rows pre-created by trigger_scout_run (Run Now) get their
  // expires_at tightened to the transport TTL here.
  let ourStartedAt: string;
  if (!run_id) {
    const { data: runRow, error: runErr } = await svc
      .from("scout_runs")
      .insert({
        scout_id: scout.id,
        user_id: scout.user_id,
        status: "running",
        started_at: new Date().toISOString(),
        expires_at: transportRunExpiresAt(),
      })
      .select("id, started_at")
      .single();
    if (runErr) return jsonFromError(new Error(runErr.message));
    run_id = runRow.id as string;
    ourStartedAt = runRow.started_at as string;
  } else {
    const { data: runRow, error: runErr } = await svc
      .from("scout_runs")
      .update({ expires_at: transportRunExpiresAt() })
      .eq("id", run_id)
      .select("id, started_at")
      .single();
    if (runErr) return jsonFromError(new Error(runErr.message));
    ourStartedAt = runRow.started_at as string;
  }
  const runId = run_id as string;

  // 3. Overlap election — every dispatcher owns a running row by now; only
  // the oldest row within the grace window proceeds (deterministic tiebreak
  // in shouldYieldToPeer), so concurrent dispatches can neither double-run
  // nor mutually skip. Losers mark their own run skipped, unbilled.
  const { data: runningRows, error: runningErr } = await svc
    .from("scout_runs")
    .select("id, started_at")
    .eq("scout_id", scout.id)
    .eq("status", "running")
    .gte("started_at", overlapCutoffIso());
  if (runningErr) return jsonFromError(new Error(runningErr.message));
  const peers = (runningRows ?? []) as { id: string; started_at: string }[];
  if (shouldYieldToPeer({ id: runId, started_at: ourStartedAt }, peers)) {
    logEvent({
      level: "info",
      fn: "scout-transport-execute",
      event: "overlap_skip",
      scout_id: scout.id,
      run_id: runId,
      msg: "yielding to an older concurrent run of this scout",
    });
    await markRunError(svc, runId, {
      stage: "dispatch",
      errorClass: "validation",
      message: "skipped: another run of this scout is still in flight",
      status: "skipped",
    });
    return jsonOk({ status: "skipped", reason: "overlapping_run" });
  }
  await markRunStage(svc, runId, "dispatch");

  // 4. Non-billable pre-checks. A misconfigured scout must never charge.
  const precheck = precheckTransportScout(scout.config);
  if (!precheck.ok) {
    await markRunError(svc, runId, {
      stage: "dispatch",
      errorClass: "validation",
      message: precheck.error ?? "invalid transport config",
    });
    return jsonFromError(
      new ValidationError(precheck.error ?? "invalid config"),
    );
  }

  // 5. Mode dispatch. Executors land in U2 (aircraft), U3 (vessel),
  // U4 (satellite). Until then: unbilled skip, visible in run history.
  if (!IMPLEMENTED_MODES.has(precheck.mode!)) {
    const message =
      `transport ${precheck.mode} execution is not yet enabled on this deployment`;
    await markRunError(svc, runId, {
      stage: "dispatch",
      errorClass: "validation",
      message,
      status: "skipped",
    });
    logEvent({
      level: "info",
      fn: "scout-transport-execute",
      event: "mode_not_enabled",
      scout_id: scout.id,
      run_id: runId,
      msg: message,
    });
    return jsonOk({ status: "skipped", reason: "mode_not_enabled" });
  }

  // Unreachable in U1 — kept as the seam where U2+ inserts:
  // credit charge (getTransportCost) → mode executor → state diff →
  // information_units + notification → markRunSuccess (+refund on throw).
  return jsonError("unreachable", 500);
});
