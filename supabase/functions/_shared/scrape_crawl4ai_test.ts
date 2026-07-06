import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { ApiError } from "./errors.ts";
import { crawl4aiScrape } from "./scrape_crawl4ai.ts";

function withEnv(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    Deno.env.set("SCRAPE_SERVICE_URL", "https://scrape.internal/");
    Deno.env.set("SCRAPE_SERVICE_TOKEN", "tok-123");
    const originalFetch = globalThis.fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
      Deno.env.delete("SCRAPE_SERVICE_URL");
      Deno.env.delete("SCRAPE_SERVICE_TOKEN");
    }
  };
}

Deno.test(
  "crawl4aiScrape maps the service response and authenticates",
  withEnv(async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = ((input, init) => {
      const req = init as RequestInit;
      seenUrl = String(input);
      seenAuth = String((req?.headers as Record<string, string>).Authorization);
      seenBody = JSON.parse(String(req?.body ?? "{}"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            markdown: "# Page",
            rawHtml: "<html>raw</html>",
            html: "<body>clean</body>",
            title: "Page",
            metadata: { sourceURL: "https://example.org/final" },
            source_url: "https://example.org/final",
            fetched_at: "2026-07-03T00:00:00Z",
            status_code: 200,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const result = await crawl4aiScrape("https://example.org", { timeoutMs: 30_000 });

    assertEquals(seenUrl, "https://scrape.internal/scrape"); // trailing slash trimmed
    assertEquals(seenAuth, "Bearer tok-123");
    assertEquals(seenBody.timeout_ms, 30_000);
    assertEquals(result.markdown, "# Page");
    assertEquals(result.rawHtml, "<html>raw</html>");
    assertEquals(result.html, "<body>clean</body>");
    assertEquals(result.title, "Page");
    assertEquals(result.source_url, "https://example.org/final");
    assertEquals(result.requested_url, "https://example.org");
    assertEquals(result.fetched_at, "2026-07-03T00:00:00Z");
    assertEquals(result.status_code, 200);
  }),
);

Deno.test(
  "crawl4aiScrape surfaces a 4xx target status (removed-page signal)",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ markdown: "404 page", source_url: "u", status_code: 404 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    const result = await crawl4aiScrape("https://gov.example/gone");
    assertEquals(result.status_code, 404);
  }),
);

Deno.test(
  "crawl4aiScrape falls back to requested url and now() when fields absent",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ markdown: "body" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;

    const result = await crawl4aiScrape("https://example.org/page");
    assertEquals(result.markdown, "body");
    assertEquals(result.rawHtml, null);
    assertEquals(result.html, undefined);
    assertEquals(result.title, undefined);
    assertEquals(result.source_url, "https://example.org/page");
    assertEquals(typeof result.fetched_at, "string");
  }),
);

Deno.test(
  "crawl4aiScrape maps a non-OK response to a 502 with the failed:<status> shape",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("bot wall", { status: 403 }))) as typeof fetch;

    const err = await assertRejects(
      () => crawl4aiScrape("https://example.org"),
      ApiError,
      "crawl4ai scrape failed: 403",
    );
    assertEquals((err as ApiError).status, 502);
  }),
);

Deno.test(
  "crawl4aiScrape maps an upstream 504 body to 502 (client abort is the only 504)",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("gateway timeout", { status: 504 }))) as typeof fetch;

    const err = await assertRejects(
      () => crawl4aiScrape("https://example.org"),
      ApiError,
      "crawl4ai scrape failed: 504",
    );
    // Parity with Firecrawl: non-OK → 502 regardless of upstream status.
    assertEquals((err as ApiError).status, 502);
  }),
);

Deno.test(
  "crawl4aiScrape maps a client abort to 504 (real fuse fires)",
  withEnv(async () => {
    // Hang until the AbortController fuse fires, exercising the real
    // setTimeout(() => ac.abort()) path rather than a pre-rejected fetch.
    globalThis.fetch = ((_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit)?.signal;
        signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as typeof fetch;

    const err = await assertRejects(
      () => crawl4aiScrape("https://example.org", { abortAfterMs: 5 }),
      ApiError,
      "aborted after 5ms",
    );
    assertEquals((err as ApiError).status, 504);
  }),
);

Deno.test(
  "crawl4aiScrape coerces a missing/non-string markdown to empty string",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ status_code: 200 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;

    const result = await crawl4aiScrape("https://example.org");
    assertEquals(result.markdown, "");
  }),
);

Deno.test(
  "crawl4aiScrape rethrows a non-abort network error unchanged",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.reject(new TypeError("connection refused"))) as typeof fetch;

    await assertRejects(
      () => crawl4aiScrape("https://example.org"),
      TypeError,
      "connection refused",
    );
  }),
);

Deno.test("crawl4aiScrape requires SCRAPE_SERVICE_URL", async () => {
  Deno.env.delete("SCRAPE_SERVICE_URL");
  Deno.env.set("SCRAPE_SERVICE_TOKEN", "tok");
  try {
    const err = await assertRejects(
      () => crawl4aiScrape("https://example.org"),
      ApiError,
      "SCRAPE_SERVICE_URL",
    );
    assertEquals((err as ApiError).status, 500);
  } finally {
    Deno.env.delete("SCRAPE_SERVICE_TOKEN");
  }
});

Deno.test("crawl4aiScrape requires SCRAPE_SERVICE_TOKEN", async () => {
  Deno.env.set("SCRAPE_SERVICE_URL", "https://scrape.internal");
  Deno.env.delete("SCRAPE_SERVICE_TOKEN");
  try {
    const err = await assertRejects(
      () => crawl4aiScrape("https://example.org"),
      ApiError,
      "SCRAPE_SERVICE_TOKEN",
    );
    assertEquals((err as ApiError).status, 500);
  } finally {
    Deno.env.delete("SCRAPE_SERVICE_URL");
  }
});
