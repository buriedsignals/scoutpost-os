// Tests for the transport alert email card cap. capTransportEntrants is the
// pure slice used by both sendTransportScoutAlert and the benchmark preview.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  capTransportEntrants,
  MAX_TRANSPORT_EMAIL_CARDS,
} from "./notifications.ts";

Deno.test("email card cap matches the 20-id watch-list cap", () => {
  assertEquals(MAX_TRANSPORT_EMAIL_CARDS, 20);
});

Deno.test("at or under the cap, every entrant renders and overflow is 0", () => {
  const s = Array.from({ length: 20 }, (_, i) => `vessel ${i} entered`);
  const { shown, overflow } = capTransportEntrants(s);
  assertEquals(shown.length, 20);
  assertEquals(overflow, 0);
  const few = capTransportEntrants(["one entered"]);
  assertEquals(few.shown, ["one entered"]);
  assertEquals(few.overflow, 0);
});

Deno.test("over the cap, the first 20 render and the rest are counted", () => {
  const s = Array.from({ length: 23 }, (_, i) => `vessel ${i} entered`);
  const { shown, overflow } = capTransportEntrants(s);
  assertEquals(shown.length, 20);
  assertEquals(overflow, 3);
  assertEquals(shown[0], "vessel 0 entered");
  assertEquals(shown[19], "vessel 19 entered");
});
