import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldSendPageScoutAlert } from "./page_scout_notifications.ts";

Deno.test("shouldSendPageScoutAlert: sends for Any Change scouts with new units", () => {
  assertEquals(
    shouldSendPageScoutAlert({
      articles_count: 1,
      criteria_ran: false,
      summary: "The page changed.",
    }),
    true,
  );
});

Deno.test("shouldSendPageScoutAlert: sends for criteria scouts with matching units", () => {
  assertEquals(
    shouldSendPageScoutAlert({
      articles_count: 1,
      criteria_ran: true,
      summary: "The criteria matched.",
    }),
    true,
  );
});

Deno.test("shouldSendPageScoutAlert: skips empty runs and empty summaries", () => {
  assertEquals(
    shouldSendPageScoutAlert({
      articles_count: 0,
      criteria_ran: false,
      summary: "No alert.",
    }),
    false,
  );
  assertEquals(
    shouldSendPageScoutAlert({
      articles_count: 1,
      criteria_ran: false,
      summary: " ",
    }),
    false,
  );
});
