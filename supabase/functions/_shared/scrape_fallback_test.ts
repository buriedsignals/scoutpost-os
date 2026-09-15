import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.208.0/testing/time.ts";
import { crawlerProxyErrorEnvelope } from "./crawler_proxy_contract.ts";
import { ApiError } from "./errors.ts";
import {
  isTransientScrapeError,
  scrape,
  scrapePrimaryPageResilient,
} from "./scrape.ts";
import {
  crawlerFallbackReason,
  scrapeFallbackOnce,
} from "./scrape_fallback.ts";

const PAGE_URL = "https://example.test/notices";
const PRIMARY_URL = "https://scrape.example.test/scrape";
const PROXY_BASE = "https://project.example.test/functions/v1/crawler-proxy";
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";

function withRecoveryEnv(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const values = {
      SCRAPE_PROVIDER: "crawl4ai",
      SCRAPE_SERVICE_URL: "https://scrape.example.test",
      SCRAPE_SERVICE_TOKEN: "test-only-token",
      FIRECRAWL_API_KEY: "test-only-key",
    };
    const previous = new Map(
      Object.keys(values).map((key) => [key, Deno.env.get(key)]),
    );
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    try {
      for (const [key, value] of Object.entries(values)) {
        Deno.env.set(key, value);
      }
      // Every test must install its boundary; an unexpected path never reaches the network.
      globalThis.fetch = () =>
        Promise.reject(new Error("unexpected provider request"));
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      for (const [key, value] of previous) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function navigationTimeout(): Response {
  return json({ detail: { error: "navigation_timeout" } }, 504);
}

Deno.test(
  "primary success preserves target content without spending a fallback",
  withRecoveryEnv(async () => {
    const requests: string[] = [];
    globalThis.fetch = (input) => {
      requests.push(String(input));
      assertEquals(String(input), PRIMARY_URL);
      return Promise.resolve(json({
        markdown: "# Public meeting\nTuesday at 10:00",
        rawHtml: "<main>Tuesday at 10:00</main>",
        source_url: PAGE_URL,
        status_code: 200,
      }));
    };

    const result = await scrapePrimaryPageResilient({
      url: PAGE_URL,
      retryDelayMs: 0,
    });
    assertEquals(result.markdown, "# Public meeting\nTuesday at 10:00");
    assertEquals(result.rawHtml, "<main>Tuesday at 10:00</main>");
    assertEquals(result.served_by, "crawl4ai");
    assertEquals(result.fallback_reason, undefined);
    assertEquals(result.scrape_attempts, 1);
    assertEquals(requests, [PRIMARY_URL]);
  }),
);

Deno.test(
  "three typed navigation failures spend one remaining-budget fallback and retain same-fetch provenance",
  withRecoveryEnv(async () => {
    let now = 1_800_000_000_000;
    Date.now = () => now;
    const deadlineMs = now + 47_000;
    const requests: string[] = [];
    globalThis.fetch = (input, init) => {
      const request = init as RequestInit | undefined;
      const endpoint = String(input);
      requests.push(endpoint);
      if (endpoint === PRIMARY_URL) {
        now += 15_000;
        return Promise.resolve(navigationTimeout());
      }
      assertEquals(endpoint, FIRECRAWL_URL);
      assertEquals(requests, [
        PRIMARY_URL,
        PRIMARY_URL,
        PRIMARY_URL,
        FIRECRAWL_URL,
      ]);
      const body = JSON.parse(String(request?.body));
      // The provider rejects a renewed budget instead of echoing our request options.
      if (
        body.timeout !== deadlineMs - now || !request?.signal ||
        request.signal.aborted
      ) {
        return Promise.resolve(
          json({ error: "request exceeds remaining deadline" }, 400),
        );
      }
      const captured = body.formats.includes("rawHtml") &&
        body.formats.some((format: unknown) =>
          typeof format === "object" && format !== null &&
          "type" in format && format.type === "screenshot" &&
          "fullPage" in format && format.fullPage === true
        );
      return Promise.resolve(json({
        data: {
          markdown: "# Recovered meeting\nWednesday at 11:00",
          rawHtml: captured ? "<main>Wednesday at 11:00</main>" : undefined,
          screenshot: captured
            ? "https://cdn.example.test/same-fetch.png"
            : undefined,
          metadata: { sourceURL: `${PAGE_URL}/current`, statusCode: 200 },
        },
      }));
    };

    const result = await scrapePrimaryPageResilient({
      url: PAGE_URL,
      timeoutMs: 10_000,
      abortAfterMs: 15_000,
      deadlineMs,
      retryDelayMs: 0,
      snapshot: "on_fallback",
    });
    assertEquals(result.markdown, "# Recovered meeting\nWednesday at 11:00");
    assertEquals(result.comparison_markdown, result.markdown);
    assertEquals(result.rawHtml, "<main>Wednesday at 11:00</main>");
    assertEquals(
      result.screenshot_url,
      "https://cdn.example.test/same-fetch.png",
    );
    assertEquals(result.snapshot, undefined);
    assertEquals(result.requested_url, PAGE_URL);
    assertEquals(result.source_url, `${PAGE_URL}/current`);
    assertEquals(result.status_code, 200);
    assertEquals(result.served_by, "firecrawl");
    assertEquals(result.fallback_reason, "timeout_exhausted");
    assertEquals(result.scrape_strategy, "timeout_fallback");
    assertEquals(result.scrape_attempts, 3);
    assertEquals(requests, [
      PRIMARY_URL,
      PRIMARY_URL,
      PRIMARY_URL,
      FIRECRAWL_URL,
    ]);
  }),
);

Deno.test(
  "the implicit ladder deadline reuses the unused fourth primary slot",
  withRecoveryEnv(async () => {
    let now = 1_800_000_000_000;
    Date.now = () => now;
    let primaryRequests = 0;
    let fallbackRequests = 0;
    globalThis.fetch = (input, init) => {
      const request = init as RequestInit | undefined;
      if (String(input) === PRIMARY_URL) {
        primaryRequests++;
        now += 5_000;
        return Promise.resolve(navigationTimeout());
      }
      assertEquals(String(input), FIRECRAWL_URL);
      fallbackRequests++;
      const body = JSON.parse(String(request?.body));
      // 4 x 5 seconds total, less the three primary attempts, leaves one slot.
      return Promise.resolve(
        body.timeout === 5_000
          ? json({
            data: { markdown: "Recovered within the original ladder budget" },
          })
          : json({ error: "unexpected additional recovery budget" }, 400),
      );
    };
    const result = await scrapePrimaryPageResilient({
      url: PAGE_URL,
      timeoutMs: 10_000,
      abortAfterMs: 5_000,
      retryDelayMs: 0,
    });
    assertEquals(
      result.markdown,
      "Recovered within the original ladder budget",
    );
    assertEquals(primaryRequests, 3);
    assertEquals(fallbackRequests, 1);
  }),
);

Deno.test(
  "a failed paid fallback is terminal and never restarts the primary ladder",
  withRecoveryEnv(async () => {
    const requests: string[] = [];
    globalThis.fetch = (input) => {
      const endpoint = String(input);
      requests.push(endpoint);
      if (endpoint === PRIMARY_URL) return Promise.resolve(navigationTimeout());
      assertEquals(endpoint, FIRECRAWL_URL);
      return Promise.resolve(
        json({ error: "provider temporarily unavailable" }, 503),
      );
    };
    const error = await assertRejects(
      () => scrapePrimaryPageResilient({ url: PAGE_URL, retryDelayMs: 0 }),
      ApiError,
    );
    assertEquals(error.code, "scrape_fallback_failed");
    assertEquals(isTransientScrapeError(error), false);
    assertEquals(requests, [
      PRIMARY_URL,
      PRIMARY_URL,
      PRIMARY_URL,
      FIRECRAWL_URL,
    ]);
  }),
);

Deno.test(
  "a stalled paid request is aborted at the original absolute deadline",
  withRecoveryEnv(async () => {
    const clock = new FakeTime(1_800_000_000_000);
    let requests = 0;
    let aborted = false;
    try {
      globalThis.fetch = (input, init) => {
        assertEquals(String(input), FIRECRAWL_URL);
        requests++;
        // This mock receives the Deno Fetch shape, not the ambient Node overload.
        const request = init as RequestInit | undefined;
        const signal = request?.signal;
        assert(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("provider request aborted", "AbortError"));
          }, { once: true });
        });
      };
      const failure = assertRejects(
        () =>
          scrapeFallbackOnce(
            PAGE_URL,
            { timeoutMs: 30_000, abortAfterMs: 60_000 },
            "timeout_exhausted",
            Date.now() + 2_000,
          ),
        ApiError,
      );
      clock.tick(1_999);
      assertEquals(aborted, false);
      clock.tick(1);
      assertEquals(aborted, true);
      const error = await failure;
      assertEquals(error.code, "scrape_fallback_failed");
      assertEquals(isTransientScrapeError(error), false);
      assertEquals(requests, 1);
    } finally {
      clock.restore();
    }
  }),
);

