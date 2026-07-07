import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { firecrawlScrape } from "./scrape_firecrawl.ts";

function withEnv(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
    const originalFetch = globalThis.fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
      Deno.env.delete("FIRECRAWL_API_KEY");
    }
  };
}

Deno.test(
  "firecrawlScrape adds the full-page screenshot format on a snapshot hint (KTD9) and maps the CDN url",
  withEnv(async () => {
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = ((_input, init) => {
      seenBody = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              markdown: "# page",
              rawHtml: "<html>page</html>",
              screenshot: "https://cdn.firecrawl.dev/s.png",
              metadata: { sourceURL: "https://x.example/final", statusCode: 200 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const result = await firecrawlScrape("https://x.example", { snapshot: true });
    const formats = seenBody.formats as Array<unknown>;
    // rawHtml already present (not duplicated) + the screenshot object appended.
    assert(formats.includes("rawHtml"));
    assert(
      formats.some((f) =>
        typeof f === "object" && f !== null &&
        (f as { type?: string }).type === "screenshot" &&
        (f as { fullPage?: boolean }).fullPage === true
      ),
    );
    assertEquals(result.screenshot_url, "https://cdn.firecrawl.dev/s.png");
    assertEquals(result.rawHtml, "<html>page</html>");
  }),
);

Deno.test(
  "firecrawlScrape omits screenshot_url without a snapshot hint",
  withEnv(async () => {
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = ((_input, init) => {
      seenBody = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              markdown: "# page",
              screenshot: "https://cdn.firecrawl.dev/s.png",
              metadata: {},
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    const result = await firecrawlScrape("https://x.example");
    const formats = seenBody.formats as Array<unknown>;
    assert(!formats.some((f) => typeof f === "object")); // no screenshot format object
    assertEquals(result.screenshot_url, undefined); // ignored when not requested
  }),
);

Deno.test(
  "firecrawlScrape appends rawHtml when a caller passes a formats list without it",
  withEnv(async () => {
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = ((_input, init) => {
      seenBody = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { markdown: "x", metadata: {} } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    await firecrawlScrape("https://x.example", {
      formats: ["markdown"],
      snapshot: "on_fallback",
    });
    const formats = seenBody.formats as Array<unknown>;
    assert(formats.includes("rawHtml")); // added because snapshot needs it
  }),
);
