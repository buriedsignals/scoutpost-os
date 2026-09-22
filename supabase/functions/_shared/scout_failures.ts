/**
 * Thin wrapper around the `increment_scout_failures` RPC that also sends a
 * one-time deactivation email when the scout crosses the threshold.
 *
 * The legacy AWS pipeline sent the email from scraper-lambda via
 * /scouts/failure-notification; v2 centralizes it here so every caller
 * (scout-web-execute, scout-beat-execute, civic-execute, execute-scout)
 * benefits from the same behaviour without duplicating the detection logic.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logEvent } from "./log.ts";
import { sendScoutDeactivated } from "./notifications.ts";
import type { RunErrorClass } from "./run_lifecycle.ts";

export interface ScoutFailureContext {
  scoutId: string;
  userId: string;
  scoutName: string;
  scoutType: string;
  language?: string | null;
  threshold?: number;
  /** A persisted internal run policy; failure accounting still occurs. */
  notificationMode?: "deliver" | "disabled";
}

export interface IncrementResult {
  consecutiveFailures: number;
  isActive: boolean;
  deactivated: boolean;
  notified: boolean;
}

/**
 * Call increment_scout_failures; if the scout flipped to inactive, send the
 * deactivation email (health_notifications_enabled opt-out is honoured in
 * notifications.ts). Never throws — failures are logged and swallowed so the
 * caller's own error-handling path keeps running.
 */