Deno.test(
  "expired deadline, missing key, and capture prohibition reject before provider admission",
  withRecoveryEnv(async () => {
    let requests = 0;
    globalThis.fetch = () => {
      requests++;
      return Promise.resolve(
        json({ data: { markdown: "must not be fetched" } }),
      );
    };
    const expired = await assertRejects(
      () =>
        scrapeFallbackOnce(PAGE_URL, {}, "timeout_exhausted", Date.now() - 1),
      ApiError,
    );
    assertEquals(expired.code, "scrape_fallback_failed");
    assertEquals(requests, 0);

    Deno.env.delete("FIRECRAWL_API_KEY");
    const noKey = await assertRejects(
      () =>
        scrapeFallbackOnce(
          PAGE_URL,
          {},
          "timeout_exhausted",
          Date.now() + 10_000,
        ),
      ApiError,
    );
    assertEquals(noKey.code, "scrape_fallback_failed");
    assertEquals(requests, 0);

    Deno.env.set("FIRECRAWL_API_KEY", "test-only-key");
    const capture = await assertRejects(
      () =>
        scrapeFallbackOnce(
          PAGE_URL,
          { snapshot: true, noAntibotFallback: true },
          "anti_bot",
          Date.now() + 10_000,
        ),
      ApiError,
    );
    assertEquals(capture.code, "scrape_fallback_failed");
    assertEquals(requests, 0);
  }),
);

