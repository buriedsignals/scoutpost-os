import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  crawlerPipelineForScoutType,
  pageWorkflowEligible,
  selectCrawlerBackend,
  selectScoutCrawlerBackend,
  stablePercent,
} from "./crawler_routing.ts";

Deno.test("workflow routing is pinned off unless the master switch is exact", () => {
  const env = (_name: string) => "100";
  assertEquals(selectCrawlerBackend("scout", "page", env), "service");
});

Deno.test("first Page canary excludes legacy and archive-enabled Scouts", () => {
  assertEquals(
    pageWorkflowEligible({
      type: "web",
      provider: "firecrawl_plain",
      archive_enabled: false,
    }),
    true,
  );
  assertEquals(
    pageWorkflowEligible({
      type: "web",
      provider: null,
      archive_enabled: false,
    }),
    false,
  );
  assertEquals(
    pageWorkflowEligible({
      type: "web",
      provider: "firecrawl_plain",
      archive_enabled: true,
    }),
    false,
  );
  assertEquals(pageWorkflowEligible({ type: "beat" }), false);
});

Deno.test("zero percent keeps every cohort on the current service", () => {
  const env = (name: string) =>
    name === "CRAWLER_WORKFLOW_ENABLED" ? "true" : "0";
  for (let index = 0; index < 1000; index++) {
    assertEquals(selectCrawlerBackend(String(index), "page", env), "service");
  }
});

Deno.test("selection is deterministic and clamps percentages", () => {
  const enabled = (value: string) => (name: string) =>
    name === "CRAWLER_WORKFLOW_ENABLED" ? "true" : value;
  assertEquals(selectCrawlerBackend("a", "beat", enabled("1000")), "workflow");
  assertEquals(
    selectCrawlerBackend("a", "beat", enabled("invalid")),
    "service",
  );
  assertEquals(stablePercent("same"), stablePercent("same"));
});

Deno.test("operator can force an eligible user's Page Scouts into an open canary", () => {
  const targetUser = "11111111-1111-4111-8111-111111111111";
  const env = (name: string) =>
    ({
      CRAWLER_WORKFLOW_ENABLED: "true",
      CRAWLER_WORKFLOW_PERCENT_PAGE: "5",
      CRAWLER_WORKFLOW_FORCE_PAGE_USER_IDS:
        `22222222-2222-4222-8222-222222222222, ${targetUser}`,
    })[name];
  assertEquals(
    selectScoutCrawlerBackend({
      id: "scout-outside-random-cohort",
      user_id: targetUser,
      type: "web",
      provider: "firecrawl_plain",
      archive_enabled: false,
    }, env),
    "workflow",
  );
});

Deno.test("forced users still fail closed outside the Page canary boundary", () => {
  const targetUser = "11111111-1111-4111-8111-111111111111";
  const scout = {
    id: "scout",
    user_id: targetUser,
    type: "web",
    provider: "firecrawl_plain",
    archive_enabled: false,
  };
  const env = (overrides: Record<string, string>) => (name: string) =>
    ({
      CRAWLER_WORKFLOW_ENABLED: "true",
      CRAWLER_WORKFLOW_PERCENT_PAGE: "5",
      CRAWLER_WORKFLOW_FORCE_PAGE_USER_IDS: targetUser,
      ...overrides,
    })[name];

  assertEquals(
    selectScoutCrawlerBackend(
      scout,
      env({ CRAWLER_WORKFLOW_ENABLED: "false" }),
    ),
    "service",
  );
  assertEquals(
    selectScoutCrawlerBackend(
      scout,
      env({ CRAWLER_WORKFLOW_PERCENT_PAGE: "0" }),
    ),
    "service",
  );
  assertEquals(
    selectScoutCrawlerBackend({ ...scout, archive_enabled: true }, env({})),
    "service",
  );
  assertEquals(
    selectScoutCrawlerBackend({ ...scout, provider: null }, env({})),
    "service",
  );
});

Deno.test("Scout types map only to known crawler pipelines", () => {
  assertEquals(crawlerPipelineForScoutType("web"), "page");
  assertEquals(crawlerPipelineForScoutType("beat"), "beat");
  assertEquals(crawlerPipelineForScoutType("civic"), "civic");
  assertThrows(() => crawlerPipelineForScoutType("social"));
});
