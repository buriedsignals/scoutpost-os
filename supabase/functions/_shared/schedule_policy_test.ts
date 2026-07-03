import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  cronIsExactlyDaily,
  cronIsNoMoreFrequentThanDaily,
  cronIsNoMoreFrequentThanEvery3Hours,
  cronIsNoMoreFrequentThanWeekly,
  deriveScheduleAnchor,
  resolveScheduleAction,
  schedulePolicyError,
  subDailyCronFromParts,
} from "./schedule_policy.ts";

Deno.test("schedule policy accepts weekly and monthly beat schedules", () => {
  assertEquals(schedulePolicyError("beat", "weekly", "0 8 * * 1"), null);
  assertEquals(schedulePolicyError("beat", "monthly", "0 8 1 * *"), null);
  assertEquals(schedulePolicyError("beat", undefined, "@weekly"), null);
});

Deno.test("schedule policy rejects daily beat schedules", () => {
  assertEquals(
    schedulePolicyError("beat", "daily", "0 8 * * *"),
    "beat scouts support weekly or monthly schedules only",
  );
  assertEquals(
    schedulePolicyError("beat", undefined, "0 8 * * *"),
    "beat scouts support weekly or monthly schedules only",
  );
  assertEquals(cronIsNoMoreFrequentThanWeekly("@daily"), false);
});

Deno.test("schedule policy keeps non-beat scouts unchanged", () => {
  assertEquals(schedulePolicyError("web", "daily", "0 8 * * *"), null);
  assertEquals(schedulePolicyError("social", "daily", "0 8 * * *"), null);
});

Deno.test("schedule policy rejects sub-daily regularity for non-transport types", () => {
  assertEquals(
    schedulePolicyError("web", "3h"),
    "web scouts do not support sub-daily schedules",
  );
  assertEquals(
    schedulePolicyError("social", "12h"),
    "social scouts do not support sub-daily schedules",
  );
  assertEquals(
    schedulePolicyError("beat", "6h"),
    "beat scouts do not support sub-daily schedules",
  );
});

Deno.test("schedule policy accepts the transport window (3h floor, daily ceiling)", () => {
  assertEquals(
    schedulePolicyError("transport", "3h", "0 0,3,6,9,12,15,18,21 * * *"),
    null,
  );
  assertEquals(schedulePolicyError("transport", "6h", "30 */6 * * *"), null);
  assertEquals(schedulePolicyError("transport", "12h", "0 5,17 * * *"), null);
  assertEquals(schedulePolicyError("transport", "daily", "0 8 * * *"), null);
});

Deno.test("schedule policy rejects transport schedules outside the window", () => {
  assertEquals(
    schedulePolicyError("transport", "weekly"),
    "transport scouts support 3h, 6h, 12h, or daily schedules",
  );
  assertEquals(
    schedulePolicyError("transport", undefined, "*/30 * * * *"),
    "transport scouts run at most every 3 hours",
  );
  assertEquals(
    schedulePolicyError("transport", undefined, "0 * * * *"),
    "transport scouts run at most every 3 hours",
  );
});

Deno.test("hour comma lists cannot cluster under the 3h floor", () => {
  // 8 consecutive hours: ≤8 entries but hourly cadence — must be rejected.
  assertEquals(
    schedulePolicyError("transport", undefined, "0 0,1,2,3,4,5,6,7 * * *"),
    "transport scouts run at most every 3 hours",
  );
  // Midnight wraparound gap of 2h (22 → 0) — rejected.
  assertEquals(
    cronIsNoMoreFrequentThanEvery3Hours("0 0,22 * * *"),
    false,
  );
  // Properly spaced lists still pass.
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("0 2,5,8,11 * * *"), true);
});

Deno.test("satellite transport scouts reject weekly/monthly crons too", () => {
  // Regularity 'weekly' and an equivalent raw cron must both be rejected.
  assertEquals(
    schedulePolicyError("transport", undefined, "0 8 * * 1", "satellite"),
    "satellite transport scouts support daily schedules only (passes are predicted a day ahead)",
  );
  assertEquals(
    schedulePolicyError("transport", undefined, "0 8 1 * *", "satellite"),
    "satellite transport scouts support daily schedules only (passes are predicted a day ahead)",
  );
});

Deno.test("cronIsExactlyDaily accepts only fixed once-a-day shapes", () => {
  assertEquals(cronIsExactlyDaily("0 6 * * *"), true);
  assertEquals(cronIsExactlyDaily("@daily"), true);
  assertEquals(cronIsExactlyDaily("0 8 * * 1"), false); // weekly
  assertEquals(cronIsExactlyDaily("0 8 1 * *"), false); // monthly
  assertEquals(cronIsExactlyDaily("0 6,18 * * *"), false);
  assertEquals(cronIsExactlyDaily("0 */6 * * *"), false);
});

