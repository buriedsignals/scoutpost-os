import {
  assertEquals,
  assertLess,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  type BBox,
  coalesceFrames,
  MAX_SUBSCRIPTION_BOXES,
  parseAisFrame,
  toSubscriptionBoxes,
  unionBoxes,
} from "./ais.ts";
import { aisSubscriptionMessage, classifyAisSampleResult } from "./sampler.ts";

Deno.test("AIS sampler result classification exposes background failure modes", () => {
  assertEquals(
    classifyAisSampleResult(
      { connected: false, errored: false, frames: [] },
      0,
    ),
    "ais_not_connected",
  );
  assertEquals(
    classifyAisSampleResult({ connected: true, errored: true, frames: [] }, 0),
    "ais_websocket_error",
  );
  assertEquals(
    classifyAisSampleResult({ connected: true, errored: false, frames: [] }, 0),
    "ais_zero_frames",
  );
  assertEquals(
    classifyAisSampleResult({
      connected: true,
      errored: false,
      frames: [{}],
    }, 0),
    "ais_no_valid_positions",
  );
  assertEquals(
    classifyAisSampleResult({
      connected: true,
      errored: false,
      frames: [{}],
    }, 1),
    null,
  );
});

const fixture = JSON.parse(
  Deno.readTextFileSync(
    new URL("./fixtures/aisstream_malacca.json", import.meta.url),
  ),
) as { frames: unknown[] };

Deno.test("recorded aisstream fixture parses to positions with identity", () => {
  const parsed = fixture.frames
    .map((f) => parseAisFrame(f))
    .filter(Boolean);
  assertLess(0, parsed.length);
  for (const p of parsed) {
    assertEquals(/^\d{7,9}$/.test(p!.mmsi), true);
  }
});

Deno.test("coalesce collapses many frames to latest-per-MMSI", () => {
  const positions = coalesceFrames(fixture.frames);
  // Every result has a finite position and a unique mmsi.
  const seen = new Set<string>();
  for (const v of positions) {
    assertEquals(Number.isFinite(v.lat) && Number.isFinite(v.lon), true);
    assertEquals(seen.has(v.mmsi), false);
    seen.add(v.mmsi);
  }
  // Coalesced count never exceeds frame count.
  assertLess(positions.length - 1, fixture.frames.length);
});

Deno.test("ShipStaticData merges type/name onto a coalesced vessel", () => {
  // Synthetic: a position then static data for the same MMSI.
  const frames = [
    {
      MessageType: "PositionReport",
      Message: { PositionReport: { Latitude: 1.3, Longitude: 103.7, Cog: 90 } },
      MetaData: {
        MMSI: 563148100,
        ShipName: "MAERSK WALLIS",
        time_utc: "2026-07-03T12:00:00Z",
      },
    },
    {
      MessageType: "ShipStaticData",
      Message: { ShipStaticData: { Type: 80, Name: "MAERSK WALLIS" } },
      MetaData: { MMSI: 563148100 },
    },
  ];
  const [v] = coalesceFrames(frames);
  assertEquals(v.mmsi, "563148100");
  assertEquals(v.shipType, 80);
  assertEquals(v.classification, "tanker");
  assertEquals(v.flag, "Singapore"); // MID 563
  assertEquals(v.lat, 1.3);
});

Deno.test("coalesce drops vessels seen only via static data (no position)", () => {
  const frames = [
    {
      MessageType: "ShipStaticData",
      Message: { ShipStaticData: { Type: 70, Name: "GHOST" } },
      MetaData: { MMSI: 111222333 },
    },
  ];
  assertEquals(coalesceFrames(frames).length, 0);
});

Deno.test("live Fleet test narrows the global AIS subscription to watched MMSIs", () => {
  assertEquals(
    aisSubscriptionMessage({
      apiKey: "test-key",
      boxes: [[[-90, -180], [90, 180]]],
      shipMmsi: ["636019825", "563148100"],
    }),
    {
      APIKey: "test-key",
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FiltersShipMMSI: ["636019825", "563148100"],
      FilterMessageTypes: [
        "PositionReport",
        "StandardClassBPositionReport",
        "ShipStaticData",
      ],
    },
  );
});