Deno.test(
  "a provider-pinned capture cannot turn a proxy timeout into a third-party render",
  withRecoveryEnv(async () => {
    Deno.env.set("SCRAPE_SERVICE_URL", PROXY_BASE);
    const requests: string[] = [];
    globalThis.fetch = (input) => {
      requests.push(String(input));
      assertEquals(String(input), `${PROXY_BASE}/scrape`);
      return Promise.resolve(json(crawlerProxyErrorEnvelope(504, {
        error: "primary_timeout_exhausted",
        attempts: 3,
        max_attempts: 3,
      })));
    };
    const error = await assertRejects(
      () =>
        scrape(PAGE_URL, {
          tenantKey: "system:recovery-test",
          snapshot: true,
          noAntibotFallback: true,
        }),
      ApiError,
    );
    assertEquals(error.code, "primary_timeout_exhausted");
    assertEquals(requests, [`${PROXY_BASE}/scrape`]);
  }),
);

Deno.test(
  "an exhausted proxy result falls back once without replaying durable primary attempts",
  withRecoveryEnv(async () => {
    Deno.env.set("SCRAPE_SERVICE_URL", PROXY_BASE);
    const requests: string[] = [];
    globalThis.fetch = (input) => {
      requests.push(String(input));
      if (String(input) === `${PROXY_BASE}/scrape`) {
        return Promise.resolve(json(crawlerProxyErrorEnvelope(504, {
          error: "primary_timeout_exhausted",
          attempts: 3,
          max_attempts: 3,
        })));
      }
      assertEquals(String(input), FIRECRAWL_URL);
      return Promise.resolve(
        json({ data: { markdown: "Recovered after durable retries" } }),
      );
    };
    const result = await scrapePrimaryPageResilient({
      url: PAGE_URL,
      tenantKey: "system:recovery-test",
      retryDelayMs: 0,
    });
    assertEquals(result.markdown, "Recovered after durable retries");
    assertEquals(result.fallback_reason, "timeout_exhausted");
    assertEquals(result.served_by, "firecrawl");
    assertEquals(requests, [`${PROXY_BASE}/scrape`, FIRECRAWL_URL]);
  }),
);