Deno.test("deriveScheduleAnchor recovers time and day from existing crons", () => {
  assertEquals(deriveScheduleAnchor("20 9 * * *"), { time: "09:20" });
  assertEquals(deriveScheduleAnchor("0 8 * * 1"), { time: "08:00", day: 1 });
  assertEquals(deriveScheduleAnchor("0 8 * * 0"), { time: "08:00", day: 7 });
  assertEquals(deriveScheduleAnchor("30 6 15 * *"), { time: "06:30", day: 15 });
  // Anchored sub-daily comma list → first hour is the anchor.
  assertEquals(deriveScheduleAnchor("20 1,4,7,10,13,16,19,22 * * *"), {
    time: "01:20",
  });
  assertEquals(deriveScheduleAnchor("*/15 * * * *"), null);
  assertEquals(deriveScheduleAnchor("0 */3 * * *"), null);
  assertEquals(deriveScheduleAnchor(null), null);
});

Deno.test("schedule policy pins satellite transport scouts to daily", () => {
  assertEquals(
    schedulePolicyError("transport", "daily", "0 6 * * *", "satellite"),
    null,
  );
  assertEquals(
    schedulePolicyError("transport", "3h", undefined, "satellite"),
    "satellite transport scouts support daily schedules only (passes are predicted a day ahead)",
  );
  assertEquals(
    schedulePolicyError("transport", undefined, "0 */6 * * *", "satellite"),
    "satellite transport scouts support daily schedules only (passes are predicted a day ahead)",
  );
});

Deno.test("cronIsNoMoreFrequentThanEvery3Hours classifies cron shapes", () => {
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("0 */3 * * *"), true);
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("15 */6 * * *"), true);
  assertEquals(
    cronIsNoMoreFrequentThanEvery3Hours("0 2,5,8,11,14,17,20,23 * * *"),
    true,
  );
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("0 8 * * *"), true);
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("0 * * * *"), false);
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("*/15 * * * *"), false);
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("0 */2 * * *"), false);
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("0,30 */3 * * *"), false);
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("@hourly"), false);
  assertEquals(cronIsNoMoreFrequentThanEvery3Hours("@daily"), true);
});

Deno.test("cronIsNoMoreFrequentThanDaily classifies cron shapes", () => {
  assertEquals(cronIsNoMoreFrequentThanDaily("0 6 * * *"), true);
  assertEquals(cronIsNoMoreFrequentThanDaily("@daily"), true);
  assertEquals(cronIsNoMoreFrequentThanDaily("0 8 * * 1"), true); // weekly
  assertEquals(cronIsNoMoreFrequentThanDaily("0 */6 * * *"), false);
  assertEquals(cronIsNoMoreFrequentThanDaily("0 6,18 * * *"), false);
});

Deno.test("subDailyCronFromParts anchors hour lists to the chosen time", () => {
  assertEquals(
    subDailyCronFromParts("3h", "10:20"),
    "20 1,4,7,10,13,16,19,22 * * *",
  );
  assertEquals(subDailyCronFromParts("6h", "08:00"), "0 2,8,14,20 * * *");
  assertEquals(subDailyCronFromParts("12h", "17:30"), "30 5,17 * * *");
  assertEquals(subDailyCronFromParts("daily", "08:00"), null);
  assertEquals(subDailyCronFromParts("3h", "not-a-time"), null);
});

Deno.test("resolveScheduleAction reschedules a reactivated scout", () => {
  // The regression: un-pausing (false->true) with an unchanged cron must
  // re-create the job, not fall through to "none".
  assertEquals(
    resolveScheduleAction({
      activeChanged: true,
      cronChanged: false,
      willBeActive: true,
      hasSchedule: true,
    }),
    "schedule",
  );
});

Deno.test("resolveScheduleAction unschedules a paused scout", () => {
  assertEquals(
    resolveScheduleAction({
      activeChanged: true,
      cronChanged: false,
      willBeActive: false,
      hasSchedule: true,
    }),
    "unschedule",
  );
});

Deno.test("resolveScheduleAction follows cron changes while active", () => {
  assertEquals(
    resolveScheduleAction({
      activeChanged: false,
      cronChanged: true,
      willBeActive: true,
      hasSchedule: true,
    }),
    "schedule",
  );
  // Cron cleared while active -> remove the job.
  assertEquals(
    resolveScheduleAction({
      activeChanged: false,
      cronChanged: true,
      willBeActive: true,
      hasSchedule: false,
    }),
    "unschedule",
  );
});

Deno.test("resolveScheduleAction does not schedule a still-paused scout on cron change", () => {
  assertEquals(
    resolveScheduleAction({
      activeChanged: false,
      cronChanged: true,
      willBeActive: false,
      hasSchedule: true,
    }),
    "unschedule",
  );
});

Deno.test("resolveScheduleAction is a no-op when nothing relevant changed", () => {
  assertEquals(
    resolveScheduleAction({
      activeChanged: false,
      cronChanged: false,
      willBeActive: true,
      hasSchedule: true,
    }),
    "none",
  );
});

Deno.test("resolveScheduleAction reactivation without a cron removes the job", () => {
  assertEquals(
    resolveScheduleAction({
      activeChanged: true,
      cronChanged: false,
      willBeActive: true,
      hasSchedule: false,
    }),
    "unschedule",
  );
});
