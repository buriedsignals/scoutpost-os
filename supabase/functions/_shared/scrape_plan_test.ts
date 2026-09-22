import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  noteFallbackRescue,
  notePrimarySuccess,
  policyEnforced,
  resetScrapePlanMemo,
  resolveScrapePlan,
  scrapeHost,
  type ScrapeHostPolicy,
  type ScrapePlanDeps,
} from "./scrape_plan.ts";

const NOW = Date.parse("2026-09-22T08:06:00Z");

function policy(expiresAt: string | null, evidence = 3): ScrapeHostPolicy {
  return {
    host: "www.npcc.police.uk",
    primary_provider: "firecrawl",
    reason: "anti_bot",
    evidence_count: evidence,
    expires_at: expiresAt,
  };
}

function deps(
  stored: ScrapeHostPolicy | null,
  overrides: Partial<ScrapePlanDeps> = {},
) {
  const calls = { reads: 0, records: [] as string[], clears: [] as string[] };
  const d: ScrapePlanDeps = {
    readPolicy: (_host) => {
      calls.reads++;
      return Promise.resolve(stored);
    },
    recordBlock: (host, reason) => {
      calls.records.push(`${host}:${reason}`);
      return Promise.resolve();
    },
    clearBlock: (host) => {
      calls.clears.push(host);
      return Promise.resolve();
    },
    now: () => NOW,
    compatibilityMode: () => false,
    firecrawlConfigured: () => true,
    ...overrides,
  };
  return { d, calls };
}

Deno.test("scrapeHost lowercases and rejects unusable hosts", () => {
  assertEquals(
    scrapeHost("https://WWW.NPCC.police.uk/a?b=c"),
    "www.npcc.police.uk",
  );
  assertEquals(scrapeHost("not a url"), null);
});

Deno.test("an enforced host policy routes straight to Firecrawl", async () => {
  resetScrapePlanMemo();
  const { d, calls } = deps(policy("2026-10-06T00:00:00Z"));
  const plan = await resolveScrapePlan("https://www.npcc.police.uk/x", d);
  assertEquals(plan.providers, ["firecrawl"]);
  assertEquals(plan.skipPrimary, true);
  assertEquals(calls.reads, 1);
});

Deno.test("expired or evidence-only rows keep the static order but stay visible", async () => {
  resetScrapePlanMemo();
  for (const stored of [policy("2026-09-01T00:00:00Z"), policy(null, 2)]) {
    resetScrapePlanMemo();
    const { d } = deps(stored);
    const plan = await resolveScrapePlan("https://www.npcc.police.uk/x", d);
    assertEquals(plan.providers, ["crawl4ai", "firecrawl"]);
    assertEquals(plan.skipPrimary, false);
    assertEquals(plan.policy, stored);
  }
  assertEquals(policyEnforced(policy("garbage"), NOW), false);
});

Deno.test("no Firecrawl key or compatibility mode never consults host memory", async () => {
  resetScrapePlanMemo();
  const noKey = deps(policy("2026-10-06T00:00:00Z"), {
    firecrawlConfigured: () => false,
  });
  assertEquals(
    (await resolveScrapePlan("https://www.npcc.police.uk/x", noKey.d))
      .providers,
    ["crawl4ai"],
  );
  assertEquals(noKey.calls.reads, 0);
  const compat = deps(policy("2026-10-06T00:00:00Z"), {
    compatibilityMode: () => true,
  });
  assertEquals(
    (await resolveScrapePlan("https://www.npcc.police.uk/x", compat.d))
      .providers,
    ["firecrawl"],
  );
  assertEquals(compat.calls.reads, 0);
});

Deno.test("host lookups are memoised for five minutes and invalidated by bookkeeping", async () => {
  resetScrapePlanMemo();
  const { d, calls } = deps(null);
  await resolveScrapePlan("https://example.test/a", d);
  await resolveScrapePlan("https://example.test/b", d);
  assertEquals(calls.reads, 1);
  await noteFallbackRescue("example.test", "anti_bot", d);
  assertEquals(calls.records, ["example.test:anti_bot"]);
  await resolveScrapePlan("https://example.test/c", d);
  assertEquals(calls.reads, 2);
  await noteFallbackRescue("example.test", "timeout_exhausted", d);
  assertEquals(calls.records, [
    "example.test:anti_bot",
    "example.test:timeout",
  ]);
  const later = { ...d, now: () => NOW + 6 * 60_000 };
  await resolveScrapePlan("https://example.test/d", later);
  assertEquals(calls.reads, 3);
});

Deno.test("primary success clears only hosts that have a stored row, and bookkeeping never throws", async () => {
  resetScrapePlanMemo();
  const { d, calls } = deps(null);
  await notePrimarySuccess(
    {
      host: "example.test",
      providers: ["crawl4ai"],
      policy: null,
      skipPrimary: false,
    },
    d,
  );
  assertEquals(calls.clears, []);
  await notePrimarySuccess(
    {
      host: "example.test",
      providers: ["crawl4ai", "firecrawl"],
      policy: policy("2026-09-01T00:00:00Z"),
      skipPrimary: false,
    },
    d,
  );
  assertEquals(calls.clears, ["example.test"]);
  const failing = deps(null, {
    recordBlock: () => Promise.reject(new Error("db down")),
    clearBlock: () => Promise.reject(new Error("db down")),
  });
  await noteFallbackRescue("example.test", "anti_bot", failing.d);
  await notePrimarySuccess(
    {
      host: "example.test",
      providers: [],
      policy: policy(null),
      skipPrimary: false,
    },
    failing.d,
  );
  await noteFallbackRescue(null, "timeout_exhausted", failing.d);
});

Deno.test("concurrent lookups for one host share a single read", async () => {
  resetScrapePlanMemo();
  const { d, calls } = deps(null);
  await Promise.all([
    resolveScrapePlan("https://example.test/a", d),
    resolveScrapePlan("https://example.test/b", d),
    resolveScrapePlan("https://example.test/c", d),
  ]);
  assertEquals(calls.reads, 1);
});
