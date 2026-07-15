import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildTransportBaselineRows,
  normalizeTransportBaselineIds,
  validateTransportBaselineIds,
} from "./transport_baseline.ts";

Deno.test("transport baseline: normalizes and deduplicates ids", () => {
  assertEquals(
    normalizeTransportBaselineIds([" ABC123 ", "abc123", "DEF456"]),
    ["abc123", "def456"],
  );
});

Deno.test("transport baseline: rows suppress preview objects until re-entry", () => {
  const at = "2026-07-15T08:00:00.000Z";
  assertEquals(
    buildTransportBaselineRows("scout", "user", ["abc123", "ABC123"], at),
    [{
      scout_id: "scout",
      user_id: "user",
      object_id: "abc123",
      first_seen: at,
      last_seen: at,
      alerted_at: at,
    }],
  );
});

Deno.test("transport baseline: validates object and satellite pass ids against watch list", () => {
  assertEquals(
    validateTransportBaselineIds(
      { mode: "aircraft", watch_ids: ["abc123"] },
      ["ABC123"],
    ),
    null,
  );
  assertEquals(
    validateTransportBaselineIds(
      {
        mode: "satellite",
        watch_ids: ["25544"],
        geofence: {
          center: { lat: 47, lon: 8 },
          radius_km: 50,
        },
      },
      ["pass:25544:2026-07-15T08:00:00.000Z"],
    ),
    null,
  );
  assertMatch(
    validateTransportBaselineIds(
      { mode: "aircraft", watch_ids: ["abc123"] },
      ["def456"],
    ) ?? "",
    /not in config\.watch_ids/,
  );
});
