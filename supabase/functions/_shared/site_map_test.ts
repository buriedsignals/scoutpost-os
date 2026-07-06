import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mapSite } from "./site_map.ts";

type Handler = (url: string) => { status?: number; body: string; headers?: Record<string, string> } | null;

function stubFetch(handler: Handler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    const r = handler(url);
    if (!r) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(
      new Response(r.body, {
        status: r.status ?? 200,
        headers: r.headers ?? { "content-type": "application/xml" },
      }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("mapSite reads sitemap URLs from robots.txt and filters to the domain", async () => {
  const restore = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) {
      return { body: "User-agent: *\nSitemap: https://gov.example/sitemap.xml\n", headers: { "content-type": "text/plain" } };
    }
    if (url.endsWith("/sitemap.xml")) {
      return {
        body: `<?xml version="1.0"?><urlset>
          <url><loc>https://gov.example/meetings</loc></url>
          <url><loc>https://gov.example/agenda?id=1&amp;y=2</loc></url>
          <url><loc>https://other.com/off-domain</loc></url>
        </urlset>`,
      };
    }
    return null;
  });
  try {
    const urls = await mapSite("https://gov.example");
    assertEquals(urls.includes("https://gov.example/meetings"), true);
    assertEquals(urls.includes("https://gov.example/agenda?id=1&y=2"), true); // &amp; decoded
    assertEquals(urls.includes("https://other.com/off-domain"), false); // off-domain dropped
  } finally {
    restore();
  }
});

Deno.test("mapSite recurses one level into a sitemap index", async () => {
  const restore = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) return { body: "", headers: { "content-type": "text/plain" }, status: 404 };
    if (url.endsWith("/sitemap.xml")) {
      return {
        body: `<sitemapindex><sitemap><loc>https://gov.example/sm/child.xml</loc></sitemap></sitemapindex>`,
      };
    }
    if (url.endsWith("/sm/child.xml")) {
      return { body: `<urlset><url><loc>https://gov.example/deep/page</loc></url></urlset>` };
    }
    return null;
  });
  try {
    const urls = await mapSite("https://gov.example");
    assertEquals(urls, ["https://gov.example/deep/page"]);
  } finally {
    restore();
  }
});

Deno.test("mapSite includes subdomains by default and excludes them when off", async () => {
  const sitemap = `<urlset>
    <url><loc>https://sub.gov.example/x</loc></url>
    <url><loc>https://gov.example/y</loc></url>
  </urlset>`;
  const handler: Handler = (url) => {
    if (url.endsWith("/robots.txt")) return { body: "Sitemap: https://gov.example/sitemap.xml" };
    if (url.endsWith("/sitemap.xml")) return { body: sitemap };
    return null;
  };
  let restore = stubFetch(handler);
  try {
    const withSub = await mapSite("https://gov.example");
    assertEquals(withSub.includes("https://sub.gov.example/x"), true);
  } finally {
    restore();
  }
  restore = stubFetch(handler);
  try {
    const noSub = await mapSite("https://gov.example", { includeSubdomains: false });
    assertEquals(noSub.includes("https://sub.gov.example/x"), false);
    assertEquals(noSub.includes("https://gov.example/y"), true);
  } finally {
    restore();
  }
});

Deno.test("mapSite treats a two-label public suffix as one registrable domain", async () => {
  const restore = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) return { body: "Sitemap: https://council.gov.uk/sitemap.xml" };
    if (url.endsWith("/sitemap.xml")) {
      return { body: `<urlset><url><loc>https://www.council.gov.uk/minutes</loc></url></urlset>` };
    }
    return null;
  });
  try {
    const urls = await mapSite("https://council.gov.uk");
    assertEquals(urls.includes("https://www.council.gov.uk/minutes"), true);
  } finally {
    restore();
  }
});

Deno.test("mapSite falls back to link-harvest when no sitemap exists", async () => {
  const restore = stubFetch(() => null); // robots + sitemap both 404
  const originalScrapeEnv = Deno.env.get("SCRAPE_PROVIDER");
  Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
  // Re-stub fetch so the scrape port's firecrawl call returns rawHtml.
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.firecrawl.dev")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              rawHtml:
                '<a href="/meetings/2026">M</a> <a href="https://gov.example/agenda">A</a> <a href="https://elsewhere.org/x">off</a>',
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  try {
    const urls = await mapSite("https://gov.example");
    assertEquals(urls.includes("https://gov.example/meetings/2026"), true);
    assertEquals(urls.includes("https://gov.example/agenda"), true);
    assertEquals(urls.includes("https://elsewhere.org/x"), false);
  } finally {
    globalThis.fetch = original;
    restore();
    Deno.env.delete("FIRECRAWL_API_KEY");
    if (originalScrapeEnv) Deno.env.set("SCRAPE_PROVIDER", originalScrapeEnv);
  }
});

Deno.test("mapSite returns [] on an invalid target", async () => {
  assertEquals(await mapSite("not a url"), []);
});

Deno.test("mapSite respects the limit", async () => {
  const locs = Array.from({ length: 10 }, (_, i) => `<url><loc>https://gov.example/p${i}</loc></url>`).join("");
  const restore = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) return { body: "Sitemap: https://gov.example/sitemap.xml" };
    if (url.endsWith("/sitemap.xml")) return { body: `<urlset>${locs}</urlset>` };
    return null;
  });
  try {
    const urls = await mapSite("https://gov.example", { limit: 3 });
    assertEquals(urls.length, 3);
  } finally {
    restore();
  }
});

