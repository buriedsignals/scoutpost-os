import type { SupabaseClient } from "./supabase.ts";
import { ValidationError } from "./errors.ts";
import {
  type PageScoutNotificationMode,
  resolvePageScoutNotificationMode,
} from "./page_scout_notifications.ts";

export async function bindPageScoutNotificationMode(
  svc: SupabaseClient,
  runId: string,
  scoutId: string,
  requested: PageScoutNotificationMode,
  metadata: Record<string, unknown> | null,
): Promise<PageScoutNotificationMode> {
  const { data, error } = await svc.rpc("bind_page_scout_notification_mode", {
    p_run_id: runId,
    p_scout_id: scoutId,
    p_mode: resolvePageScoutNotificationMode(requested, metadata),
  });
  if (error || (data !== "deliver" && data !== "disabled")) {
    throw new Error(
      `Page notification policy could not be bound: ${
        error?.message ?? "invalid result"
      }`,
    );
  }
  return data;
}

/** Reject changed inputs or unapproved billing before replay side effects. */
export function assertPageScoutReplayApproval(
  scout: Record<string, unknown>,
  runMetadata: Record<string, unknown> | null,
  mode: PageScoutNotificationMode,
  creditCost: number,
): void {
  const replay = runMetadata?.operator_replay;
  if (replay === undefined) return;
  if (
    !isObject(replay) || !isObject(replay.snapshot) ||
    !isObject(replay.snapshot.scout)
  ) {
    throw new ValidationError("invalid operator replay approval");
  }
  if (
    mode !== "disabled" || scout.is_active !== false ||
    !Number.isInteger(replay.approved_credit_cost) ||
    Number(replay.approved_credit_cost) < creditCost
  ) {
    throw new ValidationError(
      "operator replay notification, pause or credit approval changed",
    );
  }
  const original = replay.snapshot.scout;
  // Runtime-maintained metadata, failure counters and baseline timestamps may
  // change during a legitimate continuation; the monitored inputs may not.
  for (
    const key of [
      "id",
      "user_id",
      "type",
      "url",
      "criteria",
      "project_id",
      "preferred_language",
      "archive_enabled",
      "wayback_enabled",
      "schedule_cron",
    ]
  ) {
    if ((scout[key] ?? null) !== (original[key] ?? null)) {
      throw new ValidationError(
        `operator replay input changed: ${key}; preview again`,
      );
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
