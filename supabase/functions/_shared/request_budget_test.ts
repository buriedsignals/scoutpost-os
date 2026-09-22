import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRequestBudget } from "./request_budget.ts";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

Deno.test("a fresh budget offers its whole span and shrinks as time passes", () => {
  const c = clock();
  const budget = createRequestBudget({ totalMs: 120_000, now: c.now });
  assertEquals(budget.remainingMs(), 120_000);
  c.advance(45_000);
  assertEquals(budget.remainingMs(), 75_000);
  c.advance(100_000);
  assertEquals(budget.remainingMs(), 0, "never negative");
});

Deno.test("a stage may start only while remaining time covers its reserve and floor", () => {
  const c = clock();
  const budget = createRequestBudget({ totalMs: 60_000, now: c.now });
  assertEquals(budget.canStart({ reserveMs: 25_000, floorMs: 15_000 }), true);
  c.advance(21_000); // 39s left: 39 - 25 = 14 < 15
  assertEquals(budget.canStart({ reserveMs: 25_000, floorMs: 15_000 }), false);
  assertEquals(budget.exhausted, true, "a refused start marks the budget exhausted");
});

Deno.test("timeouts are the smaller of the default and what is left after the reserve", () => {
  const c = clock();
  const budget = createRequestBudget({ totalMs: 60_000, now: c.now });
  assertEquals(budget.timeoutFor(120_000, { reserveMs: 25_000 }), 35_000);
  assertEquals(budget.timeoutFor(10_000, { reserveMs: 25_000 }), 10_000);
  c.advance(50_000); // 10s left, reserve 25s
  assertEquals(budget.timeoutFor(120_000, { reserveMs: 25_000 }), 0);
});

Deno.test("elapsed time is reported for diagnostics", () => {
  const c = clock();
  const budget = createRequestBudget({ totalMs: 60_000, now: c.now });
  c.advance(12_345);
  assertEquals(budget.elapsedMs(), 12_345);
});
