import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { ApiError } from "./errors.ts";
import { NeedsOcrError, parseDocument } from "./docparse.ts";

function restoreEnvAfter(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const originalFetch = globalThis.fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
      Deno.env.delete("SCRAPE_PROVIDER");
      Deno.env.delete("FIRECRAWL_API_KEY");
      Deno.env.delete("SCRAPE_SERVICE_URL");
      Deno.env.delete("SCRAPE_SERVICE_TOKEN");
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- firecrawl (dark default) path ----------------------------------------

Deno.test(
  "parseDocument uses firecrawlScrape under the default provider",
  restoreEnvAfter(async () => {
    let seenUrl = "";
    globalThis.fetch = ((input) => {
      seenUrl = String(input);
      return Promise.resolve(jsonResponse({ data: { markdown: "pdf text", metadata: {} } }));
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const result = await parseDocument("https://council.example/minutes.pdf");
    assertEquals(seenUrl, "https://api.firecrawl.dev/v2/scrape");
    assertEquals(result.markdown, "pdf text");
    assertEquals(result.source_url, "https://council.example/minutes.pdf");
    assertEquals(result.pages, undefined);
  }),
);

// ---- crawl4ai /parse path -------------------------------------------------

function setCrawl4ai() {
  Deno.env.set("SCRAPE_PROVIDER", "crawl4ai");
  Deno.env.set("SCRAPE_SERVICE_URL", "https://scrape.internal/");
  Deno.env.set("SCRAPE_SERVICE_TOKEN", "tok");
}

Deno.test(
  "parseDocument routes a PDF through the scrape-service /parse",
  restoreEnvAfter(async () => {
    setCrawl4ai();
    let seenUrl = "";
    let seenAuth = "";
    globalThis.fetch = ((input, init) => {
      seenUrl = String(input);
      seenAuth = String((init as RequestInit)?.headers &&
        (((init as RequestInit).headers) as Record<string, string>).Authorization);
      return Promise.resolve(
        jsonResponse({ markdown: "council minutes", pages: 12, source_url: "https://c/x.pdf" }),
      );
    }) as typeof fetch;

    const result = await parseDocument("https://c/x.pdf");
    assertEquals(seenUrl, "https://scrape.internal/parse");
    assertEquals(seenAuth, "Bearer tok");
    assertEquals(result.markdown, "council minutes");
    assertEquals(result.pages, 12);
  }),
);

Deno.test(
  "parseDocument coerces missing /parse fields",
  restoreEnvAfter(async () => {
    setCrawl4ai();
    globalThis.fetch = (() => Promise.resolve(jsonResponse({}))) as typeof fetch;
    const result = await parseDocument("https://c/x.pdf");
    assertEquals(result.markdown, "");
    assertEquals(result.source_url, "https://c/x.pdf");
    assertEquals(result.pages, undefined);
  }),
);

Deno.test(
  "parseDocument falls back to the scrape port when /parse says not-a-PDF (415)",
  restoreEnvAfter(async () => {
    setCrawl4ai();
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      const u = String(input);
      calls.push(u);
      if (u.endsWith("/parse")) {
        return Promise.resolve(new Response("not pdf", { status: 415 }));
      }
      return Promise.resolve(jsonResponse({ markdown: "html agenda", source_url: u }));
    }) as typeof fetch;

    const result = await parseDocument("https://c/agenda");
    assertEquals(calls, ["https://scrape.internal/parse", "https://scrape.internal/scrape"]);
    assertEquals(result.markdown, "html agenda");
  }),
);

Deno.test(
  "parseDocument surfaces a scanned PDF as NeedsOcrError",
  restoreEnvAfter(async () => {
    setCrawl4ai();
    globalThis.fetch = (() =>
      Promise.resolve(
        jsonResponse({ detail: { error: "needs_ocr", pages: 40, chars: 12 } }, 422),
      )) as typeof fetch;

    const err = await assertRejects(
      () => parseDocument("https://c/scan.pdf"),
      NeedsOcrError,
    );
    assertEquals((err as NeedsOcrError).pages, 40);
    assertEquals((err as NeedsOcrError).chars, 12);
  }),
);

Deno.test(
  "parseDocument defaults NeedsOcrError counts to 0 when the service omits them",
  restoreEnvAfter(async () => {
    setCrawl4ai();
    globalThis.fetch = (() =>
      Promise.resolve(jsonResponse({ detail: { error: "needs_ocr" } }, 422))) as typeof fetch;

    const err = await assertRejects(
      () => parseDocument("https://c/scan.pdf"),
      NeedsOcrError,
    );
    assertEquals((err as NeedsOcrError).pages, 0);
    assertEquals((err as NeedsOcrError).chars, 0);
  }),
);

Deno.test(
  "parseDocument maps a non-needs_ocr 422 to a 502",
  restoreEnvAfter(async () => {
    setCrawl4ai();
    globalThis.fetch = (() =>
      Promise.resolve(jsonResponse({ detail: { error: "other" } }, 422))) as typeof fetch;
    const err = await assertRejects(() => parseDocument("https://c/x.pdf"), ApiError);
    assertEquals((err as ApiError).status, 502);
  }),
);

Deno.test(
  "parseDocument maps an unparseable 422 body to a 502",
  restoreEnvAfter(async () => {
    setCrawl4ai();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("not json", { status: 422 }))) as typeof fetch;
    const err = await assertRejects(() => parseDocument("https://c/x.pdf"), ApiError);
    assertEquals((err as ApiError).status, 502);
  }),
);

