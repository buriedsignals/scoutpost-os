import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  allTrackedUrlsGone,
  firecrawlUpstreamStatus,
} from "./civic_diagnostics.ts";

Deno.test("firecrawlUpstreamStatus extracts wrapped provider 4xx", () => {
  assertEquals(
    firecrawlUpstreamStatus(
      new Error("firecrawl change-tracking failed: 404 not found"),
    ),
    404,
  );
  assertEquals(
    firecrawlUpstreamStatus(new Error("firecrawl scrape failed: 410 gone")),
    410,
  );
});

Deno.test("allTrackedUrlsGone requires every tracked URL to be gone (4xx)", () => {
  assertEquals(
    allTrackedUrlsGone([
      {
        url: "https://city.example/a",
        status: "gone",
        upstream_status: 404,
      },
      {
        url: "https://city.example/b",
        status: "gone",
        upstream_status: 410,
      },
    ], 2),
    true,
  );
  // One live/scraped URL → not all gone.
  assertEquals(
    allTrackedUrlsGone([
      {
        url: "https://city.example/a",
        status: "gone",
        upstream_status: 404,
      },
      { url: "https://city.example/b", status: "scraped" },
    ], 2),
    false,
  );
  // A transient 5xx failure is "scrape_failed", NOT "gone" → not all gone
  // (the run should retry, not skip as a dead scout).
  assertEquals(
    allTrackedUrlsGone([
      {
        url: "https://city.example/a",
        status: "gone",
        upstream_status: 404,
      },
      {
        url: "https://city.example/b",
        status: "scrape_failed",
        upstream_status: 503,
      },
    ], 2),
    false,
  );
});
