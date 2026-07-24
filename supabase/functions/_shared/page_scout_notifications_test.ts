import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldSendPageScoutAlert } from "./page_scout_notifications.ts";

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
