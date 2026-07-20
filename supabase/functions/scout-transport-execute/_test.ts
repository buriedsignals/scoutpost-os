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
  assertStringIncludes(result.error!, "require watch_ids");
});

Deno.test("precheck surfaces mode and criteria flag for cost computation", () => {
  const withCriteria = precheckTransportScout({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    watch_ids: ["636019825"],
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

Deno.test("mode gate: all three modes live (U2 aircraft, U3 vessel, U4 satellite)", () => {
  assertEquals(IMPLEMENTED_MODES.has("aircraft"), true);
  assertEquals(IMPLEMENTED_MODES.has("vessel"), true);
  assertEquals(IMPLEMENTED_MODES.has("satellite"), true);
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

// ── U2: geofence math + tiling ──────────────────────────────────────────────
import { haversineKm, pointInGeofence, tileGeofence } from "./geofence.ts";
import {
  fetchAircraftCandidates,
  filterAircraft,
  isMilitaryOnly,
  normalizeAircraft,
  parseAdsbResponse,
} from "./aircraft.ts";
import { evictionHorizonHours } from "./state.ts";
import { composeAircraftStatement } from "./events.ts";

const DOVER = {
  kind: "bbox" as const,
  name: "Dover Strait",
  minLat: 50.5,
  minLon: 0.5,
  maxLat: 51.5,
  maxLon: 2.5,
};

Deno.test("haversine: London→Paris ≈ 344 km", () => {
  const d = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
  if (Math.abs(d - 344) > 10) throw new Error(`got ${d}`);
});

Deno.test("watch-list fetch batches ALL hexes into one /hex query and retries once on 429", async () => {
  // Live QA (2026-07-04): per-hex loops — even paced ~1/s — kept tripping
  // adsb.lol's burst limiter (~5 requests, no Retry-After) from Supabase's
  // shared egress IPs. The route accepts a comma list (verified live
  // 2026-07-06), so the whole watch list goes in ONE request.
  const calls: { path: string; at: number }[] = [];
  let rateLimited = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ path: url.slice(url.indexOf("/hex/")), at: Date.now() });
    // First request 429s once (no Retry-After, like the real API); the
    // retry succeeds.
    if (!rateLimited) {
      rateLimited = true;
      return Promise.resolve(new Response("rate limited", { status: 429 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ac: [
            { hex: "ae0001", lat: 26.5, lon: 56.2, dbFlags: 1 },
            { hex: "ae0003", lat: 31.1, lon: 47.9, dbFlags: 1 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const out = await fetchAircraftCandidates(
      { mode: "aircraft", watch_ids: ["ae0001", "ae0003", "ae0004"] },
      null,
    );
    assertEquals(out.length, 2);
    // Exactly 2 requests: the batched query (429) + its retry — never one
    // request per hex.
    assertEquals(calls.length, 2);
    assertEquals(calls[0].path, "/hex/ae0001,ae0003,ae0004");
    assertEquals(calls[1].path, "/hex/ae0001,ae0003,ae0004");
    // The no-Retry-After retry waits the 2s default.
    if (calls[1].at - calls[0].at < 1800) {
      throw new Error(`retry too fast: ${calls[1].at - calls[0].at}ms`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("pointInGeofence: bbox and circle containment", () => {
  assertEquals(pointInGeofence(DOVER, 51.0, 1.5), true);
  assertEquals(pointInGeofence(DOVER, 49.0, 1.5), false);
  const circle = {
    kind: "circle" as const,
    name: "50km",
    lat: 51.0,
    lon: 1.5,
    radiusKm: 50,
  };
  assertEquals(pointInGeofence(circle, 51.2, 1.5), true); // ~22 km
  assertEquals(pointInGeofence(circle, 52.0, 1.5), false); // ~111 km
});

Deno.test("tiling: small shapes get one tile, elongated boxes get more", () => {
  assertEquals(tileGeofence(DOVER).length, 1); // ~111×140 km
  const bigBox = { ...DOVER, name: "big", minLon: -4.0, maxLon: 8.0 }; // ~840 km wide
  const tiles = tileGeofence(bigBox);
  if (tiles.length < 2) {
    throw new Error(`expected ≥2 tiles, got ${tiles.length}`);
  }
  for (const t of tiles) assertEquals(t.radiusNm <= 250, true);
});

// ── U2: adsb.lol parsing (recorded fixture) ────────────────────────────────
const fixture = JSON.parse(
  Deno.readTextFileSync(
    new URL("./fixtures/adsb_dover.json", import.meta.url),
  ),
);

Deno.test("recorded Dover fixture parses to normalized aircraft", () => {
  const parsed = parseAdsbResponse(fixture);
  if (parsed.length === 0) throw new Error("fixture yielded no aircraft");
  for (const a of parsed) {
    assertEquals(/^[0-9a-f]{6}$/.test(a.id), true);
    assertEquals(typeof a.lat, "number");
  }
});

Deno.test("normalizeAircraft drops TIS-B and positionless records", () => {
  assertEquals(normalizeAircraft({ hex: "~ae01ce", lat: 51, lon: 1 }), null);
  assertEquals(normalizeAircraft({ hex: "4ca123" }), null);
  const ok = normalizeAircraft({ hex: "4CA123", lat: 51, lon: 1, dbFlags: 1 });
  assertEquals(ok?.id, "4ca123");
  assertEquals(ok?.military, true);
});

Deno.test("filterAircraft: watch ids match hex or registration", () => {
  const parsed = parseAdsbResponse(fixture);
  const first = parsed[0];
  const byHex = filterAircraft(
    { mode: "aircraft", watch_ids: [first.id] },
    parsed,
  );
  assertEquals(byHex.length, 1);
  assertEquals(byHex[0].id, first.id);
  const military = filterAircraft(
    { mode: "aircraft", categories: ["military"], watch_ids: [] },
    parsed,
  );
  // military category keeps dbFlags-military OR watchlist hits (none passed).
  for (const a of military) assertEquals(a.military, true);
});

Deno.test("filterAircraft: watchlist categories keep hexes in the watchlist set", () => {
  const cands = [
    {
      id: "43c6e2",
      lat: 51,
      lon: 1.5,
      callsign: "GOV1",
      registration: "Z-WPF",
      aircraftType: "B762",
      altitudeFt: 30000,
      speedKts: 400,
      trackDeg: 90,
      military: false,
    },
    {
      id: "abcd12",
      lat: 51,
      lon: 1.5,
      callsign: "CIVIL1",
      registration: "N1",
      aircraftType: "C172",
      altitudeFt: 3000,
      speedKts: 100,
      trackDeg: 90,
      military: false,
    },
  ];
  // Government scout with 43c6e2 on the watchlist → only that one kept.
  const gov = filterAircraft(
    { mode: "aircraft", categories: ["government"] },
    cands,
    new Set(["43c6e2"]),
  );
  assertEquals(gov.map((a) => a.id), ["43c6e2"]);
  // Military scout keeps dbFlags-military even if not on the watchlist.
  const mil = filterAircraft(
    { mode: "aircraft", categories: ["military"] },
    [{ ...cands[1], military: true }],
    new Set(),
  );
  assertEquals(mil.length, 1);
});

Deno.test("isMilitaryOnly routes military-only category sets to /v2/mil", () => {
  assertEquals(
    isMilitaryOnly({ mode: "aircraft", categories: ["military"] }),
    true,
  );
  assertEquals(isMilitaryOnly({ mode: "aircraft", categories: [] }), false);
  assertEquals(isMilitaryOnly({ mode: "aircraft" }), false);
});

// ── U2: state horizon + statement composition ──────────────────────────────
Deno.test("eviction horizon is 2× cadence with a 6h floor", () => {
  assertEquals(evictionHorizonHours("3h"), 6);
  assertEquals(evictionHorizonHours("12h"), 24);
  assertEquals(evictionHorizonHours("daily"), 48);
  assertEquals(evictionHorizonHours(null), 48);
});

const STATEMENT_AIRCRAFT = {
  id: "43c6e2",
  lat: 51,
  lon: 1.5,
  callsign: "ZK339",
  registration: "ZZ338",
  aircraftType: "A332",
  altitudeFt: 31000,
  speedKts: 420,
  trackDeg: 95,
  military: true,
};

Deno.test("aircraft entry statements read like alerts, not telemetry", () => {
  const s = composeAircraftStatement(
    STATEMENT_AIRCRAFT,
    { name: "Dover Strait", isWatchlist: false },
    new Date("2026-07-03T14:32:00Z"),
  );
  assertEquals(
    s,
    "Military aircraft ZK339 (ZZ338, A332) entered Dover Strait at 14:32 UTC, heading 095° at 31,000 ft.",
  );
});

Deno.test("watch-list statements never say 'entered watched identifiers'", () => {
  const s = composeAircraftStatement(
    STATEMENT_AIRCRAFT,
    { name: "watch list", isWatchlist: true },
    new Date("2026-07-03T14:32:00Z"),
  );
  assertEquals(
    s,
    "Watched military aircraft ZK339 (ZZ338, A332) appeared at 51.00, 1.50 (14:32 UTC), heading 095° at 31,000 ft.",
  );
});

// ── U3: vessel staleness + filtering + statement ────────────────────────────
import {
  filterVessels,
  POSITION_MAX_AGE_MINUTES,
  SAMPLER_PERIOD_MINUTES,
  samplerHeartbeatIsFresh,
  stalenessCutoffMinutes,
  type VesselObject,
} from "./vessel.ts";
import { composeVesselStatement } from "./events.ts";

Deno.test("vessel freshness follows sampler cadence, not consumer cadence", () => {
  assertEquals(stalenessCutoffMinutes("3h"), POSITION_MAX_AGE_MINUTES);
  assertEquals(stalenessCutoffMinutes("12h"), POSITION_MAX_AGE_MINUTES);
  assertEquals(stalenessCutoffMinutes(null), POSITION_MAX_AGE_MINUTES);
  assertEquals(SAMPLER_PERIOD_MINUTES, 60);
});

Deno.test("successful sampler heartbeat expires independently of cached positions", () => {
  const now = new Date("2026-07-20T18:00:00Z");
  assertEquals(
    samplerHeartbeatIsFresh("2026-07-20T16:31:00Z", now),
    true,
  );
  assertEquals(
    samplerHeartbeatIsFresh("2026-07-20T16:29:00Z", now),
    false,
  );
  assertEquals(samplerHeartbeatIsFresh(null, now), false);
});

const VESSELS: VesselObject[] = [
  {
    id: "636019825",
    lat: 26,
    lon: 56,
    name: "DELTA",
    flag: "Liberia",
    classification: "tanker",
    military: false,
    shipType: 80,
    speedKnots: 12.4,
    courseDeg: 270,
  },
  {
    id: "563148100",
    lat: 26.1,
    lon: 56.1,
    name: "MAERSK",
    flag: "Singapore",
    classification: "cargo",
    military: false,
    shipType: 70,
    speedKnots: 15,
    courseDeg: 90,
  },
  {
    id: "412000042",
    lat: 26.2,
    lon: 56.2,
    name: "PLA WARSHIP",
    flag: "China",
    classification: "tug_special",
    military: true,
    shipType: 35,
    speedKnots: 20,
    courseDeg: 10,
  },
];

Deno.test("vessel category filter selects by class and military flag", () => {
  const tankers = filterVessels(
    { mode: "vessel", categories: ["tanker"] },
    VESSELS,
  );
  assertEquals(tankers.map((v) => v.id), ["636019825"]);
  const military = filterVessels(
    { mode: "vessel", categories: ["military"] },
    VESSELS,
  );
  assertEquals(military.map((v) => v.id), ["412000042"]);
});

Deno.test("vessel watch_ids filter by MMSI", () => {
  const watched = filterVessels(
    { mode: "vessel", watch_ids: ["563148100"] },
    VESSELS,
  );
  assertEquals(watched.map((v) => v.id), ["563148100"]);
});

Deno.test("vessel entry statement reads like an alert with name, flag, class", () => {
  const s = composeVesselStatement(
    VESSELS[0],
    { name: "Strait of Hormuz", isWatchlist: false },
    new Date("2026-07-03T12:05:00Z"),
  );
  assertEquals(
    s,
    "Tanker DELTA (MMSI 636019825, Liberia) entered Strait of Hormuz at 12:05 UTC, course 270° at 12.4 kn.",
  );
});

Deno.test("military vessel copy names it a military vessel", () => {
  const s = composeVesselStatement(
    VESSELS[2],
    { name: "Taiwan Strait", isWatchlist: false },
    new Date("2026-07-03T12:05:00Z"),
  );
  assertEquals(
    s.startsWith(
      "Military vessel PLA WARSHIP (MMSI 412000042, China) entered Taiwan Strait",
    ),
    true,
  );
});
