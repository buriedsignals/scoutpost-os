/**
 * Tests for the Exa retrieval port (_shared/exa.ts).
 *
 * Network calls are stubbed via global fetch mock so the suite runs offline
 * and deterministically — no live Exa traffic in CI.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  exaSearch,
  type ExaSearchHit,
  exaSearchWithMetadata,
  normalizeRetrievalPort,
  resolveBeatRetrievalPort,
  shouldFallbackFromExa,
} from "./exa.ts";

async function withEnv<T>(
  vars: Record<string, string | null>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) originals[k] = Deno.env.get(k);
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

async function withFetch<T>(
  handler: (input: string | URL | Request, init?: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; body: unknown }> }> {
  const calls: Array<{ url: string; body: unknown }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const bodyStr = init?.body ? String(init.body) : "";
    let parsed: unknown = bodyStr;
    try {
      parsed = bodyStr ? JSON.parse(bodyStr) : null;
    } catch {
      /* leave raw */
    }
    calls.push({ url, body: parsed });
    return Promise.resolve(handler(input, init));
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = orig;
  }
}

const FAKE_RESPONSE = {
  results: [
    {
      url: "https://www.engadinerpost.ch/news/2026/04/21/Hotel-Flaz",
      title: "Hotel Flaz: Voraussichtlich im Juni fahren die Bagger auf",
      text: "Erste Bauarbeiten am Hotel Flaz starten im Juni 2026.",
      publishedDate: "2026-04-21T00:00:00Z",
      highlights: ["Erste Bauarbeiten am Hotel Flaz starten im Juni 2026."],
      score: 0.92,
    },
    {
      url: "https://www.engadinerpost.ch/news/2026/03/23/Pontresina-Bahnhof",
      title: "Pontresiner Bahnhofsareal vor grossem Wandel",
      text: "Die Umgestaltung beginnt 2027.",
      publishedDate: "2026-03-23T00:00:00Z",
      highlights: ["Die Umgestaltung beginnt 2027."],
      score: 0.88,
    },
  ],
  costDollars: { total: 0.007 },
  requestId: "test-req-1",
};

Deno.test("exaSearch — throws when EXA_API_KEY missing", async () => {
  await withEnv({ EXA_API_KEY: null }, async () => {
    await assertRejects(
      () => exaSearch("anything"),
      Error,
      "EXA_API_KEY not configured",
    );
  });
});

