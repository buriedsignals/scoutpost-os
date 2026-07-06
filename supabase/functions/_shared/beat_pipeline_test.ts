import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assertFalse } from "https://deno.land/std@0.208.0/assert/assert_false.ts";

import { buildGenerateQueriesPrompt } from "./beat_pipeline.ts";
import { runSearches } from "./beat_pipeline.ts";
import { aiFilterResults } from "./beat_pipeline.ts";
import { ensureBeatLocationSearchLabel } from "./beat_pipeline.ts";

Deno.test("buildGenerateQueriesPrompt treats no-location topic scouts as global topic scouts", () => {
  const { prompt } = buildGenerateQueriesPrompt({
    city: null,
    country: null,
    countryCode: null,
    criteria: "AI in journalism and newsrooms",
    category: "news",
  });

  assertStringIncludes(prompt, "global topic scout");
  assertStringIncludes(
    prompt,
    "Do NOT add city, country, regional, or local terms",
  );
  assertStringIncludes(prompt, "preserve every major concept");
  assertStringIncludes(prompt, "required_concepts");
  assertStringIncludes(prompt, "weak_terms");
  assertFalse(prompt.includes("For the target area"));
  assertFalse(prompt.includes("PRIMARY local language"));
  assertFalse(prompt.includes("Include the location name"));
});

Deno.test("buildGenerateQueriesPrompt keeps location-scoped topic scouts local", () => {
  const { prompt } = buildGenerateQueriesPrompt({
    city: "Montreal",
    country: "Canada",
    countryCode: "CA",
    criteria: "AI in journalism and newsrooms",
    category: "news",
  });

  assertStringIncludes(prompt, "For Montreal, Canada");
  assertStringIncludes(prompt, "PRIMARY local language");
  assertStringIncludes(prompt, "translate the key criteria terms");
  assertStringIncludes(
    prompt,
    'Include the full location label "Montreal Canada"',
  );
});

Deno.test("ensureBeatLocationSearchLabel appends ambiguous city disambiguator", () => {
  assertEquals(
    ensureBeatLocationSearchLabel("housing policy London", "London Ontario"),
    'housing policy London "London Ontario"',
  );
  assertEquals(
    ensureBeatLocationSearchLabel(
      "housing policy London, Ontario",
      "London Ontario",
    ),
    "housing policy London, Ontario",
  );
  assertEquals(
    ensureBeatLocationSearchLabel(
      "Ontario housing policy in London",
      "London Ontario",
    ),
    "Ontario housing policy in London",
  );
  assertEquals(
    ensureBeatLocationSearchLabel("housing policy", null),
    "housing policy",
  );
});

