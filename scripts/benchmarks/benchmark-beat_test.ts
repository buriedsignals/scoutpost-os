import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import {
  buildScenarioErrorResult,
  type CompletedRun,
  countUndatedSources,
  evaluateAudit,
  evaluatePreview,
  HARD_NEWS_TERMS,
  readPreviewCategory,
  verifyEmptyExecution,
} from "./benchmark-beat.ts";

Deno.test("London environment and infrastructure coverage clears the substance gate", () => {
  assertEquals(
    evaluateAudit(
      "London drought leaves water and sewer infrastructure under pressure",
      {
        requiredGroups: [["london"], HARD_NEWS_TERMS],
      },
    ),
    [],
  );
  assertEquals(
    evaluateAudit("London football lifestyle roundup", {
      requiredGroups: [["london"], HARD_NEWS_TERMS],
    }).length,
    1,
  );
});

Deno.test("Beat benchmark reports missing and invalid dates separately", () => {
  assertEquals(
    countUndatedSources([
      { date: "2026-08-17" },
      { date: null },
      {},
      { date: "not-a-date" },
    ]),
    3,
  );
});

Deno.test("Beat benchmark preserves captured preview counts on failure", () => {
  const failed = buildScenarioErrorResult({
    name: "London canary",
    previewSources: [
      {
        title: "Drought warning",
        url: "https://example.test/dated",
        date: "2026-08-17",
      },
      {
        title: "Water restrictions",
        url: "https://example.test/undated",
        date: null,
      },
    ],
    elapsedMs: 1500,
    error: new Error("execution failed"),
    attempt: 1,
  });

  assertEquals(failed.previewCount, 2);
  assertEquals(failed.previewUndatedCount, 1);
});

function filteredEmptyBody() {
  return {
    status: "not_found",
    task_completed: true,
    outcome: "filtered_empty",
    articles: [],
    summary: "",
    filteredOutCount: 8,
    search_queries_used: ["Ontario housing"],
    urls_scraped: Array.from(
      { length: 6 },
      (_, i) => `https://example.test/source-${i}`,
    ),
    diagnostics: {
      search_failures: 0,
      sources_attempted: 6,
      sources_read: 6,
      sources_failed: 0,
      excluded_candidates: 0,
      stale_sources: 0,
      criteria_filtered: 0,
      location_filtered: 0,
      stale_articles: 0,
      model_filtered: 8,
    },
  };
}

Deno.test("Beat preview accepts verified relevance filtering without auditing empty topic text", async () => {
  const news = await readPreviewCategory(
    Response.json(filteredEmptyBody()),
    "news",
    "Ontario/news",
  );
  const government = await readPreviewCategory(
    Response.json(filteredEmptyBody()),
    "government",
    "Ontario/government",
  );
  assertEquals(
    evaluatePreview([news, government], {
      previewAudit: { requiredGroups: [["ontario"], ["housing"]] },
    }),
    [],
  );
  const receipt = buildScenarioErrorResult({
    name: "Ontario",
    previewSources: [],
    previewCategories: [news, government],
    elapsedMs: 100,
    error: new Error("later execution failed"),
    attempt: 1,
  });
  assertEquals(receipt.previewFilteredCount, 16);
  assertEquals(
    receipt.previewCategories?.map((category) => ({
      category: category.category,
      outcome: category.outcome,
      read: category.diagnostics?.sources_read,
      filtered: category.diagnostics?.model_filtered,
    })),
    [
      { category: "news", outcome: "filtered_empty", read: 6, filtered: 8 },
      {
        category: "government",
        outcome: "filtered_empty",
        read: 6,
        filtered: 8,
      },
    ],
  );
});

Deno.test("Beat preview distinguishes stale-only reads from unreadable sources", async () => {
  const stale = filteredEmptyBody();
  stale.filteredOutCount = 6;
  stale.diagnostics.stale_sources = 6;
  stale.diagnostics.model_filtered = 0;
  const staleResult = await readPreviewCategory(
    Response.json(stale),
    "news",
    "stale",
  );
  assertEquals(evaluatePreview([staleResult], {}), []);

  const unreadable = {
    ...stale,
    status: "failed",
    task_completed: false,
    outcome: "unreadable_sources",
    error: "Sources could not be read",
    filteredOutCount: 0,
    diagnostics: {
      ...stale.diagnostics,
      sources_read: 0,
      sources_failed: 6,
      stale_sources: 0,
    },
  };
  const failed = await readPreviewCategory(
    Response.json(unreadable),
    "news",
    "unreadable",
  );
  assert(failed.error);
  assert(evaluatePreview([failed], {}).length > 0);
});