Deno.test("exaSearch — shapes body with all Beat-relevant params", async () => {
  await withEnv({ EXA_API_KEY: "test_key" }, async () => {
    const { calls } = await withFetch(
      () =>
        new Response(JSON.stringify(FAKE_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      () =>
        exaSearch("Pontresina news", {
          category: "news",
          userLocation: "CH",
          includeDomains: ["engadinerpost.ch"],
          excludeDomains: ["tripadvisor.com"],
          startPublishedDate: "2026-01-01T00:00:00Z",
          numResults: 25,
          type: "auto",
          contents: { highlights: true, maxAgeHours: 72 },
        }),
    );

    assertEquals(calls.length, 1);
    const body = calls[0].body as Record<string, unknown>;
    assertEquals(body.query, "Pontresina news");
    assertEquals(body.type, "auto");
    assertEquals(body.numResults, 25);
    assertEquals(body.category, "news");
    assertEquals(body.userLocation, "CH");
    assertEquals(body.includeDomains, ["engadinerpost.ch"]);
    assertEquals(body.excludeDomains, ["tripadvisor.com"]);
    assertEquals(body.startPublishedDate, "2026-01-01T00:00:00Z");
    const contents = body.contents as Record<string, unknown>;
    assertEquals(contents.highlights, true);
    assertEquals(contents.maxAgeHours, 72);
    assertStringIncludes(calls[0].url, "api.exa.ai/search");
  });
});

Deno.test("exaSearch — maps response into SearchHit-compatible shape", async () => {
  await withEnv({ EXA_API_KEY: "test_key" }, async () => {
    const { result } = await withFetch(
      () =>
        new Response(JSON.stringify(FAKE_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      () => exaSearch("Pontresina news", { numResults: 5 }),
    );

    assertEquals(result.length, 2);
    const first = result[0] as ExaSearchHit;
    assertEquals(
      first.url,
      "https://www.engadinerpost.ch/news/2026/04/21/Hotel-Flaz",
    );
    // Downstream Firecrawl-shaped consumers see SearchHit.date populated
    assertEquals(first.date, "2026-04-21T00:00:00Z");
    // Native Exa fields available on the superset
    assertEquals(first.publishedDate, "2026-04-21T00:00:00Z");
    assertEquals(
      first.highlights?.[0],
      "Erste Bauarbeiten am Hotel Flaz starten im Juni 2026.",
    );
    assertEquals(first.score, 0.92);
    // Description is truncated text
    assert(first.description && first.description.length > 0);
    // source defaults to "web" for compat
    assertEquals(first.source, "web");
  });
});

Deno.test("exaSearchWithMetadata — preserves cost and request metadata", async () => {
  await withEnv({ EXA_API_KEY: "test_key" }, async () => {
    const { result } = await withFetch(
      () =>
        new Response(
          JSON.stringify({
            ...FAKE_RESPONSE,
            resolvedSearchType: "auto",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      () => exaSearchWithMetadata("Pontresina news", { numResults: 5 }),
    );

    assertEquals(result.hits.length, 2);
    assertEquals(result.totalCostDollars, 0.007);
    assertEquals(result.requestId, "test-req-1");
    assertEquals(result.resolvedSearchType, "auto");
  });
});

Deno.test("exaSearch — wraps non-2xx response in ApiError shape", async () => {
  await withEnv({ EXA_API_KEY: "test_key" }, async () => {
    await withFetch(
      () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        await assertRejects(
          () => exaSearch("anything", { numResults: 5 }),
          Error,
          "exa search failed",
        );
      },
    );
  });
});

Deno.test("exaSearch — filters out empty-url results", async () => {
  await withEnv({ EXA_API_KEY: "test_key" }, async () => {
    const { result } = await withFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [
              { url: "", title: "ghost" },
              { url: "https://valid.example/article", title: "valid" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      () => exaSearch("query", { numResults: 5 }),
    );

    assertEquals(result.length, 1);
    assertEquals(result[0].url, "https://valid.example/article");
  });
});

// ---- resolveBeatRetrievalPort ------------------------------------------

Deno.test("normalizeRetrievalPort — accepts only known ports with trimmed case normalization", () => {
  assertEquals(normalizeRetrievalPort(" Exa "), "exa");
  assertEquals(normalizeRetrievalPort(" Firecrawl "), "firecrawl");
  assertEquals(normalizeRetrievalPort(""), null);
  assertEquals(normalizeRetrievalPort("search"), null);
  assertEquals(normalizeRetrievalPort(null), null);
});

Deno.test("resolveBeatRetrievalPort — env kill-switch wins over scout metadata", () => {
  return withEnv({ BEAT_RETRIEVAL: "firecrawl" }, () => {
    assertEquals(resolveBeatRetrievalPort({ retrieval: "exa" }), "firecrawl");
  });
});

Deno.test("resolveBeatRetrievalPort — env override tolerates case and whitespace", () => {
  return withEnv({ BEAT_RETRIEVAL: " Firecrawl " }, () => {
    assertEquals(resolveBeatRetrievalPort({ retrieval: "exa" }), "firecrawl");
  });
});

Deno.test("resolveBeatRetrievalPort — env=exa flips even when metadata absent", () => {
  return withEnv({ BEAT_RETRIEVAL: "exa" }, () => {
    assertEquals(resolveBeatRetrievalPort(null), "exa");
    assertEquals(resolveBeatRetrievalPort({}), "exa");
  });
});

Deno.test("resolveBeatRetrievalPort — per-scout override beats default", () => {
  return withEnv({ BEAT_RETRIEVAL: null }, () => {
    assertEquals(resolveBeatRetrievalPort({ retrieval: "exa" }), "exa");
    assertEquals(
      resolveBeatRetrievalPort({ retrieval: "firecrawl" }),
      "firecrawl",
    );
  });
});

Deno.test("resolveBeatRetrievalPort — per-scout override tolerates case and whitespace", () => {
  return withEnv({ BEAT_RETRIEVAL: null }, () => {
    assertEquals(resolveBeatRetrievalPort({ retrieval: " Exa " }), "exa");
    assertEquals(
      resolveBeatRetrievalPort({ retrieval: " Firecrawl " }),
      "firecrawl",
    );
  });
});

Deno.test("resolveBeatRetrievalPort — ignores invalid env values instead of breaking scout defaults", () => {
  return withEnv({ BEAT_RETRIEVAL: "disabled" }, () => {
    assertEquals(resolveBeatRetrievalPort(null), "exa");
    assertEquals(resolveBeatRetrievalPort({}), "exa");
    assertEquals(resolveBeatRetrievalPort({ retrieval: "firecrawl" }), "firecrawl");
  });
});

Deno.test("resolveBeatRetrievalPort — defaults to exa when unset everywhere", () => {
  return withEnv({ BEAT_RETRIEVAL: null }, () => {
    assertEquals(resolveBeatRetrievalPort(null), "exa");
    assertEquals(resolveBeatRetrievalPort({}), "exa");
    assertEquals(resolveBeatRetrievalPort({ retrieval: "junk" }), "exa");
  });
});

Deno.test("shouldFallbackFromExa — falls back only for low-coverage canaries", () => {
  assertEquals(
    shouldFallbackFromExa({
      requestedRetrieval: "exa",
      discoveredCount: 1,
      scoutMetadata: {},
    }),
    true,
  );
  assertEquals(
    shouldFallbackFromExa({
      requestedRetrieval: "exa",
      retrievalEnv: "exa",
      discoveredCount: 1,
      scoutMetadata: {},
    }),
    false,
  );
  assertEquals(
    shouldFallbackFromExa({
      requestedRetrieval: "exa",
      retrievalEnv: " Exa ",
      discoveredCount: 1,
      scoutMetadata: {},
    }),
    false,
  );
  assertEquals(
    shouldFallbackFromExa({
      requestedRetrieval: "exa",
      discoveredCount: 1,
      scoutMetadata: { exa_fallback: false },
    }),
    false,
  );
  assertEquals(
    shouldFallbackFromExa({
      requestedRetrieval: "firecrawl",
      discoveredCount: 0,
      scoutMetadata: {},
    }),
    false,
  );
  assertEquals(
    shouldFallbackFromExa({
      requestedRetrieval: "exa",
      discoveredCount: 2,
      scoutMetadata: {},
    }),
    false,
  );
});