Deno.test(
  "parseDocument maps a 5xx to a transient 502",
  restoreEnvAfter(async () => {
    setCrawl4ai();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("boom", { status: 503 }))) as typeof fetch;
    const err = await assertRejects(
      () => parseDocument("https://c/x.pdf"),
      ApiError,
      "crawl4ai parse failed: 503",
    );
    assertEquals((err as ApiError).status, 502);
  }),
);

Deno.test(
  "parseDocument maps a client abort to 504",
  restoreEnvAfter(async () => {
    setCrawl4ai();
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
      () => parseDocument("https://c/x.pdf", { abortAfterMs: 5 }),
      ApiError,
      "aborted after 5ms",
    );
    assertEquals((err as ApiError).status, 504);
  }),
);

Deno.test(
  "parseDocument rethrows a non-abort network error",
  restoreEnvAfter(async () => {
    setCrawl4ai();
    globalThis.fetch = (() =>
      Promise.reject(new TypeError("connection refused"))) as typeof fetch;
    await assertRejects(() => parseDocument("https://c/x.pdf"), TypeError, "connection refused");
  }),
);

Deno.test("parseDocument requires SCRAPE_SERVICE_URL under crawl4ai", async () => {
  Deno.env.set("SCRAPE_PROVIDER", "crawl4ai");
  Deno.env.delete("SCRAPE_SERVICE_URL");
  Deno.env.set("SCRAPE_SERVICE_TOKEN", "tok");
  try {
    const err = await assertRejects(
      () => parseDocument("https://c/x.pdf"),
      ApiError,
      "SCRAPE_SERVICE_URL",
    );
    assertEquals((err as ApiError).status, 500);
  } finally {
    Deno.env.delete("SCRAPE_PROVIDER");
    Deno.env.delete("SCRAPE_SERVICE_TOKEN");
  }
});

Deno.test("parseDocument requires SCRAPE_SERVICE_TOKEN under crawl4ai", async () => {
  Deno.env.set("SCRAPE_PROVIDER", "crawl4ai");
  Deno.env.set("SCRAPE_SERVICE_URL", "https://scrape.internal");
  Deno.env.delete("SCRAPE_SERVICE_TOKEN");
  try {
    const err = await assertRejects(
      () => parseDocument("https://c/x.pdf"),
      ApiError,
      "SCRAPE_SERVICE_TOKEN",
    );
    assertEquals((err as ApiError).status, 500);
  } finally {
    Deno.env.delete("SCRAPE_PROVIDER");
    Deno.env.delete("SCRAPE_SERVICE_URL");
  }
});
