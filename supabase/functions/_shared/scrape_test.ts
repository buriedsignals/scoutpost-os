import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { ApiError } from "./errors.ts";
import {
  changeTrackingScrape,
  isAntiBotBlockedError,
  isTransientScrapeError,
  scrape,
  scrapePrimaryPageResilient,
  scrapeProvider,
  warningForScrapeError,
} from "./scrape.ts";
import { firecrawlScrape } from "./scrape_firecrawl.ts";
import type { ScrapeResult } from "./scrape_types.ts";

function scrapeResult(
  markdown: string,
  rawHtml: string | null = "<html></html>",
): ScrapeResult {
  return {
    markdown,
    rawHtml: rawHtml ?? undefined,
    title: "Example",
    source_url: "https://example.com",
    fetched_at: "2026-05-01T00:00:00Z",
  };
}

// ---- provider dispatch -----------------------------------------------------

Deno.test("scrapeProvider defaults to firecrawl and honors SCRAPE_PROVIDER", () => {
  Deno.env.delete("SCRAPE_PROVIDER");
  assertEquals(scrapeProvider(), "firecrawl");
  Deno.env.set("SCRAPE_PROVIDER", "crawl4ai");
  assertEquals(scrapeProvider(), "crawl4ai");
  Deno.env.set("SCRAPE_PROVIDER", "something-else");
  assertEquals(scrapeProvider(), "firecrawl");
  Deno.env.delete("SCRAPE_PROVIDER");
});

Deno.test("scrape() dispatches to the active provider", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  try {
    globalThis.fetch = ((input) => {
      seen.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: { markdown: "fc" }, // firecrawl shape
            markdown: "c4a", // crawl4ai shape
            source_url: "https://example.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
    Deno.env.set("SCRAPE_SERVICE_URL", "https://scrape.internal");
    Deno.env.set("SCRAPE_SERVICE_TOKEN", "tok");

    Deno.env.delete("SCRAPE_PROVIDER");
    const fc = await scrape("https://example.com");
    assertEquals(fc.markdown, "fc");
    assertEquals(seen.at(-1), "https://api.firecrawl.dev/v2/scrape");

    Deno.env.set("SCRAPE_PROVIDER", "crawl4ai");
    const c4a = await scrape("https://example.com");
    assertEquals(c4a.markdown, "c4a");
    assertEquals(seen.at(-1), "https://scrape.internal/scrape");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("SCRAPE_PROVIDER");
    Deno.env.delete("FIRECRAWL_API_KEY");
    Deno.env.delete("SCRAPE_SERVICE_URL");
    Deno.env.delete("SCRAPE_SERVICE_TOKEN");
  }
});

// ---- anti-bot fallback (crawl4ai blocked → firecrawl) ----------------------

const ANTIBOT_DETAIL = JSON.stringify({
  detail:
    "scrape failed: status 403; Blocked by anti-bot protection: Cloudflare JS challenge",
});

function fallbackEnv() {
  Deno.env.set("SCRAPE_PROVIDER", "crawl4ai");
  Deno.env.set("SCRAPE_SERVICE_URL", "https://scrape.internal");
  Deno.env.set("SCRAPE_SERVICE_TOKEN", "tok");
}

function clearFallbackEnv() {
  Deno.env.delete("SCRAPE_PROVIDER");
  Deno.env.delete("FIRECRAWL_API_KEY");
  Deno.env.delete("SCRAPE_SERVICE_URL");
  Deno.env.delete("SCRAPE_SERVICE_TOKEN");
}

Deno.test("isAntiBotBlockedError matches only anti-bot ApiErrors", () => {
  assertEquals(
    isAntiBotBlockedError(
      new ApiError("crawl4ai scrape failed: 502 " + ANTIBOT_DETAIL, 502),
    ),
    true,
  );
  assertEquals(
    isAntiBotBlockedError(new ApiError("DataDome captcha", 502)),
    true,
  );
  // transient provider errors must NOT trigger the fallback
  assertEquals(
    isAntiBotBlockedError(
      new ApiError("crawl4ai scrape aborted after 5000ms", 504),
    ),
    false,
  );
  // non-ApiError never matches, even with matching text
  assertEquals(isAntiBotBlockedError(new Error("anti-bot")), false);
});

Deno.test("scrape() falls back to firecrawl on an anti-bot block", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  try {
    globalThis.fetch = ((input) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https://scrape.internal")) {
        return Promise.resolve(new Response(ANTIBOT_DETAIL, { status: 502 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { markdown: "fc-fallback" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    fallbackEnv();
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const result = await scrape("https://blocked.example/");
    assertEquals(result.markdown, "fc-fallback");
    assertEquals(result.served_by, "firecrawl");
    assertEquals(seen[0], "https://scrape.internal/scrape");
    assertEquals(seen[1], "https://api.firecrawl.dev/v2/scrape");
  } finally {
    globalThis.fetch = originalFetch;
    clearFallbackEnv();
  }
});

Deno.test("scrape() rethrows an anti-bot block when no FIRECRAWL_API_KEY", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(ANTIBOT_DETAIL, { status: 502 }),
      )) as typeof fetch;
    fallbackEnv();
    Deno.env.delete("FIRECRAWL_API_KEY");

    await assertRejects(
      () => scrape("https://blocked.example/"),
      ApiError,
      "anti-bot",
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearFallbackEnv();
  }
});

Deno.test("scrape() does NOT fall back on non-anti-bot provider errors", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  try {
    globalThis.fetch = ((input) => {
      seen.push(String(input));
      return Promise.resolve(
        new Response("upstream exploded", { status: 502 }),
      );
    }) as typeof fetch;
    fallbackEnv();
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    await assertRejects(() => scrape("https://flaky.example/"), ApiError);
    // firecrawl must never have been called — transient errors keep their
    // existing retry semantics, no double spend.
    assertEquals(seen.length, 1);
    assertEquals(seen[0], "https://scrape.internal/scrape");
  } finally {
    globalThis.fetch = originalFetch;
    clearFallbackEnv();
  }
});

Deno.test("scrape() stamps served_by on the normal (non-fallback) paths", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { markdown: "fc" },
            markdown: "c4a",
            source_url: "https://example.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    fallbackEnv();
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const c4a = await scrape("https://example.com");
    assertEquals(c4a.served_by, "crawl4ai");

    Deno.env.delete("SCRAPE_PROVIDER");
    const fc = await scrape("https://example.com");
    assertEquals(fc.served_by, "firecrawl");
  } finally {
    globalThis.fetch = originalFetch;
    clearFallbackEnv();
  }
});

