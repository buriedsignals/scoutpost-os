export type ScheduledScoutType = "web" | "beat" | "social" | "civic" | string;
export type ScheduleRegularity = "daily" | "weekly" | "monthly" | string;

function isSingleCronField(field: string): boolean {
  const normalized = field.trim();
  return Boolean(normalized) &&
    normalized !== "*" &&
    normalized !== "?" &&
    !/[,\-/]/.test(normalized);
}

export function cronIsNoMoreFrequentThanWeekly(cron: string): boolean {
  const trimmed = cron.trim();
  if (!trimmed) return true;

  const macro = trimmed.toLowerCase();
  if (
    macro === "@weekly" || macro === "@monthly" || macro === "@yearly" ||
    macro === "@annually"
  ) {
    return true;
  }
  if (macro === "@daily" || macro === "@hourly" || macro === "@reboot") {
    return false;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return true;

  const [, , dayOfMonth, , dayOfWeek] = parts;
  const hasSingleDayOfMonth = isSingleCronField(dayOfMonth);
  const hasSingleDayOfWeek = isSingleCronField(dayOfWeek);

  if (hasSingleDayOfMonth && dayOfWeek === "*") return true;
  if (dayOfMonth === "*" && hasSingleDayOfWeek) return true;
  return false;
}

export type ScheduleAction = "schedule" | "unschedule" | "none";

/**
 * Decide what to do with a scout's pg_cron job after an update, given which
 * fields changed and the scout's next state. Pure so it can be unit-tested
 * without a database.
 *
 * - Deactivated (is_active -> false): always remove the job.
 * - Reactivated (is_active -> true), or cron changed while staying active:
 *   reconcile the job to the next state — schedule when the scout will be
 *   active and has a cron, otherwise remove it.
 * - Nothing relevant changed: leave the job as-is.
 *
 * Reactivation previously had no branch, so un-pausing a scout via PATCH left
 * it unscheduled. Gating on `willBeActive` also avoids creating a job for a
 * still-paused scout whose only change is its cron expression.
 */
export function resolveScheduleAction(args: {
  activeChanged: boolean;
  cronChanged: boolean;
  willBeActive: boolean;
  hasSchedule: boolean;
}): ScheduleAction {
  const { activeChanged, cronChanged, willBeActive, hasSchedule } = args;
  if (activeChanged && !willBeActive) return "unschedule";
  if ((activeChanged && willBeActive) || cronChanged) {
    return willBeActive && hasSchedule ? "schedule" : "unschedule";
  }
  return "none";
}

export function schedulePolicyError(
  type: ScheduledScoutType | undefined | null,
  regularity?: ScheduleRegularity | null,
  scheduleCron?: string | null,
): string | null {
  if (type !== "beat" && type !== "civic") return null;

  const label = type === "beat" ? "beat scouts" : "civic scouts";
  if (regularity === "daily") {
    return `${label} support weekly or monthly schedules only`;
  }
  if (scheduleCron && !cronIsNoMoreFrequentThanWeekly(scheduleCron)) {
    return `${label} support weekly or monthly schedules only`;
  }
  return null;
}
