import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assertFalse } from "https://deno.land/std@0.208.0/assert/assert_false.ts";

import {
  addLocationNewsSeedQueries,
  aiFilterResults,
  buildFirecrawlRecencyTbs,
  buildGenerateQueriesPrompt,
  dedupeByEmbedding,
  discoverPriorityDomainHits,
  ensureBeatLocationSearchLabel,
  expandLinkedArticleCandidates,
  filterUsableBeatCandidates,
  getRecencyConfig,
  renderedArticleCandidates,
  runSearches,
  runSearchesWithMetadata,
  shouldRetrySparseSearch,
  summarizeSearchJobs,
} from "./beat_pipeline.ts";

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
    "housing policy London Ontario",
  );
  assertEquals(
    ensureBeatLocationSearchLabel(
      'housing policy "London Ontario"',
      "London Ontario",
    ),
    "housing policy London Ontario",
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

Deno.test("location-only news plans always include generic seeds within the query budget", () => {
  const plan = addLocationNewsSeedQueries(
    {
      primary_language: "en",
      queries: ["London politics", "London transport", "London health"],
      discovery_queries: ["London local newspapers"],
      local_domains: [],
    },
    {
      city: "London",
      state: null,
      country: "United Kingdom",
      countryCode: "GB",
      displayName: "London, United Kingdom",
      criteria: null,
      category: "news",
    },
    3,
  );

  assertEquals(plan.queries.length, 3);
  assertEquals(plan.queries[0], "latest local news London United Kingdom");
  assertEquals(
    plan.queries[1],
    "local government public services news London United Kingdom",
  );
  assertEquals(
    plan.queries[2],
    "police crime courts public safety news London United Kingdom",
  );
  assertEquals(new Set(plan.queries).size, plan.queries.length);
});

Deno.test("reliable location news keeps only a small undated fallback", () => {
  const recency = getRecencyConfig("location", "news", "reliable");
  assertEquals(recency.max_undated_news, 2);
  assertEquals(recency.max_undated_discovery, 2);
});

Deno.test("buildFirecrawlRecencyTbs preserves the configured 14-day provider window", () => {
  assertEquals(
    buildFirecrawlRecencyTbs(
      Math.max(
        getRecencyConfig("combined", "news", "reliable").news_days,
        getRecencyConfig("combined", "news", "reliable").discovery_days,
      ),
      new Date("2026-06-15T12:00:00Z"),
    ),
    "sbd:1,cdr:1,cd_min:6/1/2026,cd_max:6/15/2026",
  );
});

Deno.test("dedupeByEmbedding sends one ordered OpenRouter embedding batch", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  const first = [1, ...new Array(767).fill(0)];
  const second = [0, 1, ...new Array(766).fill(0)];
  try {
    globalThis.fetch = (async (_input, init) => {
      const body = (init as { body?: BodyInit | null } | undefined)?.body;
      requests.push(JSON.parse(String(body)));
      return new Response(
        JSON.stringify({
          model: "gemini-embedding-001",
          data: [
            { index: 1, embedding: second },
            { index: 0, embedding: first },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    Deno.env.set("OPENROUTER_API_KEY", "test-key");

    const hits = await dedupeByEmbedding([
      { title: "First", description: "Alpha", url: "https://a.example/1" },
      { title: "Second", description: "Beta", url: "https://b.example/2" },
    ], { threshold: 0.9 });

    assertEquals(requests.length, 1);
    assertEquals(requests[0].input, ["First. Alpha", "Second. Beta"]);
    assertEquals(requests[0].dimensions, 768);
    assertEquals(requests[0].input_type, "semantic_similarity");
    assertEquals(hits.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("OPENROUTER_API_KEY");
  }
});

Deno.test("dedupeByEmbedding preserves hits when the batch provider fails", async () => {
  const originalFetch = globalThis.fetch;
  const hits = [
    { title: "First", description: "Alpha", url: "https://a.example/1" },
    { title: "Second", description: "Beta", url: "https://b.example/2" },
  ];
  try {
    globalThis.fetch = (async () =>
      new Response("upstream error", { status: 503 })) as typeof fetch;
    Deno.env.set("OPENROUTER_API_KEY", "test-key");

    assertEquals(await dedupeByEmbedding(hits, { threshold: 0.9 }), hits);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("OPENROUTER_API_KEY");
  }
});

Deno.test("dedupeByEmbedding preserves hits when OpenRouter is not configured", async () => {
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  const hits = [
    { title: "First", description: "Alpha", url: "https://a.example/1" },
    { title: "Second", description: "Beta", url: "https://b.example/2" },
  ];
  try {
    Deno.env.delete("OPENROUTER_API_KEY");
    assertEquals(await dedupeByEmbedding(hits, { threshold: 0.9 }), hits);
  } finally {
    if (originalKey) Deno.env.set("OPENROUTER_API_KEY", originalKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
  }
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

Deno.test("runSearches passes Firecrawl location, country, and recency filters", async () => {
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
      location: "Sweden",
      country: "SE",
      tbs: buildFirecrawlRecencyTbs(
        14,
        new Date("2026-06-15T12:00:00Z"),
      ),
    });

    assertEquals(requests[0].location, "Sweden");
    assertEquals(requests[0].country, "SE");
    assertEquals(
      requests[0].tbs,
      "sbd:1,cdr:1,cd_min:6/1/2026,cd_max:6/15/2026",
    );
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("runSearches retries an empty recency-filtered search without tbs", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  try {
    globalThis.fetch = ((_, init) => {
      const body = (init as { body?: BodyInit | null } | undefined)?.body;
      const request = JSON.parse(String(body ?? "{}"));
      requests.push(request);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              web: request.tbs ? [] : [{
                title: "Fresh London planning decision",
                description: "London council approved new homes today",
                url: "https://example.co.uk/london-planning",
              }],
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
        queries: ["London planning news"],
        discovery_queries: [],
        local_domains: [],
      },
      location: "London United Kingdom",
      country: "GB",
      tbs: "sbd:1,cdr:1,cd_min:7/13/2026,cd_max:7/27/2026",
    });

    assertEquals(requests.length, 2);
    assertEquals(
      requests[0].tbs,
      "sbd:1,cdr:1,cd_min:7/13/2026,cd_max:7/27/2026",
    );
    assertEquals("tbs" in requests[1], false);
    assertEquals(hits.map((hit) => hit.url), [
      "https://example.co.uk/london-planning",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("section-page search hits promote bounded same-host article links", () => {
  const hits = expandLinkedArticleCandidates([{
    url: "https://www.standard.co.uk/news/london",
    title: "London news",
    description: [
      "[London](https://www.standard.co.uk/news/london)",
      "[Fire rips through London flats as crews respond](https://www.standard.co.uk/news/london/mitcham-fire-b1291323.html)",
      "[Council approves 2,200 homes on London green belt](https://www.standard.co.uk/news/london/bromley-homes-b1291222.html)",
      "[External London story](https://example.com/london-story)",
      "[Read more](https://www.standard.co.uk/news/london/ignored-b1291000.html)",
    ].join("\n"),
    _pass: "news",
    query: "London news",
  }]);

  assertEquals(
    filterUsableBeatCandidates(hits).map((hit) => ({
      url: hit.url,
      title: hit.title,
      pass: hit._pass,
      query: hit.query,
    })),
    [
      {
        url:
          "https://www.standard.co.uk/news/london/mitcham-fire-b1291323.html",
        title: "Fire rips through London flats as crews respond",
        pass: "news",
        query: "London news",
      },
      {
        url:
          "https://www.standard.co.uk/news/london/bromley-homes-b1291222.html",
        title: "Council approves 2,200 homes on London green belt",
        pass: "news",
        query: "London news",
      },
    ],
  );
});

Deno.test("rendered news landing pages promote links absent from search snippets", () => {
  const links = renderedArticleCandidates(
    {
      url: "https://www.bbc.co.uk/news/england/london",
      title: "London | Latest News & Updates | BBC News",
      description: "News for London",
      _pass: "news",
      query: "latest local news London",
    },
    {
      markdown: [
        "[Accessibility help](https://www.bbc.co.uk/accessibility/)",
        "[London weather](https://www.bbc.co.uk/weather/2643743)",
        "[Tomorrow's London weather](https://www.bbc.co.uk/weather/2643743/day1)",
        "[Police investigate fire at London flats](/news/articles/cabc123)",
        "[Council approves new homes](/news/articles/cdef456)",
        "[UK](https://www.bbc.co.uk/news/uk)",
        "[External](https://example.com/story)",
      ].join("\n"),
    },
  );

  assertEquals(
    links.map((hit) => ({
      url: hit.url,
      title: hit.title,
      date: hit.date,
      pass: hit._pass,
    })),
    [
      {
        url: "https://www.bbc.co.uk/news/articles/cabc123",
        title: "Police investigate fire at London flats",
        date: null,
        pass: "news",
      },
      {
        url: "https://www.bbc.co.uk/news/articles/cdef456",
        title: "Council approves new homes",
        date: null,
        pass: "news",
      },
    ],
  );
});

Deno.test("rendered article pages do not promote related links", () => {
  assertEquals(
    renderedArticleCandidates(
      {
        url: "https://www.bbc.co.uk/news/articles/cabc123",
        title: "Police investigate fire at London flats",
      },
      {
        markdown:
          "[Related story](https://www.bbc.co.uk/news/articles/cdef456)",
      },
    ),
    [],
  );
});

Deno.test("sparse usable search results trigger one relaxed recall pass", () => {
  assertEquals(
    shouldRetrySparseSearch({
      usableCount: 2,
      tbs: "qdr:w",
      allErrored: false,
    }),
    true,
  );
  assertEquals(
    shouldRetrySparseSearch({
      usableCount: 3,
      tbs: "qdr:w",
      allErrored: false,
    }),
    false,
  );
  assertEquals(
    shouldRetrySparseSearch({
      usableCount: 0,
      allErrored: false,
    }),
    false,
  );
  assertEquals(
    shouldRetrySparseSearch({
      usableCount: 0,
      tbs: "qdr:w",
      allErrored: true,
    }),
    false,
  );
});

Deno.test("runSearches dedupes URLs across Firecrawl jobs and preserves the first pass", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [{
                title: "Same story",
                description: "Shared result",
                url: "https://example.com/story",
                publishedDate: "2026-05-01T00:00:00Z",
              }],
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
        queries: ["first query"],
        discovery_queries: ["second query"],
        local_domains: [],
      },
    });

    assertEquals(hits.length, 1);
    assertEquals(hits[0].date, "2026-05-01T00:00:00Z");
    assertEquals(hits[0]._pass, "news");
    assertEquals(hits[0].query, "first query");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("runSearches preserves declared job order across mixed response latency", async () => {
  const originalFetch = globalThis.fetch;
  const firstResponse = Promise.withResolvers<Response>();
  try {
    globalThis.fetch = ((_, init) => {
      const body = JSON.parse(
        String((init as RequestInit | undefined)?.body ?? "{}"),
      ) as { query?: string };
      const response = new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [{
              title: body.query,
              url: "https://example.com/shared",
            }],
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
      return body.query === "first"
        ? firstResponse.promise
        : Promise.resolve(response);
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const result = runSearches({
      plan: {
        primary_language: "en",
        queries: ["first"],
        discovery_queries: ["second"],
        local_domains: [],
      },
      concurrency: 2,
    });
    await Promise.resolve();
    firstResponse.resolve(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [{
              title: "first",
              url: "https://example.com/shared",
            }],
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );

    assertEquals(await result, [{
      title: "first",
      url: "https://example.com/shared",
      description: undefined,
      markdown: undefined,
      date: null,
      source: "web",
      _pass: "news",
      query: "first",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("runSearchesWithMetadata distinguishes quiet empty jobs from total provider failure", async () => {
  const originalFetch = globalThis.fetch;
  const plan = {
    primary_language: "en",
    queries: ["one", "two"],
    discovery_queries: ["three"],
    local_domains: [],
  };
  try {
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: true, data: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;

    assertEquals(await runSearchesWithMetadata({ plan }), {
      hits: [],
      jobsAttempted: 3,
      jobsErrored: 0,
    });

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("provider down", { status: 503 }),
      )) as typeof fetch;

    assertEquals(await runSearchesWithMetadata({ plan }), {
      hits: [],
      jobsAttempted: 3,
      jobsErrored: 3,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("summarizeSearchJobs treats any successful empty job as a quiet search", () => {
  assertEquals(
    summarizeSearchJobs(
      { jobsAttempted: 2, jobsErrored: 0 },
      { jobsAttempted: 3, jobsErrored: 3 },
    ),
    {
      jobsAttempted: 5,
      jobsErrored: 3,
      allErrored: false,
    },
  );
  assertEquals(
    summarizeSearchJobs(
      { jobsAttempted: 2, jobsErrored: 2 },
      { jobsAttempted: 3, jobsErrored: 3 },
    ),
    {
      jobsAttempted: 5,
      jobsErrored: 5,
      allErrored: true,
    },
  );
});

Deno.test("discoverPriorityDomainHits uses Firecrawl domain filters and returns only usable matching hits", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  try {
    globalThis.fetch = ((_, init) => {
      const body = JSON.parse(
        String((init as RequestInit | undefined)?.body ?? "{}"),
      ) as Record<string, unknown>;
      requests.push(body);
      const domain = (body.includeDomains as string[])[0];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [
                {
                  title: `${domain} article`,
                  url: `https://${domain}/stories/article`,
                },
                {
                  title: "Wrong domain",
                  url: "https://other.example/stories/article",
                },
                {
                  title: "Homepage",
                  url: `https://${domain}/`,
                },
                {
                  title: "Excluded subdomain",
                  url: `https://ads.${domain}/stories/sponsored`,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const result = await discoverPriorityDomainHits({
      domains: [
        "www.one.example",
        "two.example",
        "blocked.example",
        "invalid",
      ],
      criteria: "AI policy",
      location: {
        city: "London",
        state: "Ontario",
        country: "Canada",
        countryCode: "CA",
        displayName: "London, Ontario, Canada",
      },
      excludedDomains: [
        "blocked.example",
        "ads.one.example",
        "ads.two.example",
        "youtube.com",
      ],
    });

    assertEquals(result.queries, [
      "AI policy London Ontario",
      "London Ontario news",
    ]);
    assertEquals(requests.length, 4);
    assertEquals(
      requests.every((request) => !("excludeDomains" in request)),
      true,
    );
    assertEquals(
      requests.map((request) => ({
        query: request.query,
        limit: request.limit,
        sources: request.sources,
        location: request.location,
        country: request.country,
        tbs: request.tbs,
        includeDomains: request.includeDomains,
        ignoreInvalidURLs: request.ignoreInvalidURLs,
      })),
      [
        {
          query: "AI policy London Ontario",
          limit: 5,
          sources: ["web"],
          location: "London Ontario",
          country: "CA",
          tbs: "qdr:m,sbd:1",
          includeDomains: ["one.example"],
          ignoreInvalidURLs: true,
        },
        {
          query: "London Ontario news",
          limit: 5,
          sources: ["web"],
          location: "London Ontario",
          country: "CA",
          tbs: "qdr:m,sbd:1",
          includeDomains: ["one.example"],
          ignoreInvalidURLs: true,
        },
        {
          query: "AI policy London Ontario",
          limit: 5,
          sources: ["web"],
          location: "London Ontario",
          country: "CA",
          tbs: "qdr:m,sbd:1",
          includeDomains: ["two.example"],
          ignoreInvalidURLs: true,
        },
        {
          query: "London Ontario news",
          limit: 5,
          sources: ["web"],
          location: "London Ontario",
          country: "CA",
          tbs: "qdr:m,sbd:1",
          includeDomains: ["two.example"],
          ignoreInvalidURLs: true,
        },
      ],
    );
    assertEquals(
      result.hits.map((hit) => hit.url),
      [
        "https://one.example/stories/article",
        "https://two.example/stories/article",
      ],
    );
    assertEquals(result.jobsAttempted, 4);
    assertEquals(result.jobsErrored, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("discoverPriorityDomainHits keeps criteria and location parity for London, United Kingdom", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  try {
    globalThis.fetch = ((_, init) => {
      const body = JSON.parse(
        String((init as RequestInit | undefined)?.body ?? "{}"),
      ) as Record<string, unknown>;
      requests.push(body);
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: { web: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    await discoverPriorityDomainHits({
      domains: ["priority.example"],
      criteria: "housing affordability",
      location: {
        city: "London",
        state: null,
        country: "United Kingdom",
        countryCode: "GB",
        displayName: "London, United Kingdom",
      },
    });

    assertEquals(
      requests.map((request) => ({
        query: request.query,
        location: request.location,
        country: request.country,
      })),
      [
        {
          query: "housing affordability London United Kingdom",
          location: "London United Kingdom",
          country: "GB",
        },
        {
          query: "London United Kingdom news",
          location: "London United Kingdom",
          country: "GB",
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("discoverPriorityDomainHits starts queued work as each worker frees", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  const gates = Array.from(
    { length: 4 },
    () => Promise.withResolvers<Response>(),
  );
  const thirdRequestStarted = Promise.withResolvers<void>();
  try {
    globalThis.fetch = ((_, init) => {
      requests.push(
        JSON.parse(
          String((init as RequestInit | undefined)?.body ?? "{}"),
        ) as Record<string, unknown>,
      );
      if (requests.length === 3) thirdRequestStarted.resolve();
      return gates[requests.length - 1].promise;
    }) as typeof fetch;
    Deno.env.set("FIRECRAWL_API_KEY", "fc-test");

    const result = discoverPriorityDomainHits({
      domains: ["one.example", "two.example"],
      criteria: "local housing",
      location: {
        city: "London",
        state: "Ontario",
        country: "Canada",
        countryCode: "CA",
        displayName: "London, Ontario, Canada",
      },
      concurrency: 2,
    });
    await Promise.resolve();
    assertEquals(requests.length, 2);

    gates[1].resolve(
      new Response(JSON.stringify({ success: true, data: { web: [] } }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await thirdRequestStarted.promise;
    assertEquals(requests.length, 3);

    for (const gate of [gates[0], gates[2], gates[3]]) {
      gate.resolve(
        new Response(JSON.stringify({ success: true, data: { web: [] } }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    await result;
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("aiFilterResults backfills global topic floor only with topical candidates", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"keep":[0]}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    Deno.env.set("OPENROUTER_API_KEY", "test-key");

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
    Deno.env.delete("OPENROUTER_API_KEY");
  }
});

Deno.test("aiFilterResults rejects AI-only drift for AI journalism topic", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"keep":[0,1,2]}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    Deno.env.set("OPENROUTER_API_KEY", "test-key");

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
    Deno.env.delete("OPENROUTER_API_KEY");
  }
});

Deno.test("aiFilterResults fails closed for location scouts when the filter errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // OpenRouter outage: non-OK response makes openRouterExtract throw.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("upstream error", { status: 500 }),
      )) as typeof fetch;
    Deno.env.set("OPENROUTER_API_KEY", "test-key");

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
    Deno.env.delete("OPENROUTER_API_KEY");
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
