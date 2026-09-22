import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createRequestBudget } from "../_shared/request_budget.ts";
import type { ScrapeOptions, ScrapeResult } from "../_shared/scrape_types.ts";
import { scrapeWithinBudget } from "./budget_stage.ts";

function clock(start = 5_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function result(url: string): ScrapeResult {
  return {
    markdown: `# ${url}`,
    source_url: url,
    title: url,
    fetched_at: "2026-09-22T08:00:00Z",
  } as ScrapeResult;
}

const hits = ["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://d.test/4"]
  .map((url) => ({ url, title: url, snippet: "" }));

Deno.test("with time to spare every source is scraped and nothing is skipped", async () => {
  const c = clock();
  const seen: ScrapeOptions[] = [];
  const out = await scrapeWithinBudget(hits, {
    budget: createRequestBudget({ totalMs: 120_000, now: c.now }),
    concurrency: 2,
    defaultTimeoutMs: 30_000,
    reserveMs: 25_000,
    floorMs: 15_000,
    scrape: (url, opts) => {
      seen.push(opts);
      return Promise.resolve(result(url));
    },
  });
  assertEquals(out.results.map((r) => r?.source_url), hits.map((h) => h.url));
  assertEquals(out.attempted, hits.map((h) => h.url));
  assertEquals(out.skipped, 0);
  assertEquals(out.budgetExhausted, false);
  assertEquals(seen.every((o) => o.timeoutMs === 30_000), true, "default timeout when time is plentiful");
});

Deno.test("when the budget runs low the remaining sources are skipped, not attempted", async () => {
  const c = clock();
  let calls = 0;
  const out = await scrapeWithinBudget(hits, {
    budget: createRequestBudget({ totalMs: 60_000, now: c.now }),
    concurrency: 1,
    defaultTimeoutMs: 30_000,
    reserveMs: 25_000,
    floorMs: 15_000,
    scrape: (url) => {
      calls++;
      c.advance(12_000); // each scrape costs 12s; after two, 36s left → 36-25=11 < 15
      return Promise.resolve(result(url));
    },
  });
  assertEquals(calls, 2);
  assertEquals(out.attempted, hits.slice(0, 2).map((h) => h.url));
  assertEquals(out.results.length, 2);
  assertEquals(out.skipped, 2);
  assertEquals(out.budgetExhausted, true);
});

Deno.test("each scrape's timeout is bounded by the time left after the reserve", async () => {
  const c = clock();
  const timeouts: number[] = [];
  await scrapeWithinBudget(hits.slice(0, 2), {
    budget: createRequestBudget({ totalMs: 60_000, now: c.now }),
    concurrency: 1,
    defaultTimeoutMs: 120_000,
    reserveMs: 25_000,
    floorMs: 5_000,
    scrape: (url, opts) => {
      timeouts.push(opts.timeoutMs ?? -1);
      c.advance(10_000);
      return Promise.resolve(result(url));
    },
  });
  assertEquals(timeouts, [35_000, 25_000]);
});

Deno.test("a failed scrape is a null result, counted as attempted, never as skipped", async () => {
  const c = clock();
  const out = await scrapeWithinBudget(hits.slice(0, 2), {
    budget: createRequestBudget({ totalMs: 120_000, now: c.now }),
    concurrency: 2,
    defaultTimeoutMs: 30_000,
    reserveMs: 25_000,
    floorMs: 15_000,
    scrape: (url) =>
      url.includes("a.test")
        ? Promise.reject(new Error("blocked"))
        : Promise.resolve(result(url)),
  });
  assertEquals(out.results[0], null);
  assertEquals(out.results[1]?.source_url, "https://b.test/2");
  assertEquals(out.attempted.length, 2);
  assertEquals(out.skipped, 0);
  assertEquals(out.budgetExhausted, false);
});

Deno.test("concurrency is honoured", async () => {
  const c = clock();
  let inFlight = 0;
  let peak = 0;
  await scrapeWithinBudget(hits, {
    budget: createRequestBudget({ totalMs: 120_000, now: c.now }),
    concurrency: 2,
    defaultTimeoutMs: 30_000,
    reserveMs: 25_000,
    floorMs: 15_000,
    scrape: async (url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return result(url);
    },
  });
  assertEquals(peak, 2);
});
