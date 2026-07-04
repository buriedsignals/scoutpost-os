import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  AIRCRAFT_MAX_RADIUS_KM,
  normalizeTransportWatchId,
  validateTransportConfig,
  watchIdError,
} from "./transport_config.ts";

Deno.test("transport config accepts a preset geofence (with watch_ids)", () => {
  const result = validateTransportConfig({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    watch_ids: ["636019825"],
  });
  assertEquals(result.error, null);
  assertEquals(result.config?.mode, "vessel");
});

Deno.test("transport config accepts center + radius (with watch_ids)", () => {
  const result = validateTransportConfig({
    mode: "aircraft",
    geofence: { center: { lat: 51.0, lon: 1.5 }, radius_km: 200 },
    watch_ids: ["4ca123"],
  });
  assertEquals(result.error, null);
});

Deno.test("aircraft config accepts watch_ids without a geofence", () => {
  const result = validateTransportConfig({
    mode: "aircraft",
    watch_ids: ["4ca123"],
  });
  assertEquals(result.error, null);
  assertEquals(result.config?.watch_ids, ["4ca123"]);
});

Deno.test("watch_ids are mandatory — area-only and categories-only scouts are rejected", () => {
  // Vessel with geofence but no watch_ids → firehose, rejected.
  const vessel = validateTransportConfig({
    mode: "vessel",
    geofence: { preset_id: "strait-of-malacca" },
  });
  assertExists(vessel.error);
  assertStringIncludes(vessel.error!, "require watch_ids");
  assertStringIncludes(vessel.error!, "MMSIs");
  // Aircraft with geofence only → same.
  const aircraft = validateTransportConfig({
    mode: "aircraft",
    geofence: { center: { lat: 26, lon: 56 }, radius_km: 100 },
  });
  assertExists(aircraft.error);
  assertStringIncludes(aircraft.error!, "require watch_ids");
  // Categories cannot substitute for watch_ids ("all military ships" is
  // overkill, not monitoring).
  const catsOnly = validateTransportConfig({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    categories: ["military"],
  });
  assertExists(catsOnly.error);
  assertStringIncludes(catsOnly.error!, "cannot replace");
});

Deno.test("multiple watch_ids in one scout are supported", () => {
  const result = validateTransportConfig({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    watch_ids: ["636019825", "244660123", "563012345", "477123456", "273456789"],
  });
  assertEquals(result.error, null);
  assertEquals(result.config?.watch_ids?.length, 5);
});

Deno.test("categories narrow a watch list; unknown categories are rejected per mode", () => {
  // Valid: watch_ids + a real category.
  const ok = validateTransportConfig({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    watch_ids: ["636019825"],
    categories: ["military"],
  });
  assertEquals(ok.error, null);
  // Typo'd category would silently match nothing — rejected.
  const typo = validateTransportConfig({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    watch_ids: ["636019825"],
    categories: ["militry"],
  });
  assertExists(typo.error);
  assertStringIncludes(typo.error!, 'unknown vessel category "militry"');
  // "yacht" is not a classifier output — the real class is "pleasure".
  const yacht = validateTransportConfig({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    watch_ids: ["636019825"],
    categories: ["yacht"],
  });
  assertExists(yacht.error);
  const pleasure = validateTransportConfig({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    watch_ids: ["636019825"],
    categories: ["pleasure"],
  });
  assertEquals(pleasure.error, null);
  // Satellites have no categories at all.
  const sat = validateTransportConfig({
    mode: "satellite",
    geofence: { preset_id: "strait-of-hormuz" },
    watch_ids: ["25544"],
    categories: ["military"],
  });
  assertExists(sat.error);
  assertStringIncludes(sat.error!, "do not support categories");
});

Deno.test("satellite config requires BOTH watch_ids and a geofence", () => {
  // Both present → ok.
  const ok = validateTransportConfig({
    mode: "satellite",
    watch_ids: ["39084"],
    geofence: { preset_id: "strait-of-hormuz" },
  });
  assertEquals(ok.error, null);
  // watch_ids only → rejected (needs an area).
  const noGeo = validateTransportConfig({
    mode: "satellite",
    watch_ids: ["39084"],
  });
  assertExists(noGeo.error);
  assertStringIncludes(noGeo.error!, "geofence");
  // geofence only → rejected (needs which satellites).
  const noIds = validateTransportConfig({
    mode: "satellite",
    geofence: { preset_id: "strait-of-hormuz" },
  });
  assertExists(noIds.error);
  assertStringIncludes(noIds.error!, "watch_ids");
});