Deno.test("runSearches uses explicit web-only Firecrawl search by default", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  try {
    globalThis.fetch = ((_, init) => {
      const body = (init as { body?: BodyInit | null } | undefined)?.body;
      requests.push(JSON.parse(String(body ?? "{}")));
      const index = requests.length;
      const sources = requests[index - 1].sources as string[] | undefined;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              web: sources?.[0] === "web"
                ? [{
                  title: `Web ${index}`,
                  description: "AI newsroom policy",
                  url: `https://example.com/web-${index}`,
                }]
                : [],
              news: sources?.[0] === "news"
                ? [{
                  title: `News ${index}`,
                  snippet: "AI newsroom policy",
                  url: `https://example.com/news-${index}`,
                  date: "2 hours ago",
                }]
                : [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const hits = await runSearches({
      plan: {
        primary_language: "en",
        queries: ["AI journalism"],
        discovery_queries: ["Nieman Lab AI"],
        local_domains: [],
      },
      scope: "topic",
      excludedDomains: ["youtube.com"],
    });

    assertEquals(
      requests.map((r) => ({ sources: r.sources, tbs: r.tbs })),
      [
        { sources: ["web"], tbs: undefined },
        { sources: ["web"], tbs: undefined },
      ],
    );
    assertEquals(requests.every((r) => r.ignoreInvalidURLs === true), true);
    assertEquals(
      requests.every((r) =>
        JSON.stringify(r.excludeDomains) === JSON.stringify(["youtube.com"])
      ),
      true,
    );
    assertEquals(hits.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("runSearches passes Firecrawl location for location-scoped searches", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
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
                title: "Stockholm newsroom AI policy",
                description: "Swedish media coverage",
                url: "https://example.se/story",
              }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    await runSearches({
      plan: {
        primary_language: "sv",
        queries: ["AI journalistik Sverige"],
        discovery_queries: [],
        local_domains: [],
      },
      scope: "combined",
      lang: "sv",
      location: "Sweden",
      country: "SE",
    });

    assertEquals(requests[0].lang, "sv");
    assertEquals(requests[0].location, "Sweden");
    assertEquals(requests[0].country, "SE");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("runSearches can use Exa retrieval with Beat-compatible options", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  try {
    globalThis.fetch = ((input, init) => {
      const body = (init as { body?: BodyInit | null } | undefined)?.body;
      requests.push(JSON.parse(String(body ?? "{}")));
      assertStringIncludes(String(input), "api.exa.ai/search");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [{
              title: "Zurich procurement AI policy",
              text:
                "Zurich procurement officials discussed artificial intelligence.",
              url: "https://stadt-zuerich.example/procurement-ai",
              publishedDate: "2026-05-01T00:00:00Z",
              highlights: ["Zurich procurement officials discussed AI."],
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    Deno.env.set("EXA_API_KEY", "exa-test");

    const hits = await runSearches({
      plan: {
        primary_language: "de",
        queries: ["Zurich procurement AI"],
        discovery_queries: [],
        local_domains: [],
      },
      scope: "combined",
      category: "news",
      sourceMode: "reliable",
      country: "CH",
      excludedDomains: ["youtube.com"],
      retrievalPort: "exa",
    });

    assertEquals(requests.length, 1);
    assertEquals(requests[0].category, "news");
    assertEquals(requests[0].userLocation, "CH");
    assertEquals(requests[0].excludeDomains, ["youtube.com"]);
    assertEquals(typeof requests[0].startPublishedDate, "string");
    const contents = requests[0].contents as Record<string, unknown>;
    assertEquals(contents.highlights, true);
    assertEquals(hits[0].date, "2026-05-01T00:00:00Z");
    assertEquals(hits[0]._pass, "news");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("EXA_API_KEY");
  }
});

Deno.test("aiFilterResults backfills global topic floor only with topical candidates", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"keep":[0]}' }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    Deno.env.set("GEMINI_API_KEY", "test-key");

    const hits = await aiFilterResults(
      [
        {
          title:
            "Reuters asks EU to investigate AI search tools over publisher concerns",
          description: "Media journalism organizations and AI search policy",
          url: "https://example.com/reuters-ai-search",
        },
        {
          title: "Journalists compare AI newsroom policies",
          description:
            "Reporters and editors at media organizations are writing generative AI rules",
          url: "https://example.com/newsroom-ai-policy",
        },
        {
          title: "Hollywood uses AI in film production",
          description: "Entertainment industry production tools",
          url: "https://example.com/hollywood-ai",
        },
      ],
      {
        category: "news",
        sourceMode: "reliable",
        criteria:
          "AI in journalism newsrooms reporters editors media organizations",
        maxResults: 8,
      },
    );

    assertEquals(hits.map((h) => h.url), [
      "https://example.com/reuters-ai-search",
      "https://example.com/newsroom-ai-policy",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("GEMINI_API_KEY");
  }
});

Deno.test("aiFilterResults rejects AI-only drift for AI journalism topic", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{
              content: { parts: [{ text: '{"keep":[0,1,2]}' }] },
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    Deno.env.set("GEMINI_API_KEY", "test-key");

    const hits = await aiFilterResults(
      [
        {
          title: "Pentagon clears tech firms to deploy AI",
          description: "Military AI adoption on classified networks",
          url: "https://example.com/pentagon-ai",
        },
        {
          title: "Oscars 2026 rules add AI limits",
          description: "Film industry rule changes",
          url: "https://example.com/oscars-ai",
        },
        {
          title: "Journalism organizations publish guidance on generative AI",
          description:
            "Newsroom editors and reporters weigh disclosure policies",
          url: "https://example.com/newsroom-ai-policy",
        },
      ],
      {
        category: "news",
        sourceMode: "reliable",
        criteria: "AI in journalism",
        requiredConcepts: ["AI", "journalism"],
        weakTerms: ["AI"],
        maxResults: 8,
      },
    );

    assertEquals(hits.map((h) => h.url), [
      "https://example.com/newsroom-ai-policy",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("GEMINI_API_KEY");
  }
});

Deno.test("aiFilterResults fails closed for location scouts when the filter errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Gemini outage: non-OK response makes geminiExtract throw.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("upstream error", { status: 500 }),
      )) as typeof fetch;
    Deno.env.set("GEMINI_API_KEY", "test-key");

    const hits = await aiFilterResults(
      [
        {
          title: "London council approves new housing plan",
          description: "Camden borough development",
          url: "https://example.com/london-housing",
        },
        {
          title: "Berlin transit strike continues",
          description: "Germany rail disruption",
          url: "https://example.com/berlin-transit",
        },
      ],
      {
        category: "news",
        sourceMode: "reliable",
        cityName: "London",
        countryName: "United Kingdom",
        maxResults: 8,
      },
    );

    // Backstop keeps only the on-location candidate; it must NOT pass both
    // through (the pre-fix behavior that shipped off-location drift).
    assertEquals(hits.map((h) => h.url), [
      "https://example.com/london-housing",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("GEMINI_API_KEY");
  }
});

Deno.test("aiFilterResults returns no global topic results when only weak-side matches exist", async () => {
  const hits = await aiFilterResults(
    [
      {
        title: "Pentagon clears tech firms to deploy AI",
        description: "Military AI adoption on classified networks",
        url: "https://example.com/pentagon-ai",
      },
      {
        title: "Oscars 2026 rules add AI limits",
        description: "Film industry rule changes",
        url: "https://example.com/oscars-ai",
      },
    ],
    {
      category: "news",
      sourceMode: "reliable",
      criteria: "AI in journalism",
      requiredConcepts: ["AI", "journalism"],
      weakTerms: ["AI"],
      maxResults: 8,
    },
  );

  assertEquals(hits, []);
});
