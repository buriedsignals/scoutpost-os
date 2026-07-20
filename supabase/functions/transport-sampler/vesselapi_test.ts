import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  parseVesselApiPositions,
  sampleVesselApiPositions,
  VesselApiRequestError,
} from "./vesselapi.ts";

const IDS = ["477045900", "232003239"];

Deno.test("VesselAPI parser coalesces newest valid row per requested MMSI", () => {
  const parsed = parseVesselApiPositions({
    nextToken: "next",
    vesselPositions: [
      {
        mmsi: 477045900,
        latitude: 1,
        longitude: 2,
        timestamp: "2026-07-20T10:00:00Z",
        cog: 90,
        vessel_name: "OLDER",
      },
      {
        mmsi: 477045900,
        latitude: 3,
        longitude: 4,
        timestamp: "2026-07-20T10:05:00Z",
        cog: 100,
        vessel_name: "LATEST",
      },
      {
        mmsi: 232003239,
        latitude: 5,
        longitude: 6,
        processed_timestamp: "2026-07-20T10:04:00Z",
      },
    ],
  }, IDS);
  assertEquals(parsed.rowsReceived, 3);
  assertEquals(parsed.hasMore, true);
  assertEquals(parsed.positions.length, 2);
  assertEquals(parsed.positions[0].lat, 3);
  assertEquals(parsed.positions[0].name, "LATEST");
});

Deno.test("VesselAPI parser drops glitches, invalid coordinates, and unrequested IDs", () => {
  const parsed = parseVesselApiPositions({
    vesselPositions: [
      {
        mmsi: 477045900,
        latitude: 1,
        longitude: 2,
        timestamp: "2026-07-20T10:00:00Z",
        suspected_glitch: true,
      },
      {
        mmsi: 232003239,
        latitude: 91,
        longitude: 2,
        timestamp: "2026-07-20T10:00:00Z",
      },
      {
        mmsi: 211331640,
        latitude: 1,
        longitude: 2,
        timestamp: "2026-07-20T10:00:00Z",
      },
    ],
  }, IDS);
  assertEquals(parsed.positions, []);
});

Deno.test("VesselAPI sample uses one bounded bulk request and reports missing IDs", async () => {
  let capturedUrl = "";
  let capturedAuthorization: string | null = null;
  const sample = await sampleVesselApiPositions({
    apiKey: "secret-test-key",
    watchIds: IDS,
    fetchFn: (input, init) => {
      const request = new Request(input, init);
      capturedUrl = request.url;
      capturedAuthorization = request.headers.get("authorization");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            vesselPositions: [{
              mmsi: 477045900,
              latitude: 1,
              longitude: 2,
              timestamp: "2026-07-20T10:00:00Z",
            }],
          }),
          {
            status: 200,
            headers: { "x-ratelimit-remaining": "1499" },
          },
        ),
      );
    },
  });
  assertEquals(capturedAuthorization, "Bearer secret-test-key");
  assertEquals(
    new URL(capturedUrl).searchParams.get("filter.ids"),
    IDS.join(","),
  );
  assertEquals(sample.positions.length, 1);
  assertEquals(sample.missingIds, ["232003239"]);
  assertEquals(sample.quotaRemaining, 1499);
});

Deno.test("VesselAPI auth failure has a stable sanitized category", async () => {
  await assertRejects(
    () =>
      sampleVesselApiPositions({
        apiKey: "bad-key",
        watchIds: IDS,
        fetchFn: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "invalid_api_key" },
              }),
              { status: 401 },
            ),
          ),
      }),
    VesselApiRequestError,
    "VesselAPI returned HTTP 401",
  );
  try {
    await sampleVesselApiPositions({
      apiKey: "bad-key",
      watchIds: IDS,
      fetchFn: () => Promise.resolve(new Response("{}", { status: 401 })),
    });
  } catch (error) {
    assertEquals(
      (error as VesselApiRequestError).code,
      "vesselapi_auth_failed",
    );
  }
});

Deno.test("VesselAPI network failures never expose watch IDs or credentials", async () => {
  let caught: unknown;
  try {
    await sampleVesselApiPositions({
      apiKey: "secret-test-key",
      watchIds: IDS,
      fetchFn: () =>
        Promise.reject(
          new Error(
            `request failed for filter.ids=${
              IDS.join(",")
            }&key=secret-test-key`,
          ),
        ),
    });
  } catch (error) {
    caught = error;
  }
  assertEquals(caught instanceof VesselApiRequestError, true);
  assertEquals(
    (caught as VesselApiRequestError).code,
    "vesselapi_network_error",
  );
  assertEquals(
    (caught as VesselApiRequestError).message,
    "VesselAPI network request failed",
  );
});
