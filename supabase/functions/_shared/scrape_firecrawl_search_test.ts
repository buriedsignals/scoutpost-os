import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { ApiError } from "./errors.ts";
import { firecrawlSearch } from "./scrape_firecrawl.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("firecrawlSearch sends documented Beat search fields and normalizes web/news", async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  try {
    globalThis.fetch = ((_, init) => {
      requests.push(
        JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")),
      );
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            web: [{
              title: "Web result",
              description: "Web description",
              url: "https://example.com/web",
              publishedDate: "2026-05-01",
            }],
            news: [{
              title: "News result",
              snippet: "News snippet",
              url: "https://example.com/news",
              date: "2 hours ago",
            }],
          },
        }),
      );
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const hits = await firecrawlSearch("ai journalism", {
      limit: 12,
      sources: ["web", "news"],
      tbs: "qdr:m,sbd:1",
      location: "Sweden",
      country: "SE",
      excludeDomains: ["youtube.com"],
      ignoreInvalidURLs: true,
    });

    assertEquals(requests[0], {
      query: "ai journalism",
      limit: 12,
      ignoreInvalidURLs: true,
      sources: ["web", "news"],
      location: "Sweden",
      country: "SE",
      tbs: "qdr:m,sbd:1",
      excludeDomains: ["youtube.com"],
    });
    assertEquals(hits, [
      {
        url: "https://example.com/web",
        title: "Web result",
        description: "Web description",
        markdown: undefined,
        date: "2026-05-01",
        source: "web",
      },
      {
        url: "https://example.com/news",
        title: "News result",
        description: "News snippet",
        markdown: undefined,
        date: "2 hours ago",
        source: "news",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("firecrawlSearch rejects mutually exclusive domain filters", async () => {
  const error = await assertRejects(
    () =>
      firecrawlSearch("test", {
        includeDomains: ["example.com"],
        excludeDomains: ["youtube.com"],
      }),
    ApiError,
    "firecrawl search includeDomains and excludeDomains are mutually exclusive",
  );
  assertEquals(error.status, 400);
});

Deno.test("firecrawlSearch accepts partial, legacy, and empty source shapes", async (t) => {
  const originalFetch = globalThis.fetch;
  Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
  try {
    await t.step("web only", async () => {
      globalThis.fetch = (() =>
        Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              web: [{ url: "https://example.com/web", title: "Web" }],
            },
          }),
        )) as typeof fetch;
      assertEquals((await firecrawlSearch("web"))[0].source, "web");
    });

    await t.step("news only", async () => {
      globalThis.fetch = (() =>
        Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              news: [{ url: "https://example.com/news", title: "News" }],
            },
          }),
        )) as typeof fetch;
      assertEquals((await firecrawlSearch("news"))[0].source, "news");
    });

    await t.step("legacy data array", async () => {
      globalThis.fetch = (() =>
        Promise.resolve(
          jsonResponse({
            success: true,
            data: [{ url: "https://example.com/legacy", title: "Legacy" }],
          }),
        )) as typeof fetch;
      assertEquals((await firecrawlSearch("legacy"))[0].source, "web");
    });

    await t.step("empty object", async () => {
      globalThis.fetch = (() =>
        Promise.resolve(
          jsonResponse({ success: true, data: {} }),
        )) as typeof fetch;
      assertEquals(await firecrawlSearch("quiet day"), []);
    });
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("firecrawlSearch rejects malformed provider responses predictably", async (t) => {
  const originalFetch = globalThis.fetch;
  Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
  try {
    const cases: Array<{ name: string; response: Response; message: string }> =
      [
        {
          name: "invalid JSON",
          response: new Response("{", { status: 200 }),
          message: "firecrawl search returned invalid JSON",
        },
        {
          name: "missing data",
          response: jsonResponse({ success: true }),
          message:
            "firecrawl search returned a malformed response: missing data",
        },
        {
          name: "invalid data",
          response: jsonResponse({ success: true, data: "bad" }),
          message:
            "firecrawl search returned a malformed response: data must be an object or array",
        },
        {
          name: "invalid source collection",
          response: jsonResponse({ success: true, data: { web: {} } }),
          message: "firecrawl search returned malformed web results",
        },
        {
          name: "invalid source item",
          response: jsonResponse({ success: true, data: { news: [null] } }),
          message: "firecrawl search returned malformed news results",
        },
        {
          name: "provider failure payload",
          response: jsonResponse({
            success: false,
            error: "invalid search request",
            data: {},
          }),
          message: "firecrawl search failed: invalid search request",
        },
      ];

    for (const testCase of cases) {
      await t.step(testCase.name, async () => {
        globalThis.fetch = (() =>
          Promise.resolve(testCase.response.clone())) as typeof fetch;
        const error = await assertRejects(
          () => firecrawlSearch("test"),
          ApiError,
          testCase.message,
        );
        assertEquals(error.status, 502);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("firecrawlSearch maps non-2xx responses to a provider error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("rate limited", { status: 429 }),
      )) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const error = await assertRejects(
      () => firecrawlSearch("test"),
      ApiError,
      "firecrawl search failed: 429 rate limited",
    );
    assertEquals(error.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("firecrawlSearch aborts at its client-side deadline", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((_, init) =>
      new Promise<Response>((_, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const error = await assertRejects(
      () => firecrawlSearch("test", { abortAfterMs: 1 }),
      ApiError,
      "firecrawl search aborted after 1ms",
    );
    assertEquals(error.status, 504);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("firecrawlSearch keeps its abort fuse through response body parsing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((_, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      } as unknown as Response);
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const error = await assertRejects(
      () => firecrawlSearch("test", { abortAfterMs: 1 }),
      ApiError,
      "firecrawl search aborted after 1ms",
    );
    assertEquals(error.status, 504);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});
