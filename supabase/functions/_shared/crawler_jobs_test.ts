import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  crawlerJobDedupeKey,
  crawlerUtilityDailyLimit,
  enqueueCrawlerJob,
} from "./crawler_jobs.ts";

const base = {
  requestKind: "scout_run" as const,
  tenantKey: "tenant-one",
  continuationKey: "run-one",
  operation: "scrape" as const,
  pipelineStage: "article",
  itemKey: "article-one",
  url: "https://example.test/article",
  scoutRunId: "00000000-0000-4000-8000-000000000001",
  scoutId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
};

Deno.test("crawler dedupe is stable and scopes URL, tenant, and stage", async () => {
  const first = await crawlerJobDedupeKey(base);
  assertEquals(first, await crawlerJobDedupeKey(base));
  const changed = await crawlerJobDedupeKey({
    ...base,
    pipelineStage: "subpage",
  });
  assertEquals(first === changed, false);
  assertEquals(
    first === await crawlerJobDedupeKey({ ...base, tenantKey: "tenant-two" }),
    false,
  );
  assertEquals(
    first === await crawlerJobDedupeKey({ ...base, url: `${base.url}?v=2` }),
    false,
  );
});

Deno.test("utility enqueue uses atomic admission RPC", async () => {
  let called = "";
  let dailyLimit: unknown;
  const svc = {
    rpc(name: string, args: Record<string, unknown>) {
      called = name;
      dailyLimit = args.p_global_daily_limit;
      return Promise.resolve({
        data: { id: "job", dedupe_key: args.p_dedupe_key, status: "queued" },
        error: null,
      });
    },
  };
  const row = await enqueueCrawlerJob(svc as never, {
    ...base,
    requestKind: "ingest",
    scoutRunId: undefined,
    scoutId: undefined,
    userId: undefined,
  });
  assertEquals(called, "admit_and_enqueue_crawler_utility");
  assertEquals(dailyLimit, 10_000);
  assertEquals(row.status, "queued");
});

Deno.test("utility daily limit is bounded configuration", () => {
  assertEquals(crawlerUtilityDailyLimit("4321"), 4321);
  assertEquals(crawlerUtilityDailyLimit(undefined), 10_000);
  for (const value of ["0", "100001", "3.5", "bad"]) {
    assertThrows(
      () => crawlerUtilityDailyLimit(value),
      Error,
      "invalid crawler utility daily limit",
    );
  }
});

Deno.test("crawler enqueue rejects non-http URLs before RPC", async () => {
  await assertRejects(
    () =>
      enqueueCrawlerJob({} as never, { ...base, url: "file:///etc/passwd" }),
    Error,
    "invalid crawler URL",
  );
});
