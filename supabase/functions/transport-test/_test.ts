import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ApiError, ValidationError } from "../_shared/errors.ts";
import type { AircraftObject } from "../scout-transport-execute/aircraft.ts";
import type { ResolvedGeofence } from "../scout-transport-execute/geofence.ts";
import type { GpElement } from "../scout-transport-execute/satellite.ts";
import type { VesselObject } from "../scout-transport-execute/vessel.ts";
import {
  missingAisWatchIds,
  runTransportTest,
  type TransportTestDependencies,
} from "./lib.ts";

const GEOFENCE: ResolvedGeofence = {
  kind: "circle",
  name: "Zurich",
  lat: 47.37,
  lon: 8.54,
  radiusKm: 50,
};

Deno.test("transport-test: vessel IDs must all return a current AIS position", () => {
  assertEquals(
    missingAisWatchIds(
      ["636019825", "563148100"],
      [{ mmsi: "636019825" }],
    ),
    ["563148100"],
  );
  assertEquals(
    missingAisWatchIds(
      ["636019825", "563148100"],
      [{ mmsi: "563148100" }, { mmsi: "636019825" }],
    ),
    [],
  );
});

function dependencies(
  overrides: Partial<TransportTestDependencies> = {},
): TransportTestDependencies {
  return {
    now: () => new Date("2026-07-15T08:00:00.000Z"),
    resolveGeofence: () => Promise.resolve(GEOFENCE),
    fetchAircraft: () => Promise.resolve([]),
    fetchAircraftWatchlist: () => Promise.resolve(new Set()),
    aircraftWatchlistPopulated: () => Promise.resolve(true),
    ensureVesselCoverage: () => Promise.resolve(),
    ensureGpCoverage: () => Promise.resolve(),
    fetchVessels: () => Promise.resolve([]),
    fetchElements: () => Promise.resolve([]),
    predictPasses: () => [],
    ...overrides,
  };
}

Deno.test("transport-test: validation failures use the standard validation error", async () => {
  await assertRejects(
    () => runTransportTest({ mode: "aircraft", watch_ids: [] }, dependencies()),
    ValidationError,
    "require watch_ids",
  );
});

Deno.test("transport-test: aircraft result is normalized, filtered, and compact", async () => {
  let receivedWatchIds: string[] = [];
  const aircraft = (id: string, callsign: string): AircraftObject => ({
    id,
    lat: 47,
    lon: 8,
    callsign,
    registration: null,
    aircraftType: null,
    altitudeFt: null,
    speedKts: null,
    trackDeg: null,
    military: false,
  });
  const result = await runTransportTest(
    { mode: "aircraft", watch_ids: [" ABC123 "] },
    dependencies({
      fetchAircraft: (config) => {
        receivedWatchIds = config.watch_ids ?? [];
        return Promise.resolve([
          aircraft("abc123", "MOON1"),
          aircraft("def456", "OTHER"),
          aircraft("abc123", "MOON1"),
        ]);
      },
    }),
  );

  assertEquals(receivedWatchIds, ["abc123"]);
  assertEquals(result, {
    valid: true,
    baseline_ids: ["abc123"],
    preview: [{ id: "abc123", label: "MOON1" }],
  });
});

Deno.test("transport-test: vessel result uses the runtime category filter", async () => {
  const vessel = (
    id: string,
    name: string,
    classification: VesselObject["classification"],
  ): VesselObject => ({
    id,
    lat: 47,
    lon: 8,
    name,
    flag: null,
    classification,
    military: false,
    shipType: null,
    speedKnots: null,
    courseDeg: null,
  });
  const result = await runTransportTest(
    {
      mode: "vessel",
      watch_ids: ["269123456", "269123457"],
      categories: ["cargo"],
      geofence: { center: { lat: 47, lon: 8 }, radius_km: 50 },
    },
    dependencies({
      fetchVessels: () =>
        Promise.resolve([
          vessel("269123456", "Moon Ferry", "passenger"),
          vessel("269123457", "Night Cargo", "cargo"),
        ]),
    }),
  );

  assertEquals(result.baseline_ids, ["269123457"]);
  assertEquals(result.preview, [{ id: "269123457", label: "Night Cargo" }]);
});

Deno.test("transport-test: satellite result returns stable pass state ids", async () => {
  const element: GpElement = {
    noradId: 25544,
    name: "ISS",
    omm: {},
    fetchedAt: "2026-07-15T07:00:00.000Z",
  };
  const result = await runTransportTest(
    {
      mode: "satellite",
      watch_ids: ["25544"],
      geofence: { center: { lat: 47, lon: 8 }, radius_km: 50 },
    },
    dependencies({
      fetchElements: () => Promise.resolve([element]),
      predictPasses: () => [{
        noradId: 25544,
        name: "ISS",
        startIso: "2026-07-15T08:07:12.000Z",
        endIso: "2026-07-15T08:11:00.000Z",
      }],
    }),
  );

  assertEquals(result, {
    valid: true,
    baseline_ids: ["pass:25544:2026-07-15T08:00:00.000Z"],
    preview: [{
      id: "pass:25544:2026-07-15T08:00:00.000Z",
      label: "ISS · 2026-07-15T08:07:12.000Z",
    }],
  });
});

Deno.test("transport-test: vessel preview requires live area coverage", async () => {
  const error = await assertRejects(
    () =>
      runTransportTest(
        {
          mode: "vessel",
          watch_ids: ["269123456"],
          geofence: { center: { lat: 47, lon: 8 }, radius_km: 50 },
        },
        dependencies({
          ensureVesselCoverage: () =>
            Promise.reject(
              new ApiError(
                "AIS live test could not establish a healthy sampler connection",
                503,
                "transport_data_unavailable",
              ),
            ),
        }),
      ),
    ApiError,
    "AIS live test",
  );
  assertEquals(error.status, 503);
  assertEquals(error.code, "transport_data_unavailable");
});

Deno.test("transport-test: satellite preview requires refreshed GP coverage", async () => {
  const error = await assertRejects(
    () =>
      runTransportTest(
        {
          mode: "satellite",
          watch_ids: ["25544"],
          geofence: { center: { lat: 47, lon: 8 }, radius_km: 50 },
        },
        dependencies({
          ensureGpCoverage: () =>
            Promise.reject(
              new ApiError(
                "no orbital elements cached after GP refresh",
                503,
                "transport_data_unavailable",
              ),
            ),
        }),
      ),
    ApiError,
    "after GP refresh",
  );
  assertEquals(error.status, 503);
  assertEquals(error.code, "transport_data_unavailable");
});

Deno.test("transport-test: aircraft preview rejects an unloaded required watchlist", async () => {
  let fetched = false;
  const error = await assertRejects(
    () =>
      runTransportTest(
        {
          mode: "aircraft",
          watch_ids: ["abc123"],
          categories: ["government"],
        },
        dependencies({
          aircraftWatchlistPopulated: () => Promise.resolve(false),
          fetchAircraft: () => {
            fetched = true;
            return Promise.resolve([]);
          },
        }),
      ),
    ApiError,
    "aircraft watchlist not loaded",
  );
  assertEquals(error.status, 503);
  assertEquals(error.code, "transport_data_unavailable");
  assertEquals(fetched, false);
});
