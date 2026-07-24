import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  extractSubpageLinksFromHtml,
  extractSubpageLinksFromMarkdown,
  filterSubpageUrls,
  hasDeterministicListingSignal,
  isConfiguredPageUrl,
  isLikelyArticleUrl,
  isStrictChildUrl,
  pageScoutMetadataForUrlChange,
  primaryContentHtml,
  primaryContentText,
  renderIndexClassificationContent,
  selectPrimarySubpageLinks,
} from "./subpage-filter.ts";

Deno.test("Page Scout URL changes invalidate durable child membership", () => {
  const metadata = {
    page_scout_initial_candidates: ["https://example.test/old/a"],
    page_scout_active_candidates: ["https://example.test/old/a"],
    unrelated: "preserved",
  };
  assertEquals(
    pageScoutMetadataForUrlChange(
      "https://example.test/old/",
      "https://example.test/new/",
      metadata,
    ),
    { changed: true, metadata: { unrelated: "preserved" } },
  );
  assertEquals(
    pageScoutMetadataForUrlChange(
      "http://www.example.test/old/",
      "https://example.test/old",
      metadata,
    ),
    { changed: false, metadata },
  );
  assertEquals(
    pageScoutMetadataForUrlChange(
      "",
      "https://example.test/new/",
      metadata,
    ),
    { changed: true, metadata: { unrelated: "preserved" } },
  );
});

const INDEX = "https://www.example.ch/news/press-releases/";

Deno.test("primaryContentHtml excludes global navigation from index discovery", () => {
  const html = `
    <nav><a href="/news/press-releases/archive">Archive navigation</a></nav>
    <main><a href="/news/press-releases/item-a">Item A</a></main>
    <footer><a href="/news/press-releases/contact">Contact</a></footer>`;
  assertEquals(primaryContentHtml(html).includes("Archive navigation"), false);
  assertEquals(primaryContentHtml(html).includes("Item A"), true);
  assertEquals(primaryContentHtml(html).includes("Contact"), false);
});

Deno.test("provider-shell HTML and markdown links merge within the configured subtree", () => {
  const primary = [
    ["https://www.example.ch/news/press-releases/release-one", "Release one"],
  ] as [string, string][];
  const markdownWithChrome = [
    ["https://www.example.ch/news/press-releases/archive", "Archive"],
    ["https://www.example.ch/news/press-releases/release-two", "Release two"],
  ] as [string, string][];

  assertEquals(
    selectPrimarySubpageLinks(primary, markdownWithChrome, {
      hasRenderedHtml: true,
    }),
    [primary[0], ...markdownWithChrome],
  );
  assertEquals(
    filterSubpageUrls(
      selectPrimarySubpageLinks(primary, markdownWithChrome, {
        hasRenderedHtml: true,
      }).map(([url]) => url),
      INDEX,
    ),
    [
      "https://www.example.ch/news/press-releases/release-one",
      "https://www.example.ch/news/press-releases/archive",
      "https://www.example.ch/news/press-releases/release-two",
    ],
  );
  assertEquals(
    selectPrimarySubpageLinks([], markdownWithChrome),
    markdownWithChrome,
  );
});

Deno.test("rendered root indexes keep simple markdown descendants for provider-shell recovery", () => {
  const primary = [
    ["https://example.test/schedule", "Schedule"],
  ] as [string, string][];
  const markdown = [
    ["https://example.test/footer-help", "Help"],
    [
      "https://example.test/news/2026/07/24/new-report",
      "New report",
    ],
  ] as [string, string][];
  assertEquals(
    selectPrimarySubpageLinks(primary, markdown, {
      hasRenderedHtml: true,
    }),
    [
      ...primary,
      ["https://example.test/footer-help", "Help"],
      [
        "https://example.test/news/2026/07/24/new-report",
        "New report",
      ],
    ],
  );
});

