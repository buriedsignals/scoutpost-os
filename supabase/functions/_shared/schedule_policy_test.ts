import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  cronIsNoMoreFrequentThanWeekly,
  resolveScheduleAction,
  schedulePolicyError,
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