Deno.test(
  "proxy retries reconnect to the same logical request rather than restarting its queue work",
  withRecoveryEnv(async () => {
    Deno.env.set("SCRAPE_SERVICE_URL", PROXY_BASE);
    const polls = new Map<string, number>();
    globalThis.fetch = (input, init) => {
      assertEquals(String(input), `${PROXY_BASE}/scrape`);
      // This mock receives the Deno Fetch shape, not the ambient Node overload.
      const request = init as RequestInit | undefined;
      const requestId = new Headers(request?.headers).get(
        "X-Scoutpost-Proxy-Request-Id",
      );
      assert(requestId);
      const count = (polls.get(requestId) ?? 0) + 1;
      polls.set(requestId, count);
      return Promise.resolve(
        count < 3
          ? json(
            crawlerProxyErrorEnvelope(
              504,
              "workflow scrape timed out after 5000ms",
            ),
          )
          : json({
            markdown: "Completed queued request",
            rawHtml: "<main>Completed</main>",
          }),
      );
    };
    const result = await scrapePrimaryPageResilient({
      url: PAGE_URL,
      tenantKey: "system:recovery-test",
      retryDelayMs: 0,
    });
    assertEquals(result.markdown, "Completed queued request");
    assertEquals(result.rawHtml, "<main>Completed</main>");
    assertEquals(result.served_by, "crawl4ai");
    assertEquals(result.fallback_reason, undefined);
    assertEquals(polls.size, 1);
  }),
);

for (const failure of ["queue", "client", "admission"] as const) {
  Deno.test(
    `${failure} failure is not a target navigation timeout and never authorizes paid recovery`,
    withRecoveryEnv(async () => {
      Deno.env.set("SCRAPE_SERVICE_URL", PROXY_BASE);
      let primaryRequests = 0;
      let fallbackRequests = 0;
      globalThis.fetch = (input) => {
        if (String(input) === FIRECRAWL_URL) {
          fallbackRequests++;
          return Promise.resolve(
            json({ data: { markdown: "unauthorized fallback" } }),
          );
        }
        assertEquals(String(input), `${PROXY_BASE}/scrape`);
        primaryRequests++;
        if (failure === "client") {
          return Promise.reject(
            new DOMException("client disconnected", "AbortError"),
          );
        }
        return Promise.resolve(json(crawlerProxyErrorEnvelope(
          failure === "queue" ? 504 : 429,
          failure === "queue"
            ? "workflow scrape timed out after 5000ms"
            : "crawler utility admission limit reached",
        )));
      };
      const error = await assertRejects(
        () =>
          scrapePrimaryPageResilient({
            url: PAGE_URL,
            tenantKey: "system:recovery-test",
            retryDelayMs: 0,
          }),
        ApiError,
      );
      assert(error.code !== "navigation_timeout");
      assert(error.code !== "primary_timeout_exhausted");
      assert(primaryRequests >= 1 && primaryRequests <= 3);
      assertEquals(fallbackRequests, 0);
    }),
  );
}

Deno.test(
  "two transport failures plus one navigation timeout do not exhaust three target attempts",
  withRecoveryEnv(async () => {
    let primaryRequests = 0;
    let fallbackRequests = 0;
    globalThis.fetch = (input) => {
      if (String(input) === FIRECRAWL_URL) {
        fallbackRequests++;
        return Promise.resolve(
          json({ data: { markdown: "unauthorized recovery" } }),
        );
      }
      assertEquals(String(input), PRIMARY_URL);
      primaryRequests++;
      return Promise.resolve(
        primaryRequests < 3
          ? json({ detail: "renderer admission unavailable" }, 503)
          : navigationTimeout(),
      );
    };
    await assertRejects(
      () => scrapePrimaryPageResilient({ url: PAGE_URL, retryDelayMs: 0 }),
      ApiError,
    );
    assertEquals(primaryRequests, 3);
    assertEquals(fallbackRequests, 0);
  }),
);

