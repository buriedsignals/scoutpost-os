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