Deno.test("index classification receives the same primary candidate surface as following", () => {
  const text = primaryContentText(`
    <nav>Global archive</nav>
    <main><h1>News</h1><a href="/news/item-a">Item A</a></main>
  `);
  const rendered = renderIndexClassificationContent(text, [[
    "https://www.example.ch/news/item-a",
    "Item A",
  ]]);
  assertEquals(rendered.includes("Global archive"), false);
  assertEquals(rendered.includes("News Item A"), true);
  assertEquals(
    rendered.includes("https://www.example.ch/news/item-a"),
    true,
  );
});

Deno.test("PS-INDEX-001 filterSubpageUrls keeps URLs under the index path", () => {
  const input = [
    "https://www.example.ch/news/press-releases/one",
    "https://www.example.ch/news/press-releases/two",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), input);
});

Deno.test("filterSubpageUrls drops URLs outside the index path", () => {
  const input = [
    "https://www.example.ch/news/press-releases/keep",
    "https://www.example.ch/contact",
    "https://www.example.ch/news/other-section/item",
    "https://www.example.ch/",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), [
    "https://www.example.ch/news/press-releases/keep",
  ]);
});

Deno.test("filterSubpageUrls rejects article-looking same-host routes outside the index path", () => {
  const index = "https://www.bzbasel.ch/gemeinde/arlesheim-4144";
  const article =
    "https://www.bzbasel.ch/aargau/fricktal/zeiningen-steiner-logistic-ag-wird-uebernommen-ld.4158147";
  assertEquals(filterSubpageUrls([article], index), []);
});

Deno.test("PS-HYROX-001 filterSubpageUrls rejects the audited HYROX Basel sibling navigation routes", () => {
  const index = "https://hyroxdach.com/de/event/hyrox-basel/";
  const siblings = [
    "https://hyroxdach.com/de/race-for-impact-charity-tickets",
    "https://hyroxdach.com/de/die-hyrox-familie",
    "https://hyroxdach.com/de/das-fitness-race",
    "https://hyroxdach.com/de/finde-dein-race",
  ];
  assertEquals(filterSubpageUrls(siblings, index), []);
});

Deno.test("filterSubpageUrls prefers strict child URLs when a listing path has them", () => {
  const index = "https://www.arlesheim.ch/de/aktuelles/";
  const target =
    "https://www.arlesheim.ch/de/aktuelles/aktuelle_meldungen/newsarchiv.php";
  const input = [
    "https://www.arlesheim.ch/de/verwaltung/abteilungen/finanzen-steuern.php",
    "https://www.arlesheim.ch/de/politik/gemeinderat/mitglieder.php",
    target,
  ];

  assertEquals(filterSubpageUrls(input, index), [target]);
});

Deno.test("filterSubpageUrls drops calendar/feed utility endpoints", () => {
  const event =
    "https://www.arlesheim.ch/de/veranstaltungen/4942_fasnachtsumzug.php";
  const input = [
    "https://www.arlesheim.ch/de/veranstaltungen/ical.php?i=4942",
    "https://www.arlesheim.ch/de/veranstaltungen/rss.php",
    event,
  ];

  assertEquals(
    filterSubpageUrls(input, "https://www.arlesheim.ch/de/veranstaltungen/"),
    [event],
  );
});

Deno.test("isStrictChildUrl requires same host and path-segment parentage", () => {
  const index = "https://www.arlesheim.ch/de/aktuelles/";
  assertEquals(
    isStrictChildUrl(
      "https://www.arlesheim.ch/de/aktuelles/aktuelle_meldungen/newsarchiv.php",
      index,
    ),
    true,
  );
  assertEquals(
    isStrictChildUrl(
      "https://www.arlesheim.ch/de/aktuelles-archiv/item.php",
      index,
    ),
    false,
  );
  assertEquals(
    isStrictChildUrl(
      "https://www.example.ch/de/aktuelles/aktuelle_meldungen/newsarchiv.php",
      index,
    ),
    false,
  );
});

