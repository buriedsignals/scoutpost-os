import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  buildScenarioErrorResult,
  countUndatedSources,
  evaluateAudit,
  formatResult,
  HARD_NEWS_TERMS,
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

Deno.test("Beat benchmark preserves captured preview counts on failure and formats undated counters", () => {
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
  assertEquals(
    formatResult({
      ...failed,
      executionCount: 3,
      executionUndatedCount: 2,
    }),
    "[FAIL] London canary | preview=2 (undated=1) | execution=3 (undated=2) | 1.5s | execution failed",
  );
});