Deno.test("transport config rejects a missing mode", () => {
  const result = validateTransportConfig({});
  assertExists(result.error);
  assertStringIncludes(result.error!, "mode");
});

Deno.test("a bare mode with no scope at all is rejected", () => {
  const result = validateTransportConfig({ mode: "vessel" });
  assertExists(result.error);
  assertStringIncludes(result.error!, "require watch_ids");
});

Deno.test("transport config rejects preset + circle together", () => {
  const result = validateTransportConfig({
    mode: "vessel",
    geofence: {
      preset_id: "strait-of-hormuz",
      center: { lat: 26, lon: 56 },
      radius_km: 100,
    },
  });
  assertExists(result.error);
  assertStringIncludes(result.error!, "not both");
});

Deno.test("transport config rejects an empty geofence object", () => {
  const result = validateTransportConfig({ mode: "vessel", geofence: {} });
  assertExists(result.error);
  assertStringIncludes(result.error!, "preset_id or center + radius_km");
});

Deno.test("transport config caps aircraft geofence radius at the ADS-B query limit", () => {
  const result = validateTransportConfig({
    mode: "aircraft",
    geofence: {
      center: { lat: 26, lon: 56 },
      radius_km: AIRCRAFT_MAX_RADIUS_KM + 1,
    },
  });
  assertExists(result.error);
  assertStringIncludes(result.error!, "250 nm");

  const vessel = validateTransportConfig({
    mode: "vessel",
    geofence: {
      center: { lat: 26, lon: 56 },
      radius_km: AIRCRAFT_MAX_RADIUS_KM + 1,
    },
    watch_ids: ["636019825"],
  });
  assertEquals(vessel.error, null);
});

Deno.test("transport config rejects out-of-range coordinates", () => {
  const result = validateTransportConfig({
    mode: "vessel",
    geofence: { center: { lat: 91, lon: 0 }, radius_km: 50 },
  });
  assertExists(result.error);
});

Deno.test("vessel watch ids must be ship-station MMSIs", () => {
  assertEquals(watchIdError("vessel", "636019825"), null);
  assertExists(watchIdError("vessel", "111111111")); // aircraft MID range
  assertExists(watchIdError("vessel", "000000000"));
  assertExists(watchIdError("vessel", "12345"));
});

Deno.test("aircraft watch ids must be 24-bit ICAO hex; TIS-B rejected", () => {
  assertEquals(watchIdError("aircraft", "4CA123"), null); // case-insensitive
  assertEquals(watchIdError("aircraft", "ae01ce"), null);
  assertExists(watchIdError("aircraft", "~ae01ce")); // TIS-B pseudo-address
  assertExists(watchIdError("aircraft", "ZZZZZZ"));
  assertExists(watchIdError("aircraft", "ae01c"));
});

Deno.test("satellite watch ids must be NORAD catalog numbers", () => {
  assertEquals(watchIdError("satellite", "25544"), null);
  assertEquals(watchIdError("satellite", "270112"), null); // 6-digit post-rollover
  assertExists(watchIdError("satellite", "0"));
  assertExists(watchIdError("satellite", "iss"));
});

Deno.test("watch ids are normalized to lowercase in the validated config", () => {
  assertEquals(normalizeTransportWatchId("  4CA123 "), "4ca123");
  const result = validateTransportConfig({
    mode: "aircraft",
    watch_ids: ["4CA123", "AE01CE"],
  });
  assertEquals(result.error, null);
  assertEquals(result.config?.watch_ids, ["4ca123", "ae01ce"]);
});

Deno.test("blank criteria is normalized away", () => {
  const result = validateTransportConfig({
    mode: "vessel",
    geofence: { preset_id: "strait-of-hormuz" },
    watch_ids: ["636019825"],
    criteria: "   ",
  });
  assertEquals(result.error, null);
  assertEquals(result.config?.criteria, undefined);
});
