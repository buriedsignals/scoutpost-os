import { assertEquals } from "jsr:@std/assert@1";
import {
  aircraftCanaryConfig,
  classifyVesselSamplerOutcome,
  modeScheduleCron,
  reAlertedObjectIds,
  samplerRunFailureMessage,
  type SamplerRunRow,
  selectFreshMalaccaVessels,
} from "./benchmark-transport.ts";

function samplerRun(overrides: Partial<SamplerRunRow>): SamplerRunRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    task: "ais",
    status: "succeeded",
    connected: true,
    provider_errored: false,
    frames_received: 12,
    items_parsed: 4,
    items_written: 4,
    error_code: null,
    error_message: null,
    ...overrides,
  };
}

Deno.test("sampler heartbeat exposes the asynchronous transport failure", () => {
  assertEquals(samplerRunFailureMessage(samplerRun({})), null);
  assertEquals(
    samplerRunFailureMessage(samplerRun({
      status: "failed",
      connected: false,
      frames_received: 0,
      items_parsed: 0,
      items_written: 0,
      error_code: "ais_not_connected",
      error_message: "AIS sample failed",
    })),
    "[ais_not_connected] AIS sampler failed: AIS sample failed; " +
      "connected=false; provider_errored=false; frames=0; parsed=0; written=0",
  );
});

Deno.test("vessel sampler diagnostics separate stale cache from empty geography", () => {
  const sampledAfter = new Date("2026-07-20T09:30:00Z");
  assertEquals(
    classifyVesselSamplerOutcome({
      newestSeenAt: null,
      sampledAfter,
      freshCandidateCount: 0,
      freshGeofenceCount: 0,
    }),
    "sampler_empty",
  );
  assertEquals(
    classifyVesselSamplerOutcome({
      newestSeenAt: "2026-07-20T09:29:59Z",
      sampledAfter,
      freshCandidateCount: 0,
      freshGeofenceCount: 0,
    }),
    "positions_stale",
  );
  assertEquals(
    classifyVesselSamplerOutcome({
      newestSeenAt: "2026-07-20T09:30:01Z",
      sampledAfter,
      freshCandidateCount: 4,
      freshGeofenceCount: 0,
    }),
    "no_geo_matches",
  );
});

Deno.test("aircraft canary follows live identities without a transient geofence", () => {
  assertEquals(aircraftCanaryConfig(["abc123"]), {
    mode: "aircraft",
    watch_ids: ["abc123"],
  });
});

Deno.test("satellite canary uses a daily schedule while other modes stay dormant", () => {
  assertEquals(modeScheduleCron("satellite"), "0 0 * * *");
  assertEquals(modeScheduleCron("vessel"), "0 0 1 1 *");
  assertEquals(modeScheduleCron("aircraft"), "0 0 1 1 *");
});

Deno.test("vessel canary selects newly sampled valid Malacca MMSIs", () => {
  const sampledAfter = new Date("2026-07-13T12:00:00Z");
  const rows = [
    {
      mmsi: "563024500",
      lat: 1.2,
      lon: 103.8,
      seen_at: "2026-07-13T12:00:01Z",
    },
    {
      mmsi: "563024500",
      lat: 1.3,
      lon: 103.7,
      seen_at: "2026-07-13T12:00:02Z",
    },
    {
      mmsi: "111111111",
      lat: 1.2,
      lon: 103.8,
      seen_at: "2026-07-13T12:00:03Z",
    },
    {
      mmsi: "247416500",
      lat: 0.9,
      lon: 103.8,
      seen_at: "2026-07-13T12:00:04Z",
    },
    {
      mmsi: "636020726",
      lat: 1.2,
      lon: 103.8,
      seen_at: "2026-07-13T11:59:59Z",
    },
    { mmsi: "566496000", lat: 6.5, lon: 98, seen_at: "2026-07-13T12:00:05Z" },
  ];

  assertEquals(
    selectFreshMalaccaVessels(rows, sampledAfter).map((row) => row.mmsi),
    ["563024500", "566496000"],
  );
});

Deno.test("steady-state audit reports only identities already baselined", () => {
  assertEquals(
    reAlertedObjectIds(["a", "b"], ["b", "c", "b"]),
    ["b"],
  );
});