Deno.test("Beat preview rejects missing filtering evidence and partial retrieval failures", async () => {
  const filtered = filteredEmptyBody();
  const cases = [
    { ...filtered, outcome: undefined, diagnostics: undefined },
    { ...filtered, outcome: "no_candidates" },
    { ...filtered, outcome: "unverified_empty" },
    {
      ...filtered,
      diagnostics: { ...filtered.diagnostics, model_filtered: 0 },
    },
    { ...filtered, diagnostics: { ...filtered.diagnostics, sources_read: 0 } },
    {
      ...filtered,
      diagnostics: { ...filtered.diagnostics, search_failures: 1 },
    },
    {
      ...filtered,
      diagnostics: { ...filtered.diagnostics, sources_failed: 1 },
    },
    {
      ...filtered,
      diagnostics: { ...filtered.diagnostics, model_filtered: -1 },
    },
  ];
  for (const body of cases) {
    const result = await readPreviewCategory(
      Response.json(body),
      "news",
      "unproven",
    );
    assert(evaluatePreview([result], {}).length > 0, JSON.stringify(body));
  }
});

Deno.test("Beat preview preserves HTTP, transport, and provider errors rather than accepting their empty payloads", async () => {
  const responses = [
    Response.json(filteredEmptyBody(), { status: 504 }),
    Response.json({
      ...filteredEmptyBody(),
      error: { message: "provider failed" },
    }),
    Response.json({
      ...filteredEmptyBody(),
      status: "partial",
      task_completed: false,
    }),
    Response.json({ error: "unauthorized" }, { status: 401 }),
    Response.json(null),
    Promise.reject(new Error("network connection reset")),
  ];
  // Attach rejection handlers immediately, including the transport rejection.
  const results = await Promise.all(
    responses.map((response) =>
      readPreviewCategory(response, "government", "UK renewable/government")
    ),
  );
  for (const result of results) {
    assert(result.error);
    assert(evaluatePreview([result], {}).length > 0);
  }
  assertEquals(results[0].httpStatus, 504);
  assertEquals(results.at(-1)?.httpStatus, null);
  const earlier = await readPreviewCategory(
    Response.json({
      status: "completed",
      task_completed: true,
      articles: [{ title: "Solar project", url: "https://example.test/solar" }],
    }),
    "news",
    "UK renewable/news",
  );
  const receipt = buildScenarioErrorResult({
    name: "UK renewable",
    previewSources: [],
    previewCategories: [earlier, results[0]],
    elapsedMs: 100,
    error: new Error(results[0].error),
    attempt: 1,
  });
  assertEquals(receipt.ok, false);
  assertEquals(receipt.previewCount, 1);
  assertEquals(receipt.previewUndatedCount, 1);
  assertEquals(receipt.previewCategories?.[1].httpStatus, 504);
});

Deno.test("Beat filtered emptiness cannot mask incorrect positive scope or explicit source expectations", async () => {
  const empty = await readPreviewCategory(
    Response.json({ ...filteredEmptyBody(), summary: "Ontario housing" }),
    "government",
    "filtered",
  );
  const positive = await readPreviewCategory(
    Response.json({
      status: "completed",
      task_completed: true,
      articles: [{
        title: "London housing",
        summary: "United Kingdom housing policy",
        url: "https://example.test/london-housing",
        date: new Date().toISOString(),
      }],
    }),
    "news",
    "positive",
  );
  const issues = evaluatePreview([empty, positive], {
    previewAudit: {
      requiredGroups: [["ontario"]],
      forbiddenTerms: ["united kingdom"],
    },
  });
  assertEquals(issues.length, 2);
  const unproven = await readPreviewCategory(
    Response.json({ ...filteredEmptyBody(), outcome: "no_candidates" }),
    "government",
    "unproven",
  );
  assert(evaluatePreview([positive, unproven], {}).length > 0);
  assert(
    evaluatePreview([empty], { requireRecentSourceLinked: true }).length > 0,
  );
  assert(
    evaluatePreview([empty], { requiredSourceDomain: "ontario.ca" }).length > 0,
  );
  assert(
    evaluatePreview([positive], { requiredSourceDomain: "ontario.ca" }).length >
      0,
  );
  assertEquals(
    evaluatePreview([positive], {
      requireRecentSourceLinked: true,
      requiredSourceDomain: "example.test",
      previewAudit: { requiredGroups: [["london"]] },
    }),
    [],
  );
});