Deno.test("mapSite drops malformed loc URLs and a malformed robots Sitemap line", async () => {
  const restore = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) {
      // second Sitemap line is malformed → new URL throws → skipped
      return { body: "Sitemap: https://gov.example/sitemap.xml\nSitemap: ht!tp://%%%\n" };
    }
    if (url.endsWith("/sitemap.xml")) {
      return { body: `<urlset><url><loc>::::not a url</loc></url><url><loc>https://gov.example/ok</loc></url></urlset>` };
    }
    return null;
  });
  try {
    const urls = await mapSite("https://gov.example");
    assertEquals(urls, ["https://gov.example/ok"]);
  } finally {
    restore();
  }
});

Deno.test("mapSite returns [] when sitemap 500s and there is no fallback content", async () => {
  const restore = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) return { body: "Sitemap: https://gov.example/sitemap.xml" };
    if (url.endsWith("/sitemap.xml")) return { body: "err", status: 500 };
    return null;
  });
  // fallback scrape also fails (no firecrawl key → firecrawlScrape throws)
  Deno.env.delete("FIRECRAWL_API_KEY");
  try {
    const urls = await mapSite("https://gov.example");
    assertEquals(urls, []);
  } finally {
    restore();
  }
});

Deno.test("mapSite tolerates a fetch that throws (network error)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("network down"))) as typeof fetch;
  Deno.env.delete("FIRECRAWL_API_KEY");
  try {
    assertEquals(await mapSite("https://gov.example"), []);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("mapSite dedups repeated sitemap-index entries", async () => {
  let childHits = 0;
  const restore = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) return { body: "Sitemap: https://gov.example/sitemap.xml" };
    if (url.endsWith("/sitemap.xml")) {
      return { body: `<sitemapindex><sitemap><loc>https://gov.example/c.xml</loc></sitemap><sitemap><loc>https://gov.example/c.xml</loc></sitemap></sitemapindex>` };
    }
    if (url.endsWith("/c.xml")) {
      childHits++;
      return { body: `<urlset><url><loc>https://gov.example/p</loc></url></urlset>` };
    }
    return null;
  });
  try {
    const urls = await mapSite("https://gov.example");
    assertEquals(urls, ["https://gov.example/p"]);
    assertEquals(childHits, 1); // visited-set prevents the duplicate fetch
  } finally {
    restore();
  }
});

Deno.test("mapSite registrable-domain uses two labels for a non-suffix host", async () => {
  // target a.council.org → registrable "council.org"; a sibling subdomain of
  // that registrable domain is accepted, exercising the take=2 branch.
  const restore = stubFetch((url) => {
    if (url.endsWith("/robots.txt")) return { body: "Sitemap: https://a.council.org/sitemap.xml" };
    if (url.endsWith("/sitemap.xml")) {
      return { body: `<urlset><url><loc>https://b.council.org/x</loc></url></urlset>` };
    }
    return null;
  });
  try {
    const urls = await mapSite("https://a.council.org");
    assertEquals(urls.includes("https://b.council.org/x"), true);
  } finally {
    restore();
  }
});

Deno.test("mapSite fallback skips malformed hrefs", async () => {
  const restore = stubFetch(() => null); // no sitemap
  const original = globalThis.fetch;
  const restoreOuter = () => { globalThis.fetch = original; restore(); Deno.env.delete("FIRECRAWL_API_KEY"); };
  Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.firecrawl.dev")) {
      return Promise.resolve(new Response(
        JSON.stringify({ data: { rawHtml: '<a href="http://[bad">x</a><a href="/good">g</a>' } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    }
    return Promise.resolve(new Response("nf", { status: 404 }));
  }) as typeof fetch;
  try {
    const urls = await mapSite("https://gov.example");
    assertEquals(urls, ["https://gov.example/good"]);
  } finally {
    restoreOuter();
  }
});

Deno.test("mapSite aborts a hung request via the timeout fuse", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    })) as typeof fetch;
  Deno.env.delete("FIRECRAWL_API_KEY");
  try {
    // tiny fuse → the setTimeout(() => ac.abort()) callback fires
    assertEquals(await mapSite("https://gov.example", { timeoutMs: 5 }), []);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("mapSite fallback returns [] when the page has no rawHtml", async () => {
  const restore = stubFetch(() => null); // no sitemap
  const original = globalThis.fetch;
  Deno.env.set("FIRECRAWL_API_KEY", "fc-test");
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.firecrawl.dev")) {
      return Promise.resolve(new Response(
        JSON.stringify({ data: { markdown: "text but no rawHtml" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    }
    return Promise.resolve(new Response("nf", { status: 404 }));
  }) as typeof fetch;
  try {
    assertEquals(await mapSite("https://gov.example"), []);
  } finally {
    globalThis.fetch = original;
    restore();
    Deno.env.delete("FIRECRAWL_API_KEY");
  }
});

Deno.test("mapSite decompresses a gzipped sitemap", async () => {
  const xml = `<urlset><url><loc>https://gov.example/gz</loc></url></urlset>`;
  const gz = await new Response(
    new Response(xml).body!.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) {
      return Promise.resolve(new Response("Sitemap: https://gov.example/sitemap.xml.gz", { status: 200 }));
    }
    if (url.endsWith("/sitemap.xml.gz")) {
      return Promise.resolve(new Response(gz, { status: 200, headers: { "content-type": "application/gzip" } }));
    }
    return Promise.resolve(new Response("nf", { status: 404 }));
  }) as typeof fetch;
  try {
    const urls = await mapSite("https://gov.example");
    assertEquals(urls, ["https://gov.example/gz"]);
  } finally {
    globalThis.fetch = original;
  }
});
