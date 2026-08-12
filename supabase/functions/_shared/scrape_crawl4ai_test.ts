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
            comparison_markdown: "# Main content",
            comparison_strategy: "main",
            comparison_ratio: 0.75,
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

    const result = await crawl4aiScrape("https://example.org", {
      timeoutMs: 30_000,
    });

    assertEquals(seenUrl, "https://scrape.internal/scrape"); // trailing slash trimmed
    assertEquals(seenAuth, "Bearer tok-123");
    assertEquals(seenBody.timeout_ms, 30_000);
    assertEquals(result.markdown, "# Page");
    assertEquals(result.comparison_markdown, "# Main content");
    assertEquals(result.comparison_strategy, "main");
    assertEquals(result.comparison_ratio, 0.75);
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
          JSON.stringify({
            markdown: "404 page",
            source_url: "u",
            status_code: 404,
          }),
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
    assertEquals(result.comparison_markdown, null);
    assertEquals(result.comparison_strategy, "full");
    assertEquals(result.comparison_ratio, undefined);
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
      Promise.resolve(
        new Response("bot wall", { status: 403 }),
      )) as typeof fetch;

    const err = await assertRejects(
      () => crawl4aiScrape("https://example.org"),
      ApiError,
      "crawl4ai scrape failed: 403",
    );
    assertEquals((err as ApiError).status, 502);
  }),
);

Deno.test(
  "crawl4aiScrape maps a streamed Workflow error envelope like an HTTP error",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            _scoutpost_workflow_error: {
              status: 502,
              detail: "Blocked by anti-bot protection",
            },
          }),
          { status: 200 },
        ),
      )) as typeof fetch;

    const err = await assertRejects(
      () => crawl4aiScrape("https://example.org"),
      ApiError,
      "Blocked by anti-bot protection",
    );
    assertEquals((err as ApiError).status, 502);
  }),
);

Deno.test(
  "crawl4aiScrape accepts ordinary and snapshot responses from the Workflow endpoint",
  withEnv(async () => {
    Deno.env.set(
      "SCRAPE_SERVICE_URL",
      "https://project.supabase.co/functions/v1/crawler-proxy",
    );
    let tenantHeader = "";
    globalThis.fetch = ((_input, init) => {
      const request = JSON.parse(String((init as RequestInit).body));
      tenantHeader = String(
        ((init as RequestInit).headers as Record<string, string>)[
          "X-Scoutpost-Tenant-Key"
        ],
      );
      return Promise.resolve(
        new Response(JSON.stringify({
          markdown: "ok",
          source_url: "https://example.org",
          ...(request.snapshot
            ? {
              snapshot: {
                mhtml_b64: "bQ==",
                mhtml_sha256: "a".repeat(64),
                screenshot_b64: "cA==",
                screenshot_sha256: "b".repeat(64),
              },
            }
            : {}),
        })),
      );
    }) as typeof fetch;

    assertEquals(
      (await crawl4aiScrape("https://example.org", {
        tenantKey: "00000000-0000-4000-8000-000000000003",
      })).markdown,
      "ok",
    );
    assertEquals(
      (await crawl4aiScrape("https://example.org", {
        snapshot: true,
        tenantKey: "00000000-0000-4000-8000-000000000003",
      })).snapshot
        ?.mhtml_b64,
      "bQ==",
    );
    assertEquals(tenantHeader, "00000000-0000-4000-8000-000000000003");
  }),
);

Deno.test(
  "crawl4aiScrape fails closed without a hosted proxy tenant key",
  withEnv(async () => {
    Deno.env.set(
      "SCRAPE_SERVICE_URL",
      "https://project.supabase.co/functions/v1/crawler-proxy",
    );
    await assertRejects(
      () => crawl4aiScrape("https://example.org"),
      Error,
      "requires a valid tenant key",
    );
  }),
);