Deno.test("unionBoxes merges overlapping scout areas to a fixed point", () => {
  const boxes: BBox[] = [
    { minLat: 0, minLon: 0, maxLat: 2, maxLon: 2 },
    { minLat: 1, minLon: 1, maxLat: 3, maxLon: 3 }, // overlaps #1
    { minLat: 10, minLon: 10, maxLat: 11, maxLon: 11 }, // disjoint
  ];
  const merged = unionBoxes(boxes);
  assertEquals(merged.length, 2);
  const big = merged.find((b) => b.maxLat === 3)!;
  assertEquals(big.minLat, 0);
  assertEquals(big.maxLon, 3);
});

Deno.test("disjoint boxes are never merged", () => {
  const boxes: BBox[] = [
    { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
    { minLat: 5, minLon: 5, maxLat: 6, maxLon: 6 },
  ];
  assertEquals(unionBoxes(boxes).length, 2);
});

Deno.test("subscription box format is [[minLat,minLon],[maxLat,maxLon]]", () => {
  const subs = toSubscriptionBoxes([
    { minLat: 25.5, minLon: 55, maxLat: 27.5, maxLon: 57.5 },
  ]);
  assertEquals(subs, [[[25.5, 55], [27.5, 57.5]]]);
});

Deno.test("MAX_SUBSCRIPTION_BOXES is a conservative bound", () => {
  assertEquals(MAX_SUBSCRIPTION_BOXES, 10);
});

import { fitToBoxLimit } from "./ais.ts";

Deno.test("fitToBoxLimit coarsens without dropping coverage (superset)", () => {
  // 12 disjoint tiny boxes → must reduce to ≤10, and every original box
  // must be contained in some result box.
  const boxes: BBox[] = Array.from({ length: 12 }, (_, i) => ({
    minLat: i * 2,
    minLon: i * 2,
    maxLat: i * 2 + 1,
    maxLon: i * 2 + 1,
  }));
  const fitted = fitToBoxLimit(boxes, 10);
  assertEquals(fitted.length <= 10, true);
  for (const orig of boxes) {
    const covered = fitted.some((f) =>
      f.minLat <= orig.minLat && f.maxLat >= orig.maxLat &&
      f.minLon <= orig.minLon && f.maxLon >= orig.maxLon
    );
    assertEquals(covered, true);
  }
});

Deno.test("fitToBoxLimit is a no-op within the limit", () => {
  const boxes: BBox[] = [
    { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
    { minLat: 5, minLon: 5, maxLat: 6, maxLon: 6 },
  ];
  assertEquals(fitToBoxLimit(boxes, 10).length, 2);
});

Deno.test("coalesce keeps the newest position on out-of-order frames", () => {
  const mk = (lat: number, t: string) => ({
    MessageType: "PositionReport",
    Message: { PositionReport: { Latitude: lat, Longitude: 100 } },
    MetaData: { MMSI: 563000001, time_utc: t },
  });
  // Newer (T2) arrives BEFORE older (T1) — the older must not clobber it.
  const [v] = coalesceFrames([
    mk(5.0, "2026-07-03T12:05:00Z"),
    mk(4.0, "2026-07-03T12:00:00Z"),
  ]);
  assertEquals(v.lat, 5.0);
  assertEquals(v.seenAt, "2026-07-03T12:05:00.000Z");
});

Deno.test("AIS not-available sentinels are dropped, not rendered", () => {
  const [v] = coalesceFrames([{
    MessageType: "PositionReport",
    Message: {
      PositionReport: {
        Latitude: 1.3,
        Longitude: 103.7,
        Sog: 102.3, // not available
        Cog: 360, // not available
        TrueHeading: 511, // not available
        NavigationalStatus: 15, // not defined
      },
    },
    MetaData: { MMSI: 563000002, time_utc: "2026-07-03T12:00:00Z" },
  }]);
  assertEquals(v.speedKnots, null);
  assertEquals(v.course, null);
  assertEquals(v.heading, null);
  assertEquals(v.navStatus, null);
});
