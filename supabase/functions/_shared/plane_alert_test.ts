import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CMPG_CATEGORY,
  licenseTextIsOdbl,
  parsePlaneAlertCsv,
} from "./plane_alert.ts";

const HEADER =
  "$ICAO,$Registration,$Operator,$Type,$ICAO Type,#CMPG,$Tag 1,$#Tag 2,$#Tag 3,Category,$#Link";

Deno.test("parsePlaneAlertCsv maps CMPG groups to categories", () => {
  const csv = [
    HEADER,
    "43c6e2,ZZ338,Royal Air Force,A332,A332,Mil,t1,t2,t3,RAF,https://x",
    "00412d,Z-WPF,Air Zimbabwe,B767,B762,Gov,t1,t2,t3,Dictator Alert,https://y",
    "abc123,N123,Some PD,H60,H60,Pol,t1,t2,t3,Police Forces,https://z",
  ].join("\n");
  const rows = parsePlaneAlertCsv(csv);
  assertEquals(rows.length, 3);
  assertEquals(rows[0].ident, "43c6e2");
  assertEquals(rows[0].category, "military");
  assertEquals(rows[0].name, "Royal Air Force");
  assertEquals(rows[1].category, "government");
  assertEquals(rows[2].category, "police");
  assertEquals(
    rows[0].metadata.license,
    "ODbL-1.0 / DbCL-1.0 (sdr-enthusiasts/plane-alert-db)",
  );
});

Deno.test("parsePlaneAlertCsv drops bad hexes and unknown groups", () => {
  const csv = [
    HEADER,
    "ZZZZZZ,r,op,t,it,Mil,a,b,c,Cat,l", // bad hex
    "4ca123,r,op,t,it,Xyz,a,b,c,Cat,l", // unknown CMPG
    "4ca124,r,op,t,it,Civ,a,b,c,Cat,l", // ok
  ].join("\n");
  const rows = parsePlaneAlertCsv(csv);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ident, "4ca124");
  assertEquals(rows[0].category, "civil");
});

Deno.test("CMPG_CATEGORY covers the four upstream group codes", () => {
  assertEquals(Object.keys(CMPG_CATEGORY).sort(), ["Civ", "Gov", "Mil", "Pol"]);
});

Deno.test("licenseTextIsOdbl requires both ODbL and DbCL mentions", () => {
  assertEquals(
    licenseTextIsOdbl(
      "Made available under the Open Database License; contents under Database Contents License.",
    ),
    true,
  );
  assertEquals(licenseTextIsOdbl("Now MIT licensed."), false);
  assertEquals(licenseTextIsOdbl("Open Database License only"), false);
});

import { splitCsvLine } from "./plane_alert.ts";

Deno.test("splitCsvLine honors quoted comma-containing fields", () => {
  assertEquals(splitCsvLine("a,b,c"), ["a", "b", "c"]);
  // A quoted $Link field containing a comma must stay one field.
  assertEquals(
    splitCsvLine('43c6e2,ZZ,"Op, Inc",A332'),
    ["43c6e2", "ZZ", "Op, Inc", "A332"],
  );
  // Escaped double-quote inside a quoted field.
  assertEquals(splitCsvLine('x,"he said ""hi""",z'), [
    "x",
    'he said "hi"',
    "z",
  ]);
});

Deno.test("parsePlaneAlertCsv keeps correct columns when $Link is quoted", () => {
  const csv = [
    HEADER,
    '43c6e2,ZZ338,Royal Air Force,A332,A332,Mil,t1,t2,t3,RAF,"https://x.test/path,with,commas"',
  ].join("\n");
  const rows = parsePlaneAlertCsv(csv);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].ident, "43c6e2"); // not shifted by the quoted commas
  assertEquals(rows[0].category, "military");
  assertEquals(rows[0].metadata.link, "https://x.test/path,with,commas");
});
