/**
 * apify-reconcile Edge Function — pg_cron-invoked (every 10 min).
 *
 * Finds apify_run_queue rows still in 'running' status with started_at > 1h
 * ago, polls Apify for the actual run status, and either synthesizes an
 * internal apify-callback POST (for succeeded runs) or marks the queue row as
 * failed/timeout. The SQL-side `apify_mark_timeouts` trigger handles the case
 * where APIFY_API_TOKEN is missing — this function is a best-effort.
 *
 * Route:
 *   POST /apify-reconcile
 *     body: {}
 *     -> 200 { reconciled: N }
 *
 * Auth: shared service auth (X-Service-Key from cron, with service-role bearer
 *       fallback for operator tooling).
 */

import { handleCors } from "../_shared/cors.ts";
import {
  internalServiceAuthHeaders,
  requireServiceKey,
} from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { AuthError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import {
  getSocialMonitoringCost,
  refundCredits,
  SOCIAL_MONITORING_KEYS,
} from "../_shared/credits.ts";

const LIMIT = 20;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;

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

  const apifyToken = Deno.env.get("APIFY_API_TOKEN") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceHeaders = internalServiceAuthHeaders();
  const svc = getServiceClient();

  try {
    const oneHourAgo = new Date(Date.now() - ONE_HOUR_MS).toISOString();
    const { data: rows, error } = await svc
      .from("apify_run_queue")
      .select(
        "id, user_id, scout_id, scout_run_id, platform, apify_run_id, started_at, status",
      )
      .eq("status", "running")
      .lt("started_at", oneHourAgo)
      .limit(LIMIT);
    if (error) throw new Error(error.message);

    const candidates = rows ?? [];
    if (!apifyToken) {
      // Without APIFY_API_TOKEN we can't poll; the SQL failsafe
      // apify_mark_timeouts() handles the eventual timeout. Log + no-op.
      logEvent({
        level: "info",
        fn: "apify-reconcile",
        event: "no_token_skipped",
        candidates: candidates.length,
      });
      return jsonOk({ reconciled: 0 });
    }

    let reconciled = 0;
    for (const row of candidates) {
      if (!row.apify_run_id) continue;
      try {
        const processed = await reconcileRow(
          svc,
          row,
          apifyToken,
          supabaseUrl,
          serviceHeaders,
        );
        if (processed) reconciled += 1;
      } catch (e) {
        logEvent({
          level: "warn",
          fn: "apify-reconcile",
          event: "row_failed",
          queue_id: row.id,
          apify_run_id: row.apify_run_id,
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logEvent({
      level: "info",
      fn: "apify-reconcile",
      event: "done",
      candidates: candidates.length,
      reconciled,
    });
    return jsonOk({ reconciled });
  } catch (e) {
    logEvent({
      level: "error",
      fn: "apify-reconcile",
      event: "unhandled",
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

interface QueueRow {
  id: string;
  user_id: string;
  scout_id: string;
  scout_run_id: string | null;
  platform: string | null;
  apify_run_id: string | null;
  started_at: string | null;
  status: string;
}

async function reconcileRow(
  svc: ReturnType<typeof getServiceClient>,
  row: QueueRow,
  apifyToken: string,
  supabaseUrl: string,
  serviceHeaders: Record<string, string>,
): Promise<boolean> {
  const apifyRunId = row.apify_run_id as string;
  const res = await fetch(
    `https://api.apify.com/v2/actor-runs/${apifyRunId}?token=${apifyToken}`,
  );
  if (!res.ok) {
    throw new Error(`apify poll failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const runData = body?.data ?? {};
  const actualStatus = String(runData.status ?? "").toUpperCase();
  const defaultDatasetId = typeof runData.defaultDatasetId === "string"
    ? runData.defaultDatasetId
    : null;

  if (actualStatus === "SUCCEEDED") {
    // Synthesize a callback. Let apify-callback own the DB transition.
    if (!supabaseUrl) {
      throw new Error("SUPABASE_URL not configured");
    }
    const cbUrl = `${supabaseUrl}/functions/v1/apify-callback`;
    const payload = {
      eventType: "ACTOR.RUN.SUCCEEDED",
      resource: {
        id: apifyRunId,
        actorId: runData.actId ?? null,
        status: "SUCCEEDED",
        defaultDatasetId,
        startedAt: runData.startedAt ?? null,
        finishedAt: runData.finishedAt ?? null,
      },
    };
    const cbRes = await fetch(cbUrl, {
      method: "POST",
      headers: {
        ...serviceHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    await cbRes.body?.cancel();
    if (!cbRes.ok) {
      throw new Error(`synth callback failed: ${cbRes.status}`);
    }
    logEvent({
      level: "info",
      fn: "apify-reconcile",
      event: "synth_callback_succeeded",
      queue_id: row.id,
      apify_run_id: apifyRunId,
    });
    return true;
  }

  if (
    actualStatus === "FAILED" ||
    actualStatus === "TIMED-OUT" ||
    actualStatus === "TIMED_OUT" ||
    actualStatus === "ABORTED"
  ) {
    const newStatus =
      actualStatus === "TIMED-OUT" || actualStatus === "TIMED_OUT"
        ? "timeout"
        : "failed";
    await markTerminal(svc, row, newStatus, actualStatus);
    logEvent({
      level: "info",
      fn: "apify-reconcile",
      event: "marked_terminal",
      queue_id: row.id,
      apify_run_id: apifyRunId,
      status: newStatus,
    });
    return true;
  }

  // Still running upstream: escalate to timeout only if > 4h old.
  if (actualStatus === "RUNNING" || actualStatus === "READY") {
    const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
    if (!isNaN(startedMs) && Date.now() - startedMs > FOUR_HOURS_MS) {
      await markTerminal(
        svc,
        row,
        "timeout",
        "exceeded 4h while apify still RUNNING",
      );
      logEvent({
        level: "warn",
        fn: "apify-reconcile",
        event: "escalated_timeout",
        queue_id: row.id,
        apify_run_id: apifyRunId,
      });
      return true;
    }
    return false;
  }

  // Unknown status — leave alone, log.
  logEvent({
    level: "warn",
    fn: "apify-reconcile",
    event: "unknown_apify_status",
    queue_id: row.id,
    apify_run_id: apifyRunId,
    status: actualStatus,
  });
  return false;
}

async function markTerminal(
  svc: ReturnType<typeof getServiceClient>,
  row: QueueRow,
  status: "failed" | "timeout",
  detail: string,
): Promise<void> {
  const completedAt = new Date().toISOString();
  const { error } = await svc
    .from("apify_run_queue")
    .update({
      status,
      last_error: detail,
      completed_at: completedAt,
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);

  if (row.scout_run_id) {
    const { error: runErr } = await svc
      .from("scout_runs")
      .update({
        status: "error",
        error_message: detail.slice(0, 2000),
        completed_at: completedAt,
      })
      .eq("id", row.scout_run_id);
    if (runErr) throw new Error(runErr.message);
  }

  if (row.platform) {
    const operation = SOCIAL_MONITORING_KEYS[row.platform] ??
      "social_monitoring_instagram";
    await refundCredits(svc, {
      userId: row.user_id,
      cost: getSocialMonitoringCost(row.platform),
      scoutId: row.scout_id,
      scoutType: "social",
      operation,
    });
  }
}