Deno.test(
  "a real target 404 remains a removed-page result, not a provider recovery trigger",
  withRecoveryEnv(async () => {
    const requests: string[] = [];
    globalThis.fetch = (input) => {
      requests.push(String(input));
      assertEquals(String(input), PRIMARY_URL);
      return Promise.resolve(json({
        markdown: "This notice has been removed",
        rawHtml: "<main>This notice has been removed</main>",
        status_code: 404,
        source_url: PAGE_URL,
      }));
    };
    const result = await scrapePrimaryPageResilient({
      url: PAGE_URL,
      retryDelayMs: 0,
    });
    assertEquals(result.status_code, 404);
    assertEquals(result.markdown, "This notice has been removed");
    assertEquals(result.served_by, "crawl4ai");
    assertEquals(result.fallback_reason, undefined);
    assertEquals(requests, [PRIMARY_URL]);
  }),
);

for (const status of [413, 415, 422]) {
  Deno.test(
    `unsupported document HTTP ${status} is terminal even when its detail mentions timeout`,
    withRecoveryEnv(async () => {
      const requests: string[] = [];
      globalThis.fetch = (input) => {
        requests.push(String(input));
        assertEquals(String(input), PRIMARY_URL);
        return Promise.resolve(
          json(
            { detail: "document rejected before navigation timeout" },
            status,
          ),
        );
      };
      const error = await assertRejects(
        () => scrapePrimaryPageResilient({ url: PAGE_URL, retryDelayMs: 0 }),
        ApiError,
      );
      assertEquals(error.status, status);
      assertEquals(isTransientScrapeError(error), false);
      assertEquals(requests, [PRIMARY_URL]);
    }),
  );
}

Deno.test("fallback eligibility counts only exhausted scrape timeouts", () => {
  assertEquals(crawlerFallbackReason("scrape", "timeout", 2, 3), null);
  assertEquals(
    crawlerFallbackReason("scrape", "timeout", 3, 3),
    "timeout_exhausted",
  );
  assertEquals(crawlerFallbackReason("scrape", "timeout", 3, 0), null);
  assertEquals(crawlerFallbackReason("snapshot", "timeout", 3, 3), null);
  assertEquals(crawlerFallbackReason("parse_pdf", "anti_bot", 3, 3), null);
  assertEquals(crawlerFallbackReason("scrape", "terminal", 3, 3), null);
  assertEquals(crawlerFallbackReason("scrape", "retryable", 3, 3), null);
  assertEquals(crawlerFallbackReason("scrape", "anti_bot", 1, 3), "anti_bot");
});

Deno.test(
  "a stalled response body remains inside the single paid fallback deadline",
  withRecoveryEnv(async () => {
    const clock = new FakeTime(1_800_000_000_000);
    let aborted = false;
    let requests = 0;
    try {
      globalThis.fetch = (_input, init) => {
        // The installed overload also includes Node; this caller uses Deno Fetch.
        const request = init as RequestInit | undefined;
        assert(request?.signal);
        requests++;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            request.signal!.addEventListener("abort", () => {
              aborted = true;
              controller.error(
                new DOMException("response aborted", "AbortError"),
              );
            }, { once: true });
          },
        });
        return Promise.resolve(new Response(stream));
      };
      const failure = assertRejects(
        () =>
          scrapeFallbackOnce(
            PAGE_URL,
            {},
            "timeout_exhausted",
            Date.now() + 5_000,
          ),
        ApiError,
      );
      await clock.tickAsync(5_000);
      assert(aborted);
      assertEquals((await failure).code, "scrape_fallback_failed");
      assertEquals(requests, 1);
    } finally {
      clock.restore();
    }
  }),
);
