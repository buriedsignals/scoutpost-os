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

Deno.test("VesselAPI sample follows pagination until all watched MMSIs are found", async () => {
  const requestedTokens: Array<string | null> = [];
  let calls = 0;
  const sample = await sampleVesselApiPositions({
    apiKey: "secret-test-key",
    watchIds: IDS,
    fetchFn: (input) => {
      const requestUrl = new URL(String(input));
      requestedTokens.push(requestUrl.searchParams.get("pagination.nextToken"));
      calls++;
      const mmsi = calls === 1 ? IDS[0] : IDS[1];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            nextToken: calls === 1 ? "page-2" : undefined,
            vesselPositions: [{
              mmsi,
              latitude: calls,
              longitude: calls + 1,
              timestamp: `2026-07-20T10:0${calls}:00Z`,
            }],
          }),
          {
            status: 200,
            headers: {
              "x-ratelimit-remaining": calls === 1 ? "1499" : "1497",
            },
          },
        ),
      );
    },
  });
  assertEquals(calls, 2);
  assertEquals(requestedTokens, [null, "page-2"]);
  assertEquals(sample.positions.map((position) => position.mmsi), IDS);
  assertEquals(sample.missingIds, []);
  assertEquals(sample.hasMore, false);
  assertEquals(sample.quotaRemaining, 1497);
});

Deno.test("VesselAPI sample stops early when the first page covers every MMSI", async () => {
  let calls = 0;
  const sample = await sampleVesselApiPositions({
    apiKey: "secret-test-key",
    watchIds: IDS,
    fetchFn: () => {
      calls++;
      return Promise.resolve(
        Response.json({
          nextToken: "unused-page-2",
          vesselPositions: IDS.map((mmsi, index) => ({
            mmsi,
            latitude: index + 1,
            longitude: index + 2,
            timestamp: `2026-07-20T10:0${index}:00Z`,
          })),
        }),
      );
    },
  });
  assertEquals(calls, 1);
  assertEquals(sample.missingIds, []);
  assertEquals(sample.hasMore, true);
});

Deno.test("VesselAPI sample stops after five pages with pagination remaining", async () => {
  const requestedTokens: Array<string | null> = [];
  const sample = await sampleVesselApiPositions({
    apiKey: "secret-test-key",
    watchIds: IDS,
    fetchFn: (input) => {
      const requestUrl = new URL(String(input));
      requestedTokens.push(requestUrl.searchParams.get("pagination.nextToken"));
      return Promise.resolve(
        Response.json({
          nextToken: `page-${requestedTokens.length + 1}`,
          vesselPositions: [],
        }),
      );
    },
  });
  assertEquals(requestedTokens, [null, "page-2", "page-3", "page-4", "page-5"]);
  assertEquals(sample.positions, []);
  assertEquals(sample.missingIds, IDS);
  assertEquals(sample.hasMore, true);
});

Deno.test("VesselAPI sample does not retry a later-page HTTP error", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      sampleVesselApiPositions({
        apiKey: "secret-test-key",
        watchIds: IDS,
        fetchFn: () => {
          calls++;
          if (calls === 1) {
            return Promise.resolve(
              Response.json({
                nextToken: "page-2",
                vesselPositions: [],
              }),
            );
          }
          return Promise.resolve(
            Response.json(
              { error: { code: "rate_limit_exceeded" } },
              { status: 429 },
            ),
          );
        },
      }),
    VesselApiRequestError,
    "VesselAPI returned HTTP 429",
  );
  assertEquals(calls, 2);
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
