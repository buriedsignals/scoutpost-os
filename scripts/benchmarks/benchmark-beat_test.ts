import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import {
  buildScenarioErrorResult,
  countUndatedSources,
  evaluateAudit,
  evaluatePreview,
  HARD_NEWS_TERMS,
  readPreviewCategory,
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
