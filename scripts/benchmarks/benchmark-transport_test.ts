import { assertEquals } from "jsr:@std/assert@1";
import {
  aircraftCanaryConfig,
  modeScheduleCron,
  reAlertedObjectIds,
  samplerRunFailureMessage,
  type SamplerRunRow,
  selectedTransportModes,
  selectRuntimeFreshVessels,
  vesselCanaryConfig,
} from "./benchmark-transport.ts";

Deno.test("weekly transport benchmark can report each mode independently", () => {
  assertEquals(selectedTransportModes([]), ["aircraft", "vessel", "satellite"]);
  assertEquals(selectedTransportModes(["--mode", "vessel"]), ["vessel"]);
  assertEquals(
    selectedTransportModes(["--mode=aircraft", "--mode=satellite"]),
    ["aircraft", "satellite"],
  );
});

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
    started_at: "2026-08-03T10:25:00Z",
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
      error_code: "vesselapi_timeout",
      error_message: "VesselAPI request exceeded its connection deadline",
    })),
    "[vesselapi_timeout] vessel sampler failed: VesselAPI request exceeded its connection deadline; " +
      "connected=false; provider_errored=false; rows=0; parsed=0; written=0",
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

Deno.test("vessel canary accepts provider positions refreshed by this sample", () => {
  const sampledAfter = new Date("2026-08-03T10:25:00Z");
  const now = new Date("2026-08-03T10:26:00Z");
  const rows = [
    {
      mmsi: "563024500",
      lat: 1.2,
      lon: 103.8,
      seen_at: "2026-08-03T10:21:33Z",
      updated_at: "2026-08-03T10:25:09Z",
    },
    {
      mmsi: "563024500",
      lat: 1.3,
      lon: 103.7,
      seen_at: "2026-08-03T10:22:00Z",
      updated_at: "2026-08-03T10:25:10Z",
    },
    {
      mmsi: "111111111",
      lat: 1.2,
      lon: 103.8,
      seen_at: "2026-08-03T10:24:00Z",
      updated_at: "2026-08-03T10:25:11Z",
    },
    {
      mmsi: "247416500",
      lat: 51,
      lon: 1.5,
      seen_at: "2026-08-03T10:24:00Z",
      updated_at: "2026-08-03T10:24:59Z",
    },
    {
      mmsi: "636020726",
      lat: 35.9,
      lon: -5.5,
      seen_at: "2026-08-03T08:20:59Z",
      updated_at: "2026-08-03T10:25:12Z",
    },
  ];

  assertEquals(
    selectRuntimeFreshVessels(rows, sampledAfter, now).map((row) => row.mmsi),
    ["563024500"],
  );
});

Deno.test("vessel canary centers its geofence on the sampled vessel", () => {
  assertEquals(
    vesselCanaryConfig({
      mmsi: "563024500",
      lat: 1.2,
      lon: 103.8,
      seen_at: "2026-08-03T10:21:33Z",
      updated_at: "2026-08-03T10:25:09Z",
    }),
    {
      mode: "vessel",
      geofence: { center: { lat: 1.2, lon: 103.8 }, radius_km: 25 },
      watch_ids: ["563024500"],
    },
  );
});

Deno.test("steady-state audit reports only identities already baselined", () => {
  assertEquals(
    reAlertedObjectIds(["a", "b"], ["b", "c", "b"]),
    ["b"],
  );
});