Deno.test(
  "crawl4aiScrape maps an upstream 504 body to 502 (client abort is the only 504)",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("gateway timeout", { status: 504 }),
      )) as typeof fetch;

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
  "crawl4aiScrape keeps its abort fuse active while Workflow JSON streams",
  withEnv(async () => {
    globalThis.fetch = ((_input, init) => {
      const signal = (init as RequestInit)?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                controller.error(error);
              });
            },
          }),
        ),
      );
    }) as typeof fetch;

    const error = await assertRejects(
      () => crawl4aiScrape("https://example.org", { abortAfterMs: 5 }),
      ApiError,
      "aborted after 5ms",
    );
    assertEquals((error as ApiError).status, 504);
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
      () =>
        crawl4aiScrape("https://example.org"),
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

Deno.test(
  "crawl4aiScrape sends snapshot:true + widened fuse and maps the inline payload",
  withEnv(async () => {
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = ((_input, init) => {
      seenBody = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            markdown: "# Cap",
            source_url: "https://example.org",
            fetched_at: "2026-07-07T00:00:00Z",
            response_headers: { "content-type": "text/html", "x-num": 5 },
            snapshot: {
              mhtml_b64: "bWh0bWw=",
              mhtml_sha256: "a".repeat(64),
              screenshot_b64: "cG5n",
              screenshot_sha256: "b".repeat(64),
              sizes: { mhtml: 5, screenshot: 3 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const result = await crawl4aiScrape("https://example.org", {
      timeoutMs: 20_000,
      snapshot: true,
    });
    assertEquals(seenBody.snapshot, true);
    // response_headers keeps only string-valued entries.
    assertEquals(result.response_headers, { "content-type": "text/html" });
    assertEquals(result.snapshot?.mhtml_b64, "bWh0bWw=");
    assertEquals(result.snapshot?.sizes, { mhtml: 5, screenshot: 3 });
  }),
);

Deno.test(
  "crawl4aiScrape ignores the on_fallback hint (no snapshot flag sent)",
  withEnv(async () => {
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = ((_input, init) => {
      seenBody = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            markdown: "x",
            source_url: "u",
            response_headers: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    const result = await crawl4aiScrape("https://example.org", {
      snapshot: "on_fallback",
    });
    assertEquals(seenBody.snapshot, undefined);
    assertEquals(result.snapshot, undefined); // no snapshot fields when not requested
    assertEquals(result.response_headers, undefined); // null headers → undefined
  }),
);

Deno.test(
  "crawl4aiScrape maps a malformed snapshot payload / error to null + passthrough",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            markdown: "x",
            source_url: "u",
            snapshot: { mhtml_b64: 123 }, // wrong types → null
            snapshot_error: "artifact_too_large:mhtml:99",
            response_headers: ["not", "an", "object"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    const result = await crawl4aiScrape("https://example.org", {
      snapshot: true,
    });
    assertEquals(result.snapshot, null);
    assertEquals(result.snapshot_error, "artifact_too_large:mhtml:99");
    assertEquals(result.response_headers, undefined); // array → undefined
  }),
);

Deno.test(
  "crawl4aiScrape maps a snapshot payload without sizes",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            markdown: "x",
            source_url: "u",
            snapshot: {
              mhtml_b64: "bQ==",
              mhtml_sha256: "a".repeat(64),
              screenshot_b64: "cA==",
              screenshot_sha256: "b".repeat(64),
            },
            response_headers: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    const result = await crawl4aiScrape("https://example.org", {
      snapshot: true,
    });
    assertEquals(result.snapshot?.sizes, undefined);
    assertEquals(result.response_headers, undefined); // empty object → undefined
  }),
);

Deno.test(
  "crawl4aiScrape maps an absent snapshot payload to null (service omitted it)",
  withEnv(async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            markdown: "x",
            source_url: "u",
            // snapshot key absent; only the structured error present
            snapshot_error: "screenshot_not_png:ffd8",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    const result = await crawl4aiScrape("https://example.org", {
      snapshot: true,
    });
    assertEquals(result.snapshot, null);
    assertEquals(result.snapshot_error, "screenshot_not_png:ffd8");
  }),
);
