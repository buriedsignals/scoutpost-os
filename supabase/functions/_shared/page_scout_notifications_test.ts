import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  planPageScoutNotification,
  resolvePageScoutNotificationMode,
  shouldSendPageScoutAlert,
} from "./page_scout_notifications.ts";

Deno.test("shouldSendPageScoutAlert: sends when the comparison made the alert eligible", () => {
  assertEquals(
    shouldSendPageScoutAlert({
      alert_eligible: true,
      articles_count: 0,
      criteria_ran: false,
      summary: null,
    }),
    true,
  );
});

Deno.test("shouldSendPageScoutAlert: sends matching Specific Changes after every unit deduplicates", () => {
  assertEquals(
    shouldSendPageScoutAlert({
      alert_eligible: true,
      articles_count: 0,
      criteria_ran: true,
      summary: "",
    }),
    true,
  );
});

Deno.test("shouldSendPageScoutAlert: skips comparisons that are not eligible", () => {
  assertEquals(
    shouldSendPageScoutAlert({
      alert_eligible: false,
      articles_count: 4,
      criteria_ran: false,
      summary: "Extracted content is not a change decision.",
    }),
    false,
  );
  assertEquals(
    shouldSendPageScoutAlert({
      alert_eligible: false,
      articles_count: 2,
      criteria_ran: true,
      summary: "The criteria did not match the delta.",
    }),
    false,
  );
});

Deno.test("notification-disabled pipeline tests expose eligibility without delivering mail", () => {
  assertEquals(
    planPageScoutNotification({
      alert_eligible: true,
      articles_count: 0,
      criteria_ran: true,
    }, "disabled"),
    {
      alertEligible: true,
      shouldSend: false,
      notificationStatus: "skipped",
      suppressionReason: "test_delivery_disabled",
    },
  );
});

Deno.test("ordinary Page Scout runs still deliver eligible alerts", () => {
  assertEquals(
    planPageScoutNotification({
      alert_eligible: true,
      articles_count: 0,
      criteria_ran: true,
    }, "deliver"),
    {
      alertEligible: true,
      shouldSend: true,
      notificationStatus: "pending",
      suppressionReason: null,
    },
  );
});

Deno.test("service-created benchmark scouts disable delivery through private metadata", () => {
  assertEquals(
    resolvePageScoutNotificationMode("deliver", {
      page_scout_benchmark: { notification_mode: "disabled" },
    }),
    "disabled",
  );
  assertEquals(
    resolvePageScoutNotificationMode("deliver", {
      page_scout_benchmark: { notification_mode: "deliver" },
    }),
    "deliver",
  );
  assertEquals(resolvePageScoutNotificationMode("disabled", null), "disabled");
});
