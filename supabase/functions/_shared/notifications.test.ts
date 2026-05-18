/**
 * Unit tests for the shared notification helpers. Pure-function coverage only —
 * no network. Run:
 *
 *   deno test --allow-env supabase/functions/_shared/notifications.test.ts
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildBaseHtml,
  buildPageScoutMatchedArticles,
  buildProfileUrl,
  escapeHtml,
  groupFactsBySource,
  markdownToHtml,
  renderArticleCards,
} from "./notifications.ts";
import {
  EMAIL_STRINGS,
  getString,
  SUPPORTED_LANGUAGES,
} from "./email_translations.ts";

function renderPageScoutHtml(lang = "en"): string {
  return buildBaseHtml({
    variant: "page",
    eyebrowLabel: getString("page_scout", lang),
    contextLabel: getString("scout_alert", lang),
    headerTitle: getString("scout_alert", lang),
    headerSubtitle: "Test Scout",
    summary: "Found one new fact matching your criteria.",
    articles: [{
      title: "Evidence page",
      url: "https://example.com/page",
      summary: "New agenda paragraph added.",
      source: "oaklandca.gov",
    }],
    articlesSectionTitle: getString("see_what_matched", lang),
    metadataPanels: [
      {
        label: getString("monitoring_url", lang),
        value: "https://example.com",
        href: "https://example.com",
      },
      {
        label: getString("criteria", lang),
        value: "climate action",
      },
    ],
    cueText: getString("page_scout_cue", lang),
    language: lang,
  });
}

function renderBeatScoutHtml(lang = "en"): string {
  return buildBaseHtml({
    variant: "beat",
    eyebrowLabel: getString("beat_scout", lang),
    contextLabel: "ZURICH, CH",
    headerTitle: getString("beat_scout", lang),
    headerSubtitle: "My Beat",
    summary: "- Fact A\n- Fact B\n- Fact C",
    articles: [
      { title: "Source 1", url: "https://a.example/1", summary: "Fact A" },
      { title: "Source 2", url: "https://b.example/2", summary: "Fact B" },
    ],
    articlesSectionTitle: getString("top_stories", lang),
    cueText: getString("beat_scout_cue", lang),
    secondarySection: {
      title: getString("government_municipal", lang),
      summary: "- Council advanced the ordinance.\n- Vote scheduled next week.",
      articles: [{
        title: "Council notes",
        url: "https://c.example/3",
        summary: "Minutes",
      }],
    },
    language: lang,
  });
}

function renderCivicScoutHtml(lang = "en"): string {
  return buildBaseHtml({
    variant: "civic",
    eyebrowLabel: getString("civic_scout", lang),
    contextLabel: getString("key_findings", lang),
    headerTitle: getString("civic_scout", lang),
    headerSubtitle: "Oakland Council",
    summary:
      "- **Commit to a 30% reduction** ([Oakland minutes](https://oakland.example/m.pdf))",
    articles: [],
    articlesSectionTitle: "",
    cueText: getString("civic_scout_cue", lang),
    language: lang,
  });
}

function renderSocialScoutHtml(lang = "en", withRemoved = false): string {
  return buildBaseHtml({
    variant: "social",
    eyebrowLabel: getString("social_scout", lang),
    contextLabel: "@somehandle on X",
    headerTitle: getString("social_scout", lang),
    headerSubtitle: "Mayor watch",
    summary: "2 new posts:\n- post one\n- post two",
    articles: [
      {
        title: "@somehandle",
        url: "https://twitter.com/somehandle/status/1",
        summary: "post one",
        source: "x",
      },
    ],
    articlesSectionTitle: getString("new_posts", lang),
    metadataPanels: [{
      label: getString("profile_label", lang),
      value: "https://twitter.com/somehandle",
      href: "https://twitter.com/somehandle",
    }],
    cueText: getString("social_scout_cue", lang),
    cautionSection: withRemoved
      ? {
        title: getString("removed_posts", lang),
        items: [`${getString("removed_label", lang)} budget post removed`],
      }
      : undefined,
    language: lang,
  });
}

function renderDigestHtml(lang = "en"): string {
  return buildBaseHtml({
    variant: "digest",
    eyebrowLabel: getString("civic_digest", lang),
    contextLabel: getString("civic_scout", lang),
    headerTitle: getString("civic_digest", lang),
    headerSubtitle: getString("promise_due_today_plural", lang, { count: 3 }),
    summary:
      "- **Approve $12M transit fund** ([Resolution](https://oakland.example/resolution.pdf))\n" +
      "- **Hold a public hearing** ([Agenda](https://oakland.example/agenda.pdf))",
    articles: [],
    articlesSectionTitle: "",
    language: lang,
  });
}

function renderHealthHtml(lang = "en"): string {
  return buildBaseHtml({
    variant: "health",
    eyebrowLabel: getString("scout_health", lang),
    contextLabel: getString("beat_scout", lang).toUpperCase(),
    headerTitle: getString("scout_paused", lang),
    headerSubtitle: "Transit Watch",
    summary: getString("scout_paused_summary", lang, {
      name: "Transit Watch",
      count: 3,
    }),
    articles: [],
    articlesSectionTitle: "",
    metadataPanels: [
      {
        label: getString("scout_type", lang),
        value: getString("beat_scout", lang),
      },
      {
        label: getString("consecutive_failures", lang),
        value: "3",
      },
    ],
    language: lang,
  });
}

Deno.test("getString returns the English value for a known key", () => {
  assertEquals(getString("page_scout", "en"), "Page Scout");
});

Deno.test("getString falls back to English for an unknown language", () => {
  assertEquals(getString("beat_scout", "xx"), "Beat Scout");
});

Deno.test("getString returns the key itself when key is unknown", () => {
  assertEquals(getString("no_such_key_ever", "en"), "no_such_key_ever");
});

Deno.test("getString interpolates {name} placeholders", () => {
  const out = getString("and_more", "en", { count: 7 });
  assert(out.includes("7"));
  assert(!out.includes("{count}"));
});

Deno.test("every supported language carries the full key set", () => {
  const enKeys = Object.keys(EMAIL_STRINGS.en).sort();
  for (const lang of SUPPORTED_LANGUAGES) {
    const langKeys = Object.keys(EMAIL_STRINGS[lang]).sort();
    assertEquals(langKeys, enKeys, `Language '${lang}' mismatch vs English`);
  }
});

Deno.test("escapeHtml neutralizes every HTML-sensitive char", () => {
  assertEquals(
    escapeHtml(`<script>alert("xss & 'oops'")</script>`),
    "&lt;script&gt;alert(&quot;xss &amp; &#39;oops&#39;&quot;)&lt;/script&gt;",
  );
});

Deno.test("escapeHtml tolerates null/undefined", () => {
  assertEquals(escapeHtml(null), "");
  assertEquals(escapeHtml(undefined), "");
});

Deno.test("markdownToHtml converts headers, bold, bullets and links", () => {
  const out = markdownToHtml(
    "## Title\n\n- **bold** item with [source](https://example.com)\n- plain item",
    "#ff0000",
  );
  assertStringIncludes(out, "<h2");
  assertStringIncludes(out, "<ul");
  assertStringIncludes(out, "<strong>bold</strong>");
  assertStringIncludes(out, 'href="https://example.com"');
  assertStringIncludes(out, "plain item");
});

Deno.test("markdownToHtml escapes HTML embedded in the source", () => {
  const out = markdownToHtml("<script>alert(1)</script>\n\nnormal");
  assert(!out.includes("<script>"), "raw script tag leaked into output");
  assertStringIncludes(out, "&lt;script&gt;");
});

Deno.test("markdownToHtml wraps bare text in a paragraph", () => {
  const html = markdownToHtml("just one line");
  assertStringIncludes(html, "<p");
  assertStringIncludes(html, "just one line");
});

Deno.test("groupFactsBySource dedups by source_url and caps to 5 by default", () => {
  const facts = [
    {
      source_url: "https://a.com",
      source_title: "A",
      source_domain: "a.com",
      statement: "s1",
    },
    {
      source_url: "https://a.com",
      source_title: "A",
      source_domain: "a.com",
      statement: "s2",
    },
    {
      source_url: "https://b.com",
      source_title: "B",
      source_domain: "b.com",
      statement: "s3",
    },
    {
      source_url: "https://c.com",
      source_title: "C",
      source_domain: "c.com",
      statement: "s4",
    },
    {
      source_url: "https://d.com",
      source_title: "D",
      source_domain: "d.com",
      statement: "s5",
    },
    {
      source_url: "https://e.com",
      source_title: "E",
      source_domain: "e.com",
      statement: "s6",
    },
    {
      source_url: "https://f.com",
      source_title: "F",
      source_domain: "f.com",
      statement: "s7",
    },
  ];
  const out = groupFactsBySource(facts);
  assertEquals(out.length, 5);
  assertEquals(out[0].url, "https://a.com");
  assert(out[0].summary?.startsWith("\u2022"));
  assertStringIncludes(out[0].summary ?? "", "s1");
  assertStringIncludes(out[0].summary ?? "", "s2");
});

Deno.test("groupFactsBySource keeps URL-less facts as separate entries", () => {
  const out = groupFactsBySource([
    { source_url: null, source_title: "no1", statement: "one" },
    { source_url: null, source_title: "no2", statement: "two" },
  ]);
  assertEquals(out.length, 2);
});

Deno.test("renderArticleCards caps at the requested limit", () => {
  const articles = Array.from({ length: 8 }, (_, i) => ({
    title: `t${i}`,
    url: `https://t${i}.com`,
    summary: "hi",
  }));
  const html = renderArticleCards(articles, "#123456", 3);
  const count = html.match(/<a href=/g)?.length ?? 0;
  assertEquals(count, 3);
});

Deno.test("renderArticleCards escapes title HTML", () => {
  const html = renderArticleCards(
    [{
      title: "<img onerror=x>",
      url: 'https://example.com/"><script>',
      summary: "",
    }],
    "#000",
  );
  assert(!html.includes("<img onerror"));
  assertStringIncludes(html, "&lt;img");
  assert(!html.includes('"><script>'));
});

Deno.test("buildBaseHtml uses the editorial shell instead of the legacy gradient card", () => {
  const html = renderBeatScoutHtml();
  assertStringIncludes(html, 'meta name="color-scheme" content="light dark"');
  assertStringIncludes(
    html,
    'meta name="supported-color-schemes" content="light dark"',
  );
  assertStringIncludes(html, 'bgcolor="#F6F1E8"');
  assertStringIncludes(html, "background: #F6F1E8");
  assertStringIncludes(html, "background: #FFFDF9");
  assertStringIncludes(html, "background: #FFFFFF");
  assertStringIncludes(html, "font-family: 'Courier New', Courier, monospace");
  assertStringIncludes(html, "color: #1F1A17");
  assertStringIncludes(html, "color: #4B433B");
  assertStringIncludes(html, "border-left: 3px solid #6B3FA0");
  assert(!html.includes("linear-gradient("));
  assert(!html.includes("border-radius"));
});

Deno.test("buildBaseHtml inlines all styles and includes the localized disclaimer", () => {
  const html = renderBeatScoutHtml("fr");
  assert(!html.includes("<link"));
  assert(!html.includes("<style"));
  assertStringIncludes(html, 'style="');
  assertStringIncludes(html, EMAIL_STRINGS.fr.email_disclaimer);
});

Deno.test("Page Scout renders metadata panels and matched content section", () => {
  const html = renderPageScoutHtml();
  assertStringIncludes(html, EMAIL_STRINGS.en.monitoring_url);
  assertStringIncludes(html, EMAIL_STRINGS.en.criteria);
  assertStringIncludes(html, EMAIL_STRINGS.en.see_what_matched);
  assertStringIncludes(html, EMAIL_STRINGS.en.page_scout_cue);
  assertStringIncludes(html, 'href="https://example.com/page"');
  assertStringIncludes(html, "New agenda paragraph added.");
});

Deno.test("Page Scout matched article uses exact subpage URL and excerpt", () => {
  const articles = buildPageScoutMatchedArticles({
    matchedUrl: "https://healthinsider.news/new-study",
    matchedTitle: "New study",
    matchedSummary: "The article added a correction and a new byline.",
  });
  assertEquals(articles, [{
    title: "New study",
    url: "https://healthinsider.news/new-study",
    summary: "The article added a correction and a new byline.",
    source: "healthinsider.news",
  }]);
});

Deno.test("Page Scout matched article renders without extracted title", () => {
  const articles = buildPageScoutMatchedArticles({
    matchedUrl: "https://healthinsider.news/articles/new-weight-loss-research",
    matchedTitle: null,
    matchedSummary: "New article content was detected.",
  });
  assertEquals(articles[0].title, "new weight loss research");
  const html = renderArticleCards(articles, "#123456");
  assertStringIncludes(
    html,
    'href="https://healthinsider.news/articles/new-weight-loss-research"',
  );
  assertStringIncludes(html, "New article content was detected.");
});

Deno.test("Page Scout key findings and matched section link the exact subpage", () => {
  const matchedUrl =
    "https://healthinsider.news/articles/2026-05-18-healthinsider-site.html";
  const matchedSummary =
    "ScoutpostBenchmarkSentinel article excerpt with a new byline and correction.";
  const html = buildBaseHtml({
    variant: "page",
    eyebrowLabel: getString("page_scout", "en"),
    contextLabel: getString("scout_alert", "en"),
    headerTitle: getString("scout_alert", "en"),
    headerSubtitle: "healthinsider-site",
    summary:
      `- New article posted: [Healthinsider site benchmark](${matchedUrl})\n` +
      "- Correction note and contributor byline added.",
    articles: buildPageScoutMatchedArticles({
      matchedUrl,
      matchedTitle: "Healthinsider site benchmark",
      matchedSummary,
    }),
    articlesSectionTitle: getString("see_what_matched", "en"),
    metadataPanels: [{
      label: getString("monitoring_url", "en"),
      value: "https://healthinsider.news/",
      href: "https://healthinsider.news/",
    }],
    cueText: getString("page_scout_cue", "en"),
    language: "en",
  });

  assertStringIncludes(html, EMAIL_STRINGS.en.key_findings);
  assertStringIncludes(html, EMAIL_STRINGS.en.see_what_matched);
  assertStringIncludes(html, `href="${matchedUrl}"`);
  assertStringIncludes(html, matchedSummary);
  assertEquals(html.split(`href="${matchedUrl}"`).length - 1, 2);
});

Deno.test("Page Scout omits matched section when there is no matched URL", () => {
  const articles = buildPageScoutMatchedArticles({
    matchedUrl: null,
    matchedTitle: "Ignored",
    matchedSummary: "Ignored",
  });
  const html = buildBaseHtml({
    variant: "page",
    eyebrowLabel: getString("page_scout", "en"),
    contextLabel: getString("scout_alert", "en"),
    headerTitle: getString("scout_alert", "en"),
    headerSubtitle: "Root fallback scout",
    summary: "The root page changed, but no matched subpage was available.",
    articles,
    articlesSectionTitle: articles.length > 0
      ? getString("see_what_matched", "en")
      : "",
    language: "en",
  });

  assertEquals(articles, []);
  assertStringIncludes(html, EMAIL_STRINGS.en.key_findings);
  assert(!html.includes(EMAIL_STRINGS.en.see_what_matched));
});

Deno.test("Beat Scout renders editorial digest section plus government section", () => {
  const html = renderBeatScoutHtml();
  assertStringIncludes(html, EMAIL_STRINGS.en.top_stories);
  assertStringIncludes(html, "Government &amp; Municipal");
  assertStringIncludes(html, "ZURICH, CH");
  assertStringIncludes(html, 'href="https://a.example/1"');
  assertStringIncludes(html, 'href="https://c.example/3"');
});

Deno.test("Civic Scout renders markdown promises with the civic cue", () => {
  const html = renderCivicScoutHtml();
  assertStringIncludes(html, "<strong>Commit to a 30% reduction</strong>");
  assertStringIncludes(html, 'href="https://oakland.example/m.pdf"');
  assertStringIncludes(html, EMAIL_STRINGS.en.civic_scout_cue);
});

Deno.test("Social Scout renders caution section only when removed posts exist", () => {
  const withoutRemoved = renderSocialScoutHtml("en", false);
  const withRemoved = renderSocialScoutHtml("en", true);
  assert(!withoutRemoved.includes(EMAIL_STRINGS.en.removed_posts));
  assertStringIncludes(withRemoved, EMAIL_STRINGS.en.removed_posts);
  assertStringIncludes(withRemoved, EMAIL_STRINGS.en.profile_label);
  assertStringIncludes(withRemoved, "background: #F7F3EC");
});

Deno.test("Civic Digest renders in the editorial shell", () => {
  const html = renderDigestHtml();
  assertStringIncludes(html, EMAIL_STRINGS.en.civic_digest);
  assertStringIncludes(
    html,
    EMAIL_STRINGS.en.promise_due_today_plural.replace("{count}", "3"),
  );
  assertStringIncludes(html, 'href="https://oakland.example/resolution.pdf"');
});

Deno.test("Scout health email renders localized health metadata", () => {
  const html = renderHealthHtml("de");
  assertStringIncludes(html, EMAIL_STRINGS.de.scout_health);
  assertStringIncludes(html, EMAIL_STRINGS.de.scout_paused);
  assertStringIncludes(html, EMAIL_STRINGS.de.scout_type);
  assertStringIncludes(html, EMAIL_STRINGS.de.consecutive_failures);
});

Deno.test("every notification type renders without errors in every supported language", () => {
  const renderers = {
    page: renderPageScoutHtml,
    beat: renderBeatScoutHtml,
    civic: renderCivicScoutHtml,
    social: (lang: string) => renderSocialScoutHtml(lang, true),
    digest: renderDigestHtml,
    health: renderHealthHtml,
  };

  for (const lang of SUPPORTED_LANGUAGES) {
    for (const [name, render] of Object.entries(renderers)) {
      const html = render(lang);
      assert(html.length > 0, `empty render for ${name}/${lang}`);
      assertStringIncludes(
        html,
        EMAIL_STRINGS[lang].email_disclaimer,
        `${name}/${lang} missing disclaimer`,
      );
    }
  }
});

Deno.test("base template has DOCTYPE and balanced major tags", () => {
  const html = renderBeatScoutHtml();
  const opens = (re: RegExp) => (html.match(re) ?? []).length;
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "<body");
  assertEquals(opens(/<body/g), opens(/<\/body>/g));
  assertEquals(opens(/<html/g), opens(/<\/html>/g));
});

Deno.test("buildProfileUrl maps known platforms and strips leading @", () => {
  assertEquals(
    buildProfileUrl("instagram", "@someone"),
    "https://instagram.com/someone",
  );
  assertEquals(buildProfileUrl("x", "handle"), "https://twitter.com/handle");
  assertEquals(
    buildProfileUrl("twitter", "handle"),
    "https://twitter.com/handle",
  );
  assertEquals(
    buildProfileUrl("facebook", "page"),
    "https://facebook.com/page",
  );
  assertEquals(buildProfileUrl("tiktok", "user"), "https://tiktok.com/@user");
});

Deno.test("buildProfileUrl falls back to a {platform}.com host for unknown platforms", () => {
  assertEquals(buildProfileUrl("unknown", "@me"), "https://unknown.com/me");
});

Deno.test("getString preserves Unicode without mangling", () => {
  assertStringIncludes(getString("email_disclaimer", "de"), "\u00e4");
  assertStringIncludes(getString("email_disclaimer", "fi"), "\u00e4");
});
