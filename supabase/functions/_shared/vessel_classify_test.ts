import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyByAisType,
  flagFromMmsi,
  isMilitaryAisType,
} from "./vessel_classify.ts";

Deno.test("ITU ship-type ranges classify correctly", () => {
  assertEquals(classifyByAisType(80), "tanker");
  assertEquals(classifyByAisType(89), "tanker");
  assertEquals(classifyByAisType(70), "cargo");
  assertEquals(classifyByAisType(69), "passenger");
  assertEquals(classifyByAisType(60), "passenger");
  assertEquals(classifyByAisType(30), "fishing");
  assertEquals(classifyByAisType(37), "pleasure");
  assertEquals(classifyByAisType(45), "hsc");
  assertEquals(classifyByAisType(52), "tug_special");
  assertEquals(classifyByAisType(0), "unknown");
  assertEquals(classifyByAisType(null), "unknown");
  assertEquals(classifyByAisType(99), "other");
});

Deno.test("military is AIS ship-type 35", () => {
  assertEquals(isMilitaryAisType(35), true);
  assertEquals(isMilitaryAisType(80), false);
  assertEquals(isMilitaryAisType(null), false);
  // 35 is not a tanker/cargo class; it falls into tug_special by range but
  // the military flag is what the filter keys on.
  assertEquals(classifyByAisType(35), "tug_special");
});

Deno.test("flag resolves from MMSI Maritime Identification Digits", () => {
  assertEquals(flagFromMmsi("563148100"), "Singapore"); // 563
  assertEquals(flagFromMmsi("636019825"), "Liberia"); // 636
  assertEquals(flagFromMmsi("412000001"), "China"); // 412
  assertEquals(flagFromMmsi(338123456), "United States"); // 338, numeric input
  assertEquals(flagFromMmsi("999999999"), null); // unknown MID
  assertEquals(flagFromMmsi("12345"), null); // malformed
  assertEquals(flagFromMmsi(null), null);
});