// Live 2026-09-21 weekly run, topic-only:housing-policy: five of six readable
// sources were stale, the sixth extracted nothing, and the scheduled run found
// only stale sources. Both runs ended as success with zero units (#480).
function housingBaselineRun(): CompletedRun {
  return {
    id: "3c8edfb4-81e1-49cf-9b1b-642d1e2b2deb",
    status: "success",
    articles_count: 0,
    error_message: null,
    metadata: {
      retrieval: "firecrawl",
      unit_pipeline: {
        units_merged: 0,
        units_created: 0,
        sources_failed: 0,
        extracted_units: 0,
        insert_failures: 0,
        sources_scraped: 1,
        embedding_failures: 0,
        extraction_empty_sources: 1,
        extraction_failed_sources: 0,
        extraction_filtered_sources: 0,
      },
      scrape_provider: "crawl4ai",
      search_jobs_errored: 0,
      search_jobs_attempted: 12,
      scrape_served_crawl4ai: 5,
      stale_sources_filtered: 5,
      scrape_served_firecrawl: 1,
    },
  };
}

function housingScheduledRun(): CompletedRun {
  return {
    id: "1fac0e2e-f74f-4a13-a86d-7d9611fe7b5c",
    status: "success",
    articles_count: 0,
    error_message: null,
    metadata: {
      retrieval: "firecrawl",
      dispatch_source: "manual",
      scrape_provider: "crawl4ai",
      search_jobs_errored: 0,
      search_jobs_attempted: 12,
      scrape_served_crawl4ai: 5,
      stale_sources_filtered: 6,
      scrape_served_firecrawl: 1,
    },
  };
}

function withMetadata(
  run: CompletedRun,
  patch: Record<string, unknown>,
): CompletedRun {
  return { ...run, metadata: { ...(run.metadata ?? {}), ...patch } };
}

Deno.test("Beat execution accepts a verified stale-empty run pair", () => {
  const result = verifyEmptyExecution([
    { label: "baseline", run: housingBaselineRun() },
    { label: "scheduled", run: housingScheduledRun() },
  ]);
  assertEquals(result.verified, true, result.reason);
  assert(result.reason.includes("baseline read 6, stale 5"));
  assert(result.reason.includes("scheduled read 6, stale 6"));
});

Deno.test("Beat execution rejects empty runs without proof of a working retrieval path", () => {
  const baseline = housingBaselineRun();
  const scheduled = housingScheduledRun();
  const cases: Array<[string, CompletedRun[]]> = [
    ["errored run", [{ ...scheduled, status: "error", error_message: "x" }]],
    ["missing metadata", [{ ...scheduled, metadata: null }]],
    ["no search jobs", [withMetadata(scheduled, { search_jobs_attempted: 0 })]],
    ["search errors", [withMetadata(scheduled, { search_jobs_errored: 2 })]],
    [
      "nothing read",
      [withMetadata(scheduled, {
        scrape_served_crawl4ai: 0,
        scrape_served_firecrawl: 0,
        stale_sources_filtered: 0,
      })],
    ],
    [
      "fresh sources read but never extracted",
      [withMetadata(scheduled, { stale_sources_filtered: 4 })],
    ],
    [
      "extraction failures",
      [withMetadata(baseline, {
        unit_pipeline: {
          ...(baseline.metadata!.unit_pipeline as Record<string, number>),
          extraction_failed_sources: 1,
          extraction_empty_sources: 0,
        },
      })],
    ],
    [
      "units extracted but not persisted",
      [withMetadata(baseline, {
        unit_pipeline: {
          ...(baseline.metadata!.unit_pipeline as Record<string, number>),
          extracted_units: 3,
        },
      })],
    ],
    [
      "incomplete pipeline counts",
      [withMetadata(baseline, { unit_pipeline: { sources_scraped: 1 } })],
    ],
    [
      "scraped and stale counts do not cover sources read",
      [withMetadata(baseline, { stale_sources_filtered: 3 })],
    ],
  ];
  for (const [name, runs] of cases) {
    const result = verifyEmptyExecution(
      runs.map((run) => ({ label: "run", run })),
    );
    assertEquals(result.verified, false, name);
    assert(result.reason.length > 0, name);
  }
});

Deno.test("Beat execution reports every unverified run in the reason", () => {
  const result = verifyEmptyExecution([
    { label: "baseline", run: { ...housingBaselineRun(), metadata: null } },
    {
      label: "scheduled",
      run: withMetadata(housingScheduledRun(), { search_jobs_errored: 1 }),
    },
  ]);
  assertEquals(result.verified, false);
  assert(result.reason.includes("baseline: missing run metadata"));
  assert(result.reason.includes("scheduled: 1 search jobs errored"));
});
