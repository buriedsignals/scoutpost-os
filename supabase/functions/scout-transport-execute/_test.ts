// Pure-helper tests for the transport worker. index.ts is not imported here —
// it calls Deno.serve at module load, which only works in the Edge runtime.
import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  IMPLEMENTED_MODES,
  OVERLAP_GRACE_MINUTES,
  overlapCutoffIso,
  precheckTransportScout,
  shouldYieldToPeer,
  TRANSPORT_RUN_TTL_DAYS,
  transportRunExpiresAt,
} from "./lib.ts";

Deno.test("transport run rows expire after 30 days, not the 90-day default", () => {
  assertEquals(TRANSPORT_RUN_TTL_DAYS, 30);
  const now = new Date("2026-07-03T12:00:00.000Z");
  assertEquals(transportRunExpiresAt(now), "2026-08-02T12:00:00.000Z");
});

Deno.test("overlap cutoff matches the stale-run sweeper grace window", () => {
  assertEquals(OVERLAP_GRACE_MINUTES, 45);
  const now = new Date("2026-07-03T12:00:00.000Z");
  assertEquals(overlapCutoffIso(now), "2026-07-03T11:15:00.000Z");
});

Deno.test("precheck rejects invalid config before any billing", () => {
  const result = precheckTransportScout({ mode: "vessel" });
  assertEquals(result.ok, false);
  assertExists(result.error);
  assertStringIncludes(result.error!, "geofence, watch_ids, or both");
});

Deno.test("precheck surfaces mode and criteria flag for cost computation", () => {
  const withCriteria = precheckTransportScout({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    criteria: "only tankers heading west",
  });
  assertEquals(withCriteria.ok, true);
  assertEquals(withCriteria.mode, "vessel");
  assertEquals(withCriteria.hasCriteria, true);

  const without = precheckTransportScout({
    mode: "aircraft",
    watch_ids: ["4ca123"],
  });
  assertEquals(without.ok, true);
  assertEquals(without.hasCriteria, false);
});

Deno.test("U1 ships no enabled mode executors — runs skip unbilled", () => {
  assertEquals(IMPLEMENTED_MODES.size, 0);
});

Deno.test("overlap election: exactly one of two concurrent runs proceeds", () => {
  const a = { id: "aaaa", started_at: "2026-07-03T12:00:00.000Z" };
  const b = { id: "bbbb", started_at: "2026-07-03T12:00:01.000Z" };
  const rows = [a, b];
  // Older row proceeds, newer yields — never both, never neither.
  assertEquals(shouldYieldToPeer(a, rows), false);
  assertEquals(shouldYieldToPeer(b, rows), true);
});

Deno.test("overlap election: identical timestamps tiebreak on id", () => {
  const a = { id: "aaaa", started_at: "2026-07-03T12:00:00.000Z" };
  const b = { id: "bbbb", started_at: "2026-07-03T12:00:00.000Z" };
  const rows = [a, b];
  assertEquals(shouldYieldToPeer(a, rows), false);
  assertEquals(shouldYieldToPeer(b, rows), true);
});

Deno.test("overlap election: a lone run never yields to itself", () => {
  const a = { id: "aaaa", started_at: "2026-07-03T12:00:00.000Z" };
  assertEquals(shouldYieldToPeer(a, [a]), false);
  assertEquals(shouldYieldToPeer(a, []), false);
});
