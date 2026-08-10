import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  canonicalizeWebMarkdown,
  WEB_CANONICALIZER_VERSION,
  WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
  webCanonicalHash,
} from "./web_content_canonical.ts";

Deno.test("web canonicalizer exposes stable version", () => {
  assertEquals(WEB_CANONICALIZER_VERSION, "web-md-v1");
});

Deno.test("web scout fresh scrape options bypass Firecrawl cache", () => {
  assertEquals(WEB_SCOUT_FRESH_SCRAPE_OPTIONS, {
    maxAgeMs: 0,
    storeInCache: false,
  });
});

Deno.test("web canonicalizer ignores whitespace-only churn", async () => {
  const a = "# Title\n\nBody text\n\n[Story](https://example.com/story)\n";
  const b =
    "# Title\r\n\r\nBody text   \r\n\r\n\r\n[Story](https://example.com/story)";

  assertEquals(await webCanonicalHash(a), await webCanonicalHash(b));
});

Deno.test("web canonicalizer normalizes relative timestamps", async () => {
  const a = "# News\n\nUpdated 34 mins ago\n\nBody";
  const b = "# News\n\nUpdated 35 mins ago\n\nBody";

  assertEquals(await webCanonicalHash(a), await webCanonicalHash(b));
  assert(canonicalizeWebMarkdown(a).includes("<RELATIVE_TIME>"));
});

Deno.test("web canonicalizer suppresses image CDN churn while preserving article link", async () => {
  const a =
    "[![Harry Styles jumps on stage](https://ichef.bbci.co.uk/images/ic/1024x1024/p0hq72jn.png.webp)](https://www.bbc.com/news/articles/cq8p4qjv928o)";
  const b =
    "[![Harry Styles jumps on stage](https://ichef.bbci.co.uk/news/480/cpsprodpb/707e/live/story.jpg.webp)](https://www.bbc.com/news/articles/cq8p4qjv928o)";

  assertEquals(await webCanonicalHash(a), await webCanonicalHash(b));
  assertEquals(
    canonicalizeWebMarkdown(a),
    "[Harry Styles jumps on stage](https://www.bbc.com/news/articles/cq8p4qjv928o)",
  );
});

Deno.test("web canonicalizer treats article link changes as meaningful", async () => {
  const a =
    "[![Council meeting](https://cdn.example.org/a.jpg)](https://city.example.org/news/a)";
  const b =
    "[![Council meeting](https://cdn.example.org/a.jpg)](https://city.example.org/news/b)";

  assertNotEquals(await webCanonicalHash(a), await webCanonicalHash(b));
});

Deno.test("web canonicalizer treats headline/body changes as meaningful", async () => {
  const a = "# Council approves budget\n\nThe council approved $2m.";
  const b = "# Council delays budget\n\nThe council delayed $2m.";

  assertNotEquals(await webCanonicalHash(a), await webCanonicalHash(b));
});
