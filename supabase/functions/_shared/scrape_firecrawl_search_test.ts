import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { firecrawlSearch } from "./scrape_firecrawl.ts";

Deno.test("firecrawlSearch normalizes web and news response shapes", async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  try {
    globalThis.fetch = ((_, init) => {
      const body = (init as { body?: BodyInit | null } | undefined)?.body;
      requests.push(JSON.parse(String(body ?? "{}")));
      return Promise.resolve(
        new Response(
          JSON.stringify({
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
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const hits = await firecrawlSearch("ai journalism", {
      sources: ["web", "news"],
      tbs: "qdr:m,sbd:1",
      location: "Sweden",
      country: "SE",
      ignoreInvalidURLs: true,
      excludeDomains: ["youtube.com"],
    });

    assertEquals(requests[0], {
      query: "ai journalism",
      limit: 10,
      ignoreInvalidURLs: true,
      sources: ["web", "news"],
      tbs: "qdr:m,sbd:1",
      location: "Sweden",
      country: "SE",
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
