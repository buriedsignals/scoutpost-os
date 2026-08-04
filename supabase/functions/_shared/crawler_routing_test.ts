import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  crawlerPipelineForScoutType,
  selectCrawlerBackend,
  stablePercent,
} from "./crawler_routing.ts";

Deno.test("workflow routing is pinned off unless the master switch is exact", () => {
  const env = (_name: string) => "100";
  assertEquals(selectCrawlerBackend("scout", "page", env), "service");
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

Deno.test("Scout types map only to known crawler pipelines", () => {
  assertEquals(crawlerPipelineForScoutType("web"), "page");
  assertEquals(crawlerPipelineForScoutType("beat"), "beat");
  assertEquals(crawlerPipelineForScoutType("civic"), "civic");
  assertThrows(() => crawlerPipelineForScoutType("social"));
});
