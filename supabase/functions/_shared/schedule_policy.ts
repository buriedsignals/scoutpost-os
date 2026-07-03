export type ScheduledScoutType =
  | "web"
  | "beat"
  | "social"
  | "civic"
  | "transport"
  | string;
export type ScheduleRegularity =
  | "daily"
  | "weekly"
  | "monthly"
  | "3h"
  | "6h"
  | "12h"
  | string;

/** Sub-daily regularity values exist only for transport scouts. */
export const SUB_DAILY_REGULARITIES = new Set(["3h", "6h", "12h"]);
/** The approved transport schedule window: 3h floor, daily ceiling. */
export const TRANSPORT_REGULARITIES = new Set(["3h", "6h", "12h", "daily"]);

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

/** True when a 5-field cron cannot fire more often than every 3 hours.
 * Conservative: unrecognized shapes return false (rejected for transport). */
export function cronIsNoMoreFrequentThanEvery3Hours(cron: string): boolean {
  const trimmed = cron.trim();
  if (!trimmed) return true;

  const macro = trimmed.toLowerCase();
  if (macro === "@daily" || macro === "@weekly" || macro === "@monthly") {
    return true;
  }
  if (macro.startsWith("@")) return false;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour] = parts;

  // Minute must be one fixed value — steps/lists/ranges/'*' fire sub-hourly.
  if (!isSingleCronField(minute)) return false;

  if (isSingleCronField(hour)) return true; // one fixed hour → at most daily
  const step = hour.match(/^(?:\*|\d{1,2}-\d{1,2})\/(\d{1,2})$/);
  if (step) return parseInt(step[1], 10) >= 3;
  // Comma list of fixed hours: every circular gap (incl. the midnight
  // wraparound) must be ≥3h — "0,1,2,…" clusters may not sneak under the
  // floor just by staying ≤8 entries.
  if (/^\d{1,2}(,\d{1,2})+$/.test(hour)) {
    const hours = [...new Set(hour.split(",").map((h) => parseInt(h, 10)))]
      .sort((a, b) => a - b);
    if (hours.some((h) => h > 23)) return false;
    if (hours.length === 1) return true;
    for (let i = 0; i < hours.length; i++) {
      const next = hours[(i + 1) % hours.length];
      const gap = i === hours.length - 1
        ? next + 24 - hours[i]
        : next - hours[i];
      if (gap < 3) return false;
    }
    return true;
  }
  return false;
}

/** True only for crons that fire exactly once a day at a fixed time
 * ("MM HH * * *" or @daily). Weekly/monthly shapes are NOT accepted —
 * satellite scouts predict passes one day ahead, so anything less frequent
 * than daily silently loses coverage. */
export function cronIsExactlyDaily(cron: string): boolean {
  const trimmed = cron.trim();
  if (!trimmed) return false;
  if (trimmed.toLowerCase() === "@daily") return true;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return isSingleCronField(minute) && isSingleCronField(hour) &&
    dayOfMonth === "*" && month === "*" && dayOfWeek === "*";
}

/** Recover the (time, day) anchor from an existing cron so a regularity-only
 * PATCH can resynthesize a consistent schedule instead of silently keeping
 * the old cadence. Returns null for shapes we can't anchor (steps, '*'
 * minutes/hours). `day` is the fixed day-of-month or day-of-week when one
 * exists (cron 0=Sun mapped to the API's 7=Sun). */
export function deriveScheduleAnchor(
  cron: string | null | undefined,
): { time: string; day?: number } | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, , dayOfWeek] = parts;
  if (!/^\d{1,2}$/.test(minute)) return null;
  // Hour: fixed value or the first entry of an anchored comma list.
  const hourMatch = hour.match(/^(\d{1,2})(?:,\d{1,2})*$/);
  if (!hourMatch) return null;
  const hh = parseInt(hourMatch[1], 10);
  const mm = parseInt(minute, 10);
  if (hh > 23 || mm > 59) return null;
  const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  if (/^\d{1,2}$/.test(dayOfMonth) && dayOfWeek === "*") {
    return { time, day: parseInt(dayOfMonth, 10) };
  }
  if (dayOfMonth === "*" && /^\d$/.test(dayOfWeek)) {
    const dow = parseInt(dayOfWeek, 10);
    return { time, day: dow === 0 ? 7 : dow };
  }
  return { time };
}

/** True when a 5-field cron cannot fire more often than once a day. */
export function cronIsNoMoreFrequentThanDaily(cron: string): boolean {
  const trimmed = cron.trim();
  if (!trimmed) return true;
  if (cronIsNoMoreFrequentThanWeekly(trimmed)) return true;

  const macro = trimmed.toLowerCase();
  if (macro === "@daily") return true;
  if (macro.startsWith("@")) return false;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour] = parts;
  return isSingleCronField(minute) && isSingleCronField(hour);
}

/** Synthesise a cron for the transport sub-daily regularities, anchored to
 * the user's chosen time so runs land at predictable clock hours.
 * Returns null for non-sub-daily regularities. */
export function subDailyCronFromParts(
  regularity: string,
  time: string,
): string | null {
  const stepByRegularity: Record<string, number> = {
    "3h": 3,
    "6h": 6,
    "12h": 12,
  };
  const step = stepByRegularity[regularity];
  if (!step) return null;
  const [hh, mm] = time.split(":").map((s) => parseInt(s, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  const anchor = hh % step;
  const hours: number[] = [];
  for (let h = anchor; h < 24; h += step) hours.push(h);
  return `${mm} ${hours.join(",")} * * *`;
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
  transportMode?: string | null,
): string | null {
  // Sub-daily regularity values are transport-only.
  if (
    type && type !== "transport" && regularity &&
    SUB_DAILY_REGULARITIES.has(regularity)
  ) {
    return `${type} scouts do not support sub-daily schedules`;
  }

  if (type === "transport") {
    if (transportMode === "satellite") {
      if (regularity && regularity !== "daily") {
        return "satellite transport scouts support daily schedules only (passes are predicted a day ahead)";
      }
      if (scheduleCron && !cronIsExactlyDaily(scheduleCron)) {
        return "satellite transport scouts support daily schedules only (passes are predicted a day ahead)";
      }
      return null;
    }
    if (regularity && !TRANSPORT_REGULARITIES.has(regularity)) {
      return "transport scouts support 3h, 6h, 12h, or daily schedules";
    }
    if (scheduleCron && !cronIsNoMoreFrequentThanEvery3Hours(scheduleCron)) {
      return "transport scouts run at most every 3 hours";
    }
    return null;
  }

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
