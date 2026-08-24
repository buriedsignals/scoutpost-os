import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  scheduledRunFailure,
  scheduledRunIsSettled,
} from "./benchmark-page-scout-scheduler.ts";

Deno.test("scheduled Page benchmark waits for notification delivery after run success", () => {
  assertEquals(
    scheduledRunIsSettled({
      status: "success",
      notification_status: "pending",
    }),
    false,
  );
  assertEquals(
    scheduledRunIsSettled({ status: "success", notification_status: "sent" }),
    true,
  );
});

Deno.test("scheduled Page benchmark accepts model-derived units", () => {
  assertEquals(
    scheduledRunFailure({
      status: "success",
      articles_count: 1,
      notification_status: "sent",
      error_message: null,
    }),
    null,
  );
});

Deno.test("scheduled Page benchmark returns terminal failures without waiting on notification", () => {
  assertEquals(
    scheduledRunIsSettled({ status: "error", notification_status: "pending" }),
    true,
  );
  assertEquals(
    scheduledRunIsSettled({ status: "running", notification_status: null }),
    false,
  );
});