// ---- firecrawl provider (via the port) ------------------------------------

Deno.test("firecrawlScrape preserves metadata for publication-date fallback", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              markdown: "body",
              metadata: {
                title: "Example",
                sourceURL: "https://example.com/story",
                publishedTime: "2026-04-30T12:00:00Z",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const result = await firecrawlScrape("https://example.com/story");

    assertEquals(result.metadata?.publishedTime, "2026-04-30T12:00:00Z");
    assertEquals(result.source_url, "https://example.com/story");
    assertEquals(result.status_code, undefined); // no statusCode in metadata
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("firecrawlScrape surfaces the target 4xx status from metadata.statusCode", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { markdown: "404 page body", metadata: { statusCode: 404 } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
    const result = await firecrawlScrape("https://gov.example/gone");
    assertEquals(result.status_code, 404);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("firecrawlScrape passes cache controls only when supplied", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  try {
    globalThis.fetch = ((_input, init) => {
      bodies.push(JSON.parse(String((init as RequestInit)?.body ?? "{}")));
      return Promise.resolve(
        new Response(JSON.stringify({ data: { markdown: "body" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    await firecrawlScrape("https://example.com/default");
    await firecrawlScrape("https://example.com/fresh", {
      maxAgeMs: 0,
      storeInCache: false,
    });

    assertEquals("maxAge" in bodies[0], false);
    assertEquals("storeInCache" in bodies[0], false);
    assertEquals(bodies[1].maxAge, 0);
    assertEquals(bodies[1].storeInCache, false);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

// ---- resilient orchestrator (provider-neutral via injected deps) ----------

Deno.test("scrapePrimaryPageResilient returns combined strategy on first success", async () => {
  const result = await scrapePrimaryPageResilient({
    url: "https://example.com",
    retryDelayMs: 0,
    deps: {
      scrape: async () => scrapeResult("body"),
    },
  });

  assertEquals(result.markdown, "body");
  assertEquals(result.scrape_strategy, "combined");
  assertEquals(result.scrape_attempts, 1);
});

Deno.test("scrapePrimaryPageResilient retries transient combined failures", async () => {
  let calls = 0;
  const result = await scrapePrimaryPageResilient({
    url: "https://example.com",
    retryDelayMs: 0,
    deps: {
      scrape: async () => {
        calls += 1;
        if (calls === 1) {
          throw new ApiError("crawl4ai scrape failed: 500 upstream", 502);
        }
        return scrapeResult("body");
      },
    },
  });

  assertEquals(calls, 2);
  assertEquals(result.scrape_strategy, "combined_retry");
  assertEquals(result.scrape_attempts, 2);
  assertEquals(result.scrape_warning, "combined_500");
});

Deno.test("scrapePrimaryPageResilient splits markdown and rawHtml after transient combined failures", async () => {
  let scrapeCalls = 0;
  const result = await scrapePrimaryPageResilient({
    url: "https://example.com",
    retryDelayMs: 0,
    deps: {
      scrape: async (_url, opts) => {
        scrapeCalls += 1;
        if (scrapeCalls <= 2) {
          throw new ApiError("crawl4ai scrape aborted after 30000ms", 504);
        }
        if (opts?.formats?.includes("markdown")) {
          return scrapeResult("markdown only", null);
        }
        return scrapeResult("", "<a href='/minutes'>Minutes</a>");
      },
    },
  });

  assertEquals(result.markdown, "markdown only");
  assertEquals(result.rawHtml, "<a href='/minutes'>Minutes</a>");
  assertEquals(result.scrape_strategy, "split");
  assertEquals(result.scrape_attempts, 4);
  assertEquals(
    result.scrape_warning,
    "combined_aborted,combined_retry_aborted",
  );
});

Deno.test("scrapePrimaryPageResilient allows markdown-only fallback when rawHtml fails", async () => {
  let scrapeCalls = 0;
  const result = await scrapePrimaryPageResilient({
    url: "https://example.com",
    retryDelayMs: 0,
    deps: {
      scrape: async (_url, opts) => {
        scrapeCalls += 1;
        if (scrapeCalls <= 2) {
          throw new ApiError("firecrawl scrape failed: 500 upstream", 502);
        }
        if (opts?.formats?.includes("markdown")) {
          return scrapeResult("markdown only", null);
        }
        throw new ApiError("firecrawl scrape failed: 500 raw html", 502);
      },
    },
  });

  assertEquals(result.markdown, "markdown only");
  assertEquals(result.rawHtml, null);
  assertEquals(result.scrape_strategy, "markdown_only_fallback");
  assertEquals(
    result.scrape_warning,
    "combined_500,combined_retry_500,raw_html_500",
  );
});

Deno.test("scrapePrimaryPageResilient does not retry unsupported file errors", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      scrapePrimaryPageResilient({
        url: "https://example.com/bad.gif",
        retryDelayMs: 0,
        deps: {
          scrape: async () => {
            calls += 1;
            throw new ApiError(
              'firecrawl scrape failed: 500 {"code":"SCRAPE_UNSUPPORTED_FILE_ERROR"}',
              502,
            );
          },
        },
      }),
    ApiError,
  );

  assertEquals(calls, 1);
});

Deno.test("scrapePrimaryPageResilient uses the change-tracking path when a tag is supplied", async () => {
  let ctCalls = 0;
  const result = await scrapePrimaryPageResilient({
    url: "https://example.com",
    changeTrackingTag: "scout-abc",
    retryDelayMs: 0,
    deps: {
      changeTrackingScrape: async () => {
        ctCalls += 1;
        return { ...scrapeResult("tracked"), change_status: "changed" as const };
      },
    },
  });
  assertEquals(ctCalls, 1);
  assertEquals(result.change_status, "changed");
  assertEquals(result.markdown, "tracked");
});

Deno.test("scrapePrimaryPageResilient throws on empty markdown after fallback", async () => {
  await assertRejects(
    () =>
      scrapePrimaryPageResilient({
        url: "https://example.com",
        retryDelayMs: 0,
        deps: {
          scrape: async (_url, opts) => {
            if (opts?.formats?.length === 2) {
              throw new ApiError("crawl4ai scrape failed: 503 x", 502);
            }
            return scrapeResult("   ", null); // markdown-only returns blank
          },
        },
      }),
    ApiError,
    "empty markdown",
  );
});

Deno.test("scrapePrimaryPageResilient rethrows non-transient combined failure", async () => {
  await assertRejects(
    () =>
      scrapePrimaryPageResilient({
        url: "https://example.com",
        retryDelayMs: 0,
        deps: {
          scrape: async () => {
            throw new ApiError("firecrawl scrape failed: 400 bad request", 400);
          },
        },
      }),
    ApiError,
    "400",
  );
});

Deno.test("changeTrackingScrape routes to Firecrawl regardless of provider", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  try {
    globalThis.fetch = ((input) => {
      seenUrl = String(input);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              markdown: "tracked body",
              changeTracking: { changeStatus: "changed", previousScrapeAt: "2026-05-01" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
    Deno.env.set("SCRAPE_PROVIDER", "crawl4ai"); // must still route to Firecrawl

    const result = await changeTrackingScrape("https://example.com", "scout-x");
    assertEquals(seenUrl, "https://api.firecrawl.dev/v2/scrape");
    assertEquals(result.change_status, "changed");
    assertEquals(result.markdown, "tracked body");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
    Deno.env.delete("SCRAPE_PROVIDER");
  }
});

Deno.test("scrapePrimaryPageResilient applies the default retry delay via the real sleep", async () => {
  let calls = 0;
  // No retryDelayMs override → default (line coverage of `?? 2_000` and the
  // real DEFAULT_PRIMARY_DEPS.sleep). Override only `scrape`, not `sleep`.
  const result = await scrapePrimaryPageResilient({
    url: "https://example.com",
    retryDelayMs: 1, // tiny but > 0 so the real sleep runs quickly
    deps: {
      scrape: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError("crawl4ai scrape failed: 503 x", 502);
        return scrapeResult("recovered");
      },
    },
  });
  assertEquals(result.scrape_strategy, "combined_retry");
  assertEquals(result.markdown, "recovered");
});

Deno.test("scrapePrimaryPageResilient default retryDelayMs is used when omitted", async () => {
  // First attempt succeeds → covers the `opts.retryDelayMs ?? 2_000` default
  // eval without paying the 2s sleep.
  const result = await scrapePrimaryPageResilient({
    url: "https://example.com",
    deps: { scrape: async () => scrapeResult("ok") },
  });
  assertEquals(result.scrape_strategy, "combined");
});

Deno.test("scrapePrimaryPageResilient rethrows a non-transient retry failure", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      scrapePrimaryPageResilient({
        url: "https://example.com",
        retryDelayMs: 0,
        deps: {
          scrape: async () => {
            calls += 1;
            if (calls === 1) throw new ApiError("crawl4ai scrape failed: 500 x", 502);
            throw new ApiError("crawl4ai scrape failed: 400 bad", 400);
          },
        },
      }),
    ApiError,
    "400",
  );
  assertEquals(calls, 2);
});

Deno.test("scrapePrimaryPageResilient rethrows original error when markdown stage also fails", async () => {
  await assertRejects(
    () =>
      scrapePrimaryPageResilient({
        url: "https://example.com",
        retryDelayMs: 0,
        deps: {
          scrape: async (_url, opts) => {
            // combined (2 formats) fails transiently twice; markdown-only stage
            // then throws → firstError is rethrown.
            if (opts?.formats?.length === 2) {
              throw new ApiError("firecrawl scrape aborted after 30000ms", 504);
            }
            throw new ApiError("firecrawl scrape failed: 500 md-stage", 502);
          },
        },
      }),
    ApiError,
    "aborted",
  );
});

Deno.test("scrapePrimaryPageResilient splits via the change-tracking markdown stage", async () => {
  let combinedFails = 0;
  const result = await scrapePrimaryPageResilient({
    url: "https://example.com",
    changeTrackingTag: "scout-ct",
    retryDelayMs: 0,
    deps: {
      changeTrackingScrape: async (_url, _tag, opts) => {
        if (opts?.formats?.length !== 1) {
          combinedFails += 1;
          throw new ApiError("firecrawl change-tracking failed: 502 x", 502);
        }
        return { ...scrapeResult("ct markdown", null), change_status: "same" as const };
      },
      scrape: async () => scrapeResult("", "<a>links</a>"),
    },
  });
  assertEquals(combinedFails, 2);
  assertEquals(result.markdown, "ct markdown");
  assertEquals(result.rawHtml, "<a>links</a>");
  assertEquals(result.scrape_strategy, "split");
});

Deno.test("scrapePrimaryPageResilient rethrows a non-Error firstError from the markdown stage", async () => {
  await assertRejects(
    () =>
      scrapePrimaryPageResilient({
        url: "https://example.com",
        retryDelayMs: 0,
        deps: {
          scrape: async (_url, opts) => {
            // combined (2 formats) throws a bare string that classifies as
            // transient (matches /timeout/); markdown-only stage then throws.
            if (opts?.formats?.length === 2) throw "network timeout";
            throw new ApiError("firecrawl scrape failed: 500 md", 502);
          },
        },
      }),
    ApiError,
    "500 md",
  );
});

Deno.test("scrapePrimaryPageResilient split merges rawHtml fields from the raw stage", async () => {
  let calls = 0;
  const result = await scrapePrimaryPageResilient({
    url: "https://example.com",
    retryDelayMs: 0,
    deps: {
      scrape: async (_url, opts) => {
        calls += 1;
        if (calls <= 2) throw new ApiError("firecrawl scrape failed: 503 x", 502);
        if (opts?.formats?.includes("markdown")) {
          // markdown stage: no title, blank source_url, null rawHtml — force
          // the right-hand side of each merge fallback.
          return {
            markdown: "md body",
            rawHtml: null,
            source_url: "",
            fetched_at: "2026-05-01T00:00:00Z",
          };
        }
        return {
          markdown: "",
          rawHtml: null,
          html: "<body>from raw</body>",
          title: "From Raw",
          source_url: "https://example.com/raw",
          fetched_at: "2026-05-01T00:00:00Z",
        };
      },
    },
  });
  assertEquals(result.scrape_strategy, "split");
  assertEquals(result.rawHtml, null);
  assertEquals(result.title, "From Raw");
  assertEquals(result.source_url, "https://example.com/raw");
  assertEquals(result.html, "<body>from raw</body>");
});

Deno.test("warningForScrapeError labels each failure mode", () => {
  assertEquals(
    warningForScrapeError(new Error("request timed out"), "combined"),
    "combined_timeout",
  );
  assertEquals(
    warningForScrapeError(new ApiError("opaque provider failure", 503), "raw_html"),
    "raw_html_503",
  );
  assertEquals(warningForScrapeError("weird string", "combined"), "combined_failed");
});

Deno.test("isTransientScrapeError classifies retryable failures for both providers", () => {
  assertEquals(
    isTransientScrapeError(
      new ApiError("firecrawl scrape failed: 429 rate limit", 502),
    ),
    true,
  );
  assertEquals(
    isTransientScrapeError(
      new ApiError("crawl4ai scrape failed: 500 upstream", 502),
    ),
    true,
  );
  assertEquals(isTransientScrapeError(new ApiError("crawl4ai scrape aborted after 30000ms", 504)), true);
  assertEquals(
    isTransientScrapeError(
      new ApiError(
        'crawl4ai scrape failed: 500 {"code":"SCRAPE_UNSUPPORTED_FILE_ERROR"}',
        502,
      ),
    ),
    false,
  );
  assertEquals(
    isTransientScrapeError(new ApiError("bad request", 400)),
    false,
  );
  assertEquals(isTransientScrapeError("plain string error"), false);
});
