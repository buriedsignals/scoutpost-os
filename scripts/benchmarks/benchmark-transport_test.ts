import { assertEquals } from "jsr:@std/assert@1";
import {
  modeScheduleCron,
  reAlertedObjectIds,
  selectFreshMalaccaVessels,
} from "./benchmark-transport.ts";

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
