import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  canonicalizeWebMarkdown,
  WEB_CANONICALIZER_VERSION,
  WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
  webCanonicalHash,
  webComparisonContent,
} from "./web_content_canonical.ts";

Deno.test("web canonicalizer exposes stable version", () => {
  assertEquals(WEB_CANONICALIZER_VERSION, "web-md-v2");
});

Deno.test("web scout fresh scrape options bypass Firecrawl cache", () => {
  assertEquals(WEB_SCOUT_FRESH_SCRAPE_OPTIONS, {
    maxAgeMs: 0,
    storeInCache: false,
  });
});

Deno.test("Page comparison prefers a valid semantic projection and falls back to full markdown", () => {
  assertEquals(
    webComparisonContent({
      markdown: "full page",
      comparison_markdown: "main policy",
      comparison_strategy: "main",
      comparison_ratio: 0.8,
    }),
    { markdown: "main policy", strategy: "main", ratio: 0.8 },
  );
  assertEquals(
    webComparisonContent({
      markdown: "full page",
      comparison_markdown: "  ",
      comparison_strategy: "main",
    }),
    { markdown: "full page", strategy: "full", ratio: 1 },
  );
});

Deno.test("web canonicalizer ignores whitespace-only churn", async () => {
  const a = "# Title\n\nBody text\n\n[Story](https://example.com/story)\n";
  const b =
    "# Title\r\n\r\nBody text   \r\n\r\n\r\n[Story](https://example.com/story)";

  assertEquals(await webCanonicalHash(a), await webCanonicalHash(b));
});

Deno.test("web canonicalizer normalizes composed and decomposed Unicode to NFC", async () => {
  const composed = "# Caf\u00e9 policy";
  const decomposed = "# Cafe\u0301 policy";

  assertEquals(canonicalizeWebMarkdown(composed), composed);
  assertEquals(canonicalizeWebMarkdown(decomposed), composed);
  assertEquals(
    await webCanonicalHash(composed),
    await webCanonicalHash(decomposed),
  );
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

Deno.test("web canonicalizer suppresses standalone renderer identifiers", async () => {
  const before = "Policy body\n2507032178178457788\nSearch Help Center";
  const after = "Policy body\n16235620894640803440\nSearch Help Center";

  assertEquals(await webCanonicalHash(before), await webCanonicalHash(after));
  assertStringIncludes(
    canonicalizeWebMarkdown(before),
    "<VOLATILE_RENDER_ID>",
  );
});

Deno.test("web canonicalizer preserves long numbers embedded in content", async () => {
  const before = "Policy reference 2507032178178457788 remains applicable.";
  const after = "Policy reference 16235620894640803440 remains applicable.";

  assertNotEquals(
    await webCanonicalHash(before),
    await webCanonicalHash(after),
  );
});

Deno.test("web canonicalizer hashes standalone hex and UUID render IDs alike", async () => {
  assertEquals(
    await webCanonicalHash("Policy\n0123456789abcdef0123456789abcdef"),
    await webCanonicalHash("Policy\nfedcba9876543210fedcba9876543210"),
  );
  assertEquals(
    await webCanonicalHash("Policy\n123e4567-e89b-12d3-a456-426614174000"),
    await webCanonicalHash("Policy\n550e8400-e29b-41d4-a716-446655440000"),
  );
  assertNotEquals(
    await webCanonicalHash("Policy id 0123456789abcdef0123456789abcdef"),
    await webCanonicalHash("Policy id fedcba9876543210fedcba9876543210"),
  );
  assertNotEquals(
    await webCanonicalHash("Policy 123e4567-e89b-12d3-a456-426614174000"),
    await webCanonicalHash("Policy 550e8400-e29b-41d4-a716-446655440000"),
  );
});

Deno.test("web canonicalizer preserves compatibility characters and joiners", async () => {
  assertNotEquals(await webCanonicalHash("x²"), await webCanonicalHash("x2"));
  assertNotEquals(
    await webCanonicalHash("می‌خواهم"),
    await webCanonicalHash("میخواهم"),
  );
  assertNotEquals(await webCanonicalHash("👩‍💻"), await webCanonicalHash("👩💻"));
});

Deno.test("web canonicalizer removes tracking parameters but preserves locale selectors", async () => {
  const before =
    "[Policy](https://support.google.com/policy?hl=en&gl=it&visit_id=123&utm_source=mail)";
  const after =
    "[Policy](https://support.google.com/policy?utm_source=other&visit_id=456&gl=it&hl=en)";
  const otherLocale =
    "[Policy](https://support.google.com/policy?hl=de&gl=it&visit_id=456)";

  assertEquals(await webCanonicalHash(before), await webCanonicalHash(after));
  assertNotEquals(
    await webCanonicalHash(before),
    await webCanonicalHash(otherLocale),
  );
});

Deno.test("web canonicalizer normalizes unordered list presentation", async () => {
  assertEquals(
    await webCanonicalHash("* Software wallets\n+ Exchanges"),
    await webCanonicalHash("- Software wallets\n- Exchanges"),
  );
});