export async function incrementAndMaybeNotify(
  svc: SupabaseClient,
  ctx: ScoutFailureContext,
): Promise<IncrementResult> {
  const threshold = ctx.threshold ?? 3;
  const { data, error } = await svc.rpc("increment_scout_failures", {
    p_scout_id: ctx.scoutId,
    p_threshold: threshold,
  });
  if (error) {
    logEvent({
      level: "warn",
      fn: "scout-failures",
      event: "rpc_failed",
      scout_id: ctx.scoutId,
      msg: error.message,
    });
    return {
      consecutiveFailures: 0,
      isActive: true,
      deactivated: false,
      notified: false,
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const consecutiveFailures = Number(row?.consecutive_failures ?? 0);
  const isActive = row?.is_active !== false; // treat null as still active
  const deactivated = !isActive && consecutiveFailures >= threshold;

  if (!deactivated || ctx.notificationMode === "disabled") {
    return { consecutiveFailures, isActive, deactivated, notified: false };
  }

  let notified = false;
  try {
    notified = await sendScoutDeactivated(svc, {
      userId: ctx.userId,
      scoutId: ctx.scoutId,
      scoutName: ctx.scoutName,
      scoutType: ctx.scoutType,
      consecutiveFailures,
      language: ctx.language ?? null,
    });
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "scout-failures",
      event: "notify_failed",
      scout_id: ctx.scoutId,
      user_id: ctx.userId,
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  return { consecutiveFailures, isActive, deactivated, notified };
}

// ---------------------------------------------------------------------------
// Run failure accounting: one decision for every executor.
// ---------------------------------------------------------------------------

/** Only these error classes count toward the three-strike pause. */
export function shouldIncrementScoutFailure(
  errorClass: RunErrorClass,
): boolean {
  return errorClass === "provider" || errorClass === "timeout" ||
    errorClass === "unknown";
}

/** Retry lands outside the morning burst but inside the same working hour. */
export const DEFERRED_RETRY_DELAY_MS = 45 * 60_000;

/** Scout types whose runs go through scout_dispatch_queue. */
const QUEUE_BACKED_SCOUT_TYPES = new Set(["web", "beat", "civic"]);

/**
 * Run-level mirror of the crawler-level classifier
 * `crawler_retrieval_failure_category`: a provider that timed out, a page
 * that timed out, or a navigation that the target dropped. Unknown,
 * auth, quota and validation failures never defer.
 */
export function isDeferrableRetrievalFailure(
  errorClass: RunErrorClass,
  message: string | null | undefined,
): boolean {
  if (errorClass === "timeout") return true;
  if (errorClass !== "provider") return false;
  const text = message ?? "";
  return /SCRAPE_TIMEOUT|\b408\b|timed out|timeout|no longer waiting|net::ERR_(HTTP2_PROTOCOL_ERROR|HTTP_RESPONSE_CODE_FAILURE|EMPTY_RESPONSE|TIMED_OUT)/i
    .test(text);
}

export interface ScoutRunFailureContext extends ScoutFailureContext {
  /** The run that failed; without it nothing can be deferred. */
  runId?: string | null;
  errorClass: RunErrorClass;
  errorMessage?: string | null;
  /** Set false to record nothing (baseline-only Beat runs, Civic backfills). */
  countFailure?: boolean;
  /**
   * Pre-loaded run facts; when absent the helper reads
   * scout_runs.metadata.dispatch_source and crawler_backend itself.
   */
  dispatchSource?: string | null;
  crawlerBackend?: string | null;
  /** Test seam for the retry moment. */
  now?: () => number;
}

export type ScoutRunFailureOutcome =
  | { outcome: "ignored" }
  | { outcome: "deferred"; retryRunId: string | null; alreadyQueued: boolean }
  | { outcome: "counted"; increment: IncrementResult };

async function loadRunDispatchFacts(
  svc: SupabaseClient,
  runId: string,
): Promise<{ dispatchSource: string | null; crawlerBackend: string | null }> {
  const { data, error } = await svc.from("scout_runs")
    .select("metadata,crawler_backend")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const metadata = (data?.metadata ?? null) as Record<string, unknown> | null;
  const source = metadata?.dispatch_source;
  return {
    dispatchSource: typeof source === "string" ? source : null,
    crawlerBackend: typeof data?.crawler_backend === "string"
      ? data.crawler_backend
      : null,
  };
}

/**
 * Record a run failure the same way for every executor:
 *
 * - error classes outside the failure policy are ignored;
 * - a scheduled, queue-backed run that failed on a retrieval error gets one
 *   deferred retry and is NOT counted (the retry's own failure counts);
 * - everything else increments consecutive_failures and may pause the scout.
 *
 * Never throws: accounting problems fall back to counting, so a scout can
 * never dodge the failure policy because the retry queue was unavailable.
 */
export async function recordScoutRunFailure(
  svc: SupabaseClient,
  ctx: ScoutRunFailureContext,
): Promise<ScoutRunFailureOutcome> {
  if (ctx.countFailure === false) return { outcome: "ignored" };
  if (!shouldIncrementScoutFailure(ctx.errorClass)) {
    return { outcome: "ignored" };
  }
  if (
    ctx.runId && QUEUE_BACKED_SCOUT_TYPES.has(ctx.scoutType) &&
    isDeferrableRetrievalFailure(ctx.errorClass, ctx.errorMessage)
  ) {
    try {
      const facts = ctx.dispatchSource !== undefined
        ? {
          dispatchSource: ctx.dispatchSource,
          crawlerBackend: ctx.crawlerBackend ?? null,
        }
        : await loadRunDispatchFacts(svc, ctx.runId);
      if (facts.dispatchSource === "scheduled") {
        const scheduledFor = new Date(
          (ctx.now ?? Date.now)() + DEFERRED_RETRY_DELAY_MS,
        ).toISOString();
        const { data, error } = await svc.rpc("enqueue_scout_dispatch", {
          p_scout_id: ctx.scoutId,
          p_run_id: null,
          p_source: "deferred_retry",
          p_priority: 0,
          p_crawler_backend: facts.crawlerBackend ?? "service",
          p_scheduled_for: scheduledFor,
          p_retry_of: ctx.runId,
        });
        if (error) throw new Error(error.message);
        const row = (Array.isArray(data) ? data[0] : data) as
          | { run_id?: string; enqueued?: boolean }
          | null;
        logEvent({
          level: "info",
          fn: "scout-failures",
          event: row?.enqueued === false
            ? "deferred_retry_exists"
            : "deferred_retry_queued",
          scout_id: ctx.scoutId,
          run_id: ctx.runId,
          retry_run_id: row?.run_id ?? null,
          scheduled_for: scheduledFor,
          error_class: ctx.errorClass,
        });
        return {
          outcome: "deferred",
          retryRunId: row?.run_id ?? null,
          alreadyQueued: row?.enqueued === false,
        };
      }
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "scout-failures",
        event: "deferred_retry_failed",
        scout_id: ctx.scoutId,
        run_id: ctx.runId,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const increment = await incrementAndMaybeNotify(svc, ctx);
  return { outcome: "counted", increment };
}