Deno.test("PS-REDIRECT-001 configured page effective URL may normalize host/slash but not redirect to parent or sibling", () => {
  const configured = "https://www.example.ch/news/item/?lang=en";
  assertEquals(
    isConfiguredPageUrl(
      "http://example.ch/news/item?lang=en",
      configured,
    ),
    true,
  );
  assertEquals(
    isConfiguredPageUrl("https://example.ch/news/?lang=en", configured),
    false,
  );
  assertEquals(
    isConfiguredPageUrl(
      "https://example.ch/news/other/?lang=en",
      configured,
    ),
    false,
  );
  assertEquals(
    isConfiguredPageUrl("https://example.ch/news/item?lang=de", configured),
    false,
  );
  assertEquals(
    isConfiguredPageUrl(
      "https://example.ch:8443/news/item?lang=en",
      configured,
    ),
    false,
  );
});

Deno.test("filterSubpageUrls treats www and bare host as the same host", () => {
  const input = [
    "https://example.ch/news/press-releases/one",
    "https://www.example.ch/news/press-releases/two",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), input);
});

Deno.test("HTML extraction keeps absolute www children after a bare-host redirect", () => {
  const pageUrl = "https://example.ch/news/press-releases/";
  assertEquals(
    extractSubpageLinksFromHtml(
      '<main><a href="https://www.example.ch/news/press-releases/one">One</a></main>',
      pageUrl,
    ),
    [["https://www.example.ch/news/press-releases/one", "One"]],
  );
});

Deno.test("markdown extraction keeps absolute www children after a bare-host redirect", () => {
  const pageUrl = "https://example.ch/news/press-releases/";
  assertEquals(
    extractSubpageLinksFromMarkdown(
      "[One](https://www.example.ch/news/press-releases/one)",
      pageUrl,
    ),
    [["https://www.example.ch/news/press-releases/one", "One"]],
  );
});

Deno.test("filterSubpageUrls rejects cross-host paths even when the path matches", () => {
  const input = [
    "https://other.example.ch/news/press-releases/one",
    "https://evil.test/news/press-releases/two",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), []);
});

Deno.test("filterSubpageUrls rejects static assets under the index path", () => {
  const input = [
    "https://www.example.ch/news/press-releases/app.js",
    "https://www.example.ch/news/press-releases/photo.jpg",
    "https://www.example.ch/news/press-releases/ok",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), [
    "https://www.example.ch/news/press-releases/ok",
  ]);
});

Deno.test("filterSubpageUrls requires a path-segment separator (no prefix-only match)", () => {
  // Path that starts with the same bytes but is a sibling route, not a child.
  const input = ["https://www.example.ch/news/press-releases-archive/2024"];
  assertEquals(filterSubpageUrls(input, INDEX), []);
});

Deno.test("filterSubpageUrls blocks path traversal", () => {
  const input = [
    "https://www.example.ch/news/press-releases/../admin",
    "https://www.example.ch/news/press-releases/%2e%2e/admin",
    "https://www.example.ch/news/press-releases/%2E%2E/admin",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), []);
});

Deno.test("filterSubpageUrls rejects IP hosts and localhost via validateDomain", () => {
  // Path-prefix matches but the host is an IP / localhost → reject.
  const input = [
    "http://127.0.0.1/news/press-releases/leak",
    "http://localhost/news/press-releases/leak",
    "http://169.254.169.254/news/press-releases/leak",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), []);
});

Deno.test("filterSubpageUrls skips unparseable URLs", () => {
  const input = ["not-a-url", "https://www.example.ch/news/press-releases/ok"];
  assertEquals(filterSubpageUrls(input, INDEX), [
    "https://www.example.ch/news/press-releases/ok",
  ]);
});

Deno.test("filterSubpageUrls returns empty when indexUrl is unparseable", () => {
  const input = ["https://www.example.ch/news/press-releases/ok"];
  assertEquals(filterSubpageUrls(input, "not-a-url"), []);
});

