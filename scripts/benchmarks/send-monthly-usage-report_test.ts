import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { reportQuery } from "./send-monthly-usage-report.ts";

Deno.test("reportQuery defaults to current monthly recipients", () => {
  const query = reportQuery([]);
  assertEquals(query.get("recipients"), "monthly");
  assertEquals(query.get("period"), "current");
});

Deno.test("reportQuery supports previous period", () => {
  const query = reportQuery(["--previous"]);
  assertEquals(query.get("recipients"), "monthly");
  assertEquals(query.get("period"), "previous");
});

Deno.test("reportQuery supports explicit year and month", () => {
  const query = reportQuery(["--year=2026", "--month", "5"]);
  assertEquals(query.get("recipients"), "monthly");
  assertEquals(query.get("year"), "2026");
  assertEquals(query.get("month"), "5");
  assertEquals(query.has("period"), false);
});

Deno.test("reportQuery requires year and month together", () => {
  assertThrows(
    () => reportQuery(["--year=2026"]),
    Error,
    "--year and --month",
  );
});
