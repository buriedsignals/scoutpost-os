/**
 * Tests for the deterministic extractive digest renderer.
 *
 * Covers summary/source grounding and location fact-coercion regressions.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type DigestArticle,
  digestExcerptText,
  digestLine,
  formatBeatDigest,
  verifyPlaceNamesGrounded,
} from "./extractive_summary.ts";

const goffstownNH: DigestArticle = {
  title: "Police chase ends in Goffstown, NH",
  url: "https://wmur.com/article/goffstown-nh-chase",
  excerpt:
    "A vehicle pursuit on Interstate 93 ended with the suspect in custody in Goffstown, New Hampshire on Tuesday.",
  domain: "wmur.com",
  publishedDate: "2026-05-21",
  category: "news",
};

const hartfordEvent: DigestArticle = {
  title: "Hartford housing crisis worsens",
  url: "https://courant.com/article/hartford-housing",
  excerpt:
    "Hartford City Council voted on Tuesday to extend the emergency housing program through next year.",
  domain: "courant.com",
  publishedDate: "2026-05-20",
  category: "government",
};

Deno.test("formatBeatDigest — empty input renders empty", () => {
  assertEquals(formatBeatDigest([]), "");
});

Deno.test("formatBeatDigest — single article uses one bullet, no LLM artifacts", () => {
  const out = formatBeatDigest([goffstownNH]);
  // One bullet only
  assertEquals(out.split("\n").length, 1);
  // Bullet starts with "-"
  assert(out.startsWith("- "), `bullet must start with '- ', got: ${out}`);
  // URL is the real article URL
  assertStringIncludes(out, "https://wmur.com/article/goffstown-nh-chase");
  // Title is verbatim
  assertStringIncludes(out, "Police chase ends in Goffstown, NH");
});

Deno.test("formatBeatDigest — caps at maxBullets", () => {
  const articles: DigestArticle[] = Array.from({ length: 8 }, (_, i) => ({
    title: `Story ${i}`,
    url: `https://example.com/${i}`,
    excerpt: `Excerpt ${i}.`,
    domain: "example.com",
  }));
  const out = formatBeatDigest(articles, { maxBullets: 3 });
  assertEquals(out.split("\n").length, 3);
});

Deno.test("digestLine — never invents content", () => {
  const line = digestLine(goffstownNH, "en");
  // Date should appear (formatted)
  assertStringIncludes(line, "May");
  // No generative phrasing like "summary" or "in summary"
  assertEquals(/\bin summary\b/i.test(line), false);
  // Excerpt sourced from input excerpt — substring match
  assertStringIncludes(line, "Interstate 93");
});

// ---- BUG-020: every URL in the digest must be in the article cards ------

Deno.test("verifyPlaceNamesGrounded — URLs not in cards flagged", () => {
  const digestText =
    "- 📰 [unrelated](https://attacker.example/fake) story body";
  const v = verifyPlaceNamesGrounded(digestText, [goffstownNH]);
  assertEquals(v.ok, false);
  assertEquals(v.offendingUrls, ["https://attacker.example/fake"]);
});

Deno.test("verifyPlaceNamesGrounded — all card URLs allowed", () => {
  const articles = [goffstownNH, hartfordEvent];
  const digestText = formatBeatDigest(articles);
  const v = verifyPlaceNamesGrounded(digestText, articles);
  assertEquals(v.offendingUrls.length, 0);
});

// ---- BUG-023: Goffstown CT/NH coercion fixture --------------------------
// The QA report describes an LLM that, when scoped to a CT town, rewrote a
// Goffstown, NH story into "Goffstown, Connecticut" in the digest. With the
// deterministic renderer, the title and excerpt remain verbatim — Goffstown
// stays attached to "NH" / "New Hampshire". When the scout is anchored to a
// different city (Hartford), the digest must not assert Goffstown without
// some article actually being about Goffstown.

Deno.test("verifyPlaceNamesGrounded — Goffstown stays grounded when sourced", () => {
  // Scout anchored on Hartford. Goffstown article is part of the set →
  // Goffstown is grounded → ok.
  const digestText = formatBeatDigest([hartfordEvent, goffstownNH]);
  const v = verifyPlaceNamesGrounded(digestText, [
    hartfordEvent,
    goffstownNH,
  ], "Hartford");
  assertEquals(
    v.offendingTokens,
    [],
    `Goffstown appears in a card title; should be grounded. Got: ${
      JSON.stringify(v.offendingTokens)
    }`,
  );
  assertEquals(v.ok, true);
});

Deno.test("verifyPlaceNamesGrounded — fabricated place name caught", () => {
  // A digest sentence asserts "Goffstown, Connecticut" but only Hartford
  // article is in the cards. Goffstown is NOT in any title or excerpt.
  const fabricatedDigest =
    "- 📰 Police chase ends in Goffstown, Connecticut ([courant.com](https://courant.com/article/hartford-housing))";
  const v = verifyPlaceNamesGrounded(
    fabricatedDigest,
    [hartfordEvent],
    "Hartford",
  );
  assertEquals(v.ok, false);
  assert(
    v.offendingTokens.some((t) => t.toLowerCase().includes("goffstown")),
    `Goffstown should be flagged as ungrounded; got: ${
      JSON.stringify(v.offendingTokens)
    }`,
  );
});

Deno.test("verifyPlaceNamesGrounded — language pass-through, no translation", () => {
  const swissArticle: DigestArticle = {
    title: "Pontresina Gemeindeversammlung beschliesst Budget",
    url: "https://engadinerpost.ch/2026/pontresina-budget",
    excerpt:
      "Die Gemeindeversammlung in Pontresina hat am Montag den Haushalt für 2027 genehmigt.",
    domain: "engadinerpost.ch",
    publishedDate: "2026-05-20",
    category: "government",
  };
  const out = formatBeatDigest([swissArticle], { language: "de" });
  // No translation — German strings remain German verbatim
  assertStringIncludes(out, "Gemeindeversammlung");
  assertStringIncludes(out, "Pontresina");
  const v = verifyPlaceNamesGrounded(out, [swissArticle], "Pontresina");
  assertEquals(v.ok, true);
});

Deno.test("formatBeatDigest — sanity round-trip with verifyPlaceNamesGrounded", () => {
  const articles = [goffstownNH, hartfordEvent];
  const out = formatBeatDigest(articles);
  // Should produce 2 bullets, both verifiably grounded.
  assertEquals(out.split("\n").length, 2);
  const v = verifyPlaceNamesGrounded(out, articles);
  assertEquals(
    v.ok,
    true,
    `round-trip should always pass; got: ${JSON.stringify(v)}`,
  );
});

Deno.test("digest excerpts normalize Markdown before truncation and grounding", () => {
  const cases = [
    ["See [Chicago](https://example.org/report#chicago).", "See Chicago."],
    ["See [report](https://example.org/report_(2021)).", "See report."],
    [
      "See [the **Chicago** report](https://example.org/report).",
      "See the Chicago report.",
    ],
    ["See [report [2021]](https://example.org/report).", "See report [2021]."],
    [
      "See [Chicago][city].\n\n[city]: https://example.org/report#chicago",
      "See Chicago.",
    ],
    ["![Chart](https://example.org/chart.png) results", "Chart results"],
    ["See <https://example.org/report>.", "See https://example.org/report."],
    ["Chicago approved the proposal.", "Chicago approved the proposal."],
    ["- First\n- Second", "First Second"],
    [
      "| City | Result |\n| --- | --- |\n| Chicago | Approved |",
      "City Result Chicago Approved",
    ],
    ["Before <b>Chicago</b> after", "Before Chicago after"],
    ["> Chicago approved housing.", "Chicago approved housing."],
    ["```text\nChicago approved housing.\n```", "Chicago approved housing."],
  ];
  for (const [input, expected] of cases) {
    assertEquals(digestExcerptText(input), expected);
  }
});

Deno.test("Vera source navigation cannot block the digest notification", () => {
  const url =
    "https://www.vera.org/beyond-jails-community-based-strategies-for-public-safety";
  const sourceExcerpt = `November 2021
#### Watch these ideas in action:
[Chicago, IL](${url}#chicago) | [Tucson, AZ](${url}#tucson) | [Denver, CO](${url}#denver) | [Baltimore, MD](${url}#baltimore)
For decades, the United States has responded to social issues like mental health and substance use crises, chronic homelessness, and ongoing cycles of interpersonal violence with jail.`;
  const raw = {
    ...goffstownNH,
    title: "Beyond Jails",
    url,
    excerpt: sourceExcerpt,
    publishedDate: null,
  };
  assertEquals(
    verifyPlaceNamesGrounded(formatBeatDigest([raw]), [raw]).offendingUrls,
    [`${url}#chicago`],
  );
  // The same normalized article must feed rendering and the grounding corpus.
  const article = { ...raw, excerpt: digestExcerptText(raw.excerpt) };
  const digest = formatBeatDigest([article]);
  assertStringIncludes(digest, `](${url})`);
  assertStringIncludes(digest, "Chicago, IL");
  assertEquals(digest.includes("#chicago"), false);
  assertEquals(verifyPlaceNamesGrounded(digest, [article], "Chicago").ok, true);
  assertEquals(
    verifyPlaceNamesGrounded(
      digest + " [unlisted](https://example.org/unlisted)",
      [article],
      "Chicago",
    ).ok,
    false,
  );
  assertEquals(
    verifyPlaceNamesGrounded(digest + " in Atlantis", [article], "Chicago").ok,
    false,
  );
  assertStringIncludes(raw.excerpt, "#chicago");
});

Deno.test("normalized place names remain grounded and long link destinations do not consume excerpt space", () => {
  const article = {
    ...goffstownNH,
    excerpt: digestExcerptText(
      "Officials in New **York** City approved [housing](https://example.org/" +
        "x".repeat(400) + ") today.",
    ),
  };
  const digest = formatBeatDigest([article]);
  assertStringIncludes(
    digest,
    "Officials in New York City approved housing today.",
  );
  assertEquals(
    verifyPlaceNamesGrounded(digest, [article], "Hartford").ok,
    true,
  );
});