Deno.test("filterSubpageUrls tolerates trailing slashes on the index URL", () => {
  const ok = "https://www.example.ch/news/press-releases/item";
  assertEquals(
    filterSubpageUrls([ok], "https://www.example.ch/news/press-releases"),
    [ok],
  );
  assertEquals(
    filterSubpageUrls([ok], "https://www.example.ch/news/press-releases/"),
    [ok],
  );
  assertEquals(
    filterSubpageUrls([ok], "https://www.example.ch/news/press-releases//"),
    [ok],
  );
});

Deno.test("filterSubpageUrls root indexes keep simple descendants and rank article routes first", () => {
  const input = [
    "https://www.example.ch/register",
    "https://www.example.ch/2026-05-04/council-approves-budget",
    "https://www.example.ch/kundenservice",
    "https://www.example.ch/story/headline-123456",
    "https://www.example.ch/news/today.html",
  ];
  assertEquals(filterSubpageUrls(input, "https://www.example.ch/"), [
    "https://www.example.ch/2026-05-04/council-approves-budget",
    "https://www.example.ch/story/headline-123456",
    "https://www.example.ch/news/today.html",
    "https://www.example.ch/register",
    "https://www.example.ch/kundenservice",
  ]);
});

Deno.test("isLikelyArticleUrl recognizes only concrete article route shapes", () => {
  assertEquals(
    isLikelyArticleUrl("https://example.ch/aargau/fricktal/story-ld.4158147"),
    true,
  );
  assertEquals(
    isLikelyArticleUrl("https://example.ch/region/2026-05-04/headline"),
    true,
  );
  assertEquals(isLikelyArticleUrl("https://example.ch/news/123456"), true);
  assertEquals(
    isLikelyArticleUrl("https://example.ch/news/headline-123456"),
    true,
  );
  assertEquals(isLikelyArticleUrl("https://example.ch/news/story.html"), true);
  assertEquals(isLikelyArticleUrl("https://example.ch/news/story.php"), true);
  assertEquals(isLikelyArticleUrl("https://example.ch/news/story.aspx"), true);
  assertEquals(isLikelyArticleUrl("https://example.ch/story/ld.4158147"), true);
  assertEquals(
    isLikelyArticleUrl(
      "https://gijn.org/resource/guide-mapping-analysis-qgis/",
    ),
    true,
  );
  assertEquals(
    isLikelyArticleUrl("https://huggingface.co/papers/2605.22355"),
    true,
  );
  assertEquals(
    isLikelyArticleUrl(
      "https://www.engadinerpost.ch/news/2026/05/06/Getruebte-Freude-im-Bildungshaus",
    ),
    true,
  );
  assertEquals(isLikelyArticleUrl("https://example.ch/news/contact"), false);
  assertEquals(isLikelyArticleUrl("https://example.ch/news/2026/05"), false);
  assertEquals(isLikelyArticleUrl("https://example.ch/news/rss.php"), false);
  assertEquals(isLikelyArticleUrl("https://example.ch/news/app.js"), false);
});

Deno.test("hasDeterministicListingSignal requires at least three article candidates", () => {
  const listing = "https://example.ch/news";
  const candidates = [
    "https://example.ch/a/story-ld.1",
    "https://example.ch/a/123456",
    "https://example.ch/a/story.html",
  ];
  const paperCandidates = [
    "https://huggingface.co/papers/2605.22355",
    "https://huggingface.co/papers/2605.22109",
    "https://huggingface.co/papers/2605.21467",
  ];
  assertEquals(
    hasDeterministicListingSignal(listing, candidates.slice(0, 2)),
    false,
  );
  assertEquals(hasDeterministicListingSignal(listing, candidates), true);
  assertEquals(
    hasDeterministicListingSignal(
      "https://huggingface.co/papers",
      paperCandidates,
    ),
    true,
  );
  assertEquals(
    hasDeterministicListingSignal(
      "https://example.ch/a/story-ld.1",
      candidates,
    ),
    false,
  );
});
