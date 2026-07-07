/**
 * Firecrawl v2 provider (SCRAPING-MIGRATION-PRD U2).
 *
 * Moved verbatim from the former `firecrawl.ts` — behavior unchanged. This is
 * one of two scrape providers behind the `_shared/scrape.ts` port; it is the
 * default until U7 flips `SCRAPE_PROVIDER=crawl4ai`, and is deleted in U8.
 *
 * Docs: https://docs.firecrawl.dev/api-reference
 */

import { ApiError } from "./errors.ts";
import type {
  ChangeTrackingOptions,
  ChangeTrackingResult,
  ScrapeOptions,
  ScrapeResult,
  SearchHit,
  SearchOptions,
} from "./scrape_types.ts";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

function firecrawlApiKey(): string {
  const k = Deno.env.get("FIRECRAWL_API_KEY");
  if (!k) throw new ApiError("FIRECRAWL_API_KEY not configured", 500);
  return k;
}

export async function firecrawlScrape(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const abortAfterMs = opts.abortAfterMs ?? timeoutMs + 5_000;

  // Same-fetch third-party capture (PAGE-ARCHIVE-PRD KTD9): a snapshot hint
  // (either mode) means this fetch must also deliver the capture artifacts —
  // rawHtml inline plus a full-page screenshot (short-lived CDN URL). Adding
  // these formats costs no extra credits (verified against Firecrawl billing
  // docs, 2026-07-07); one scrape stays one credit.
  const formats: Array<string | Record<string, unknown>> = [
    ...(opts.formats ?? ["markdown", "rawHtml"]),
  ];
  if (opts.snapshot) {
    if (!formats.includes("rawHtml")) formats.push("rawHtml");
    formats.push({ type: "screenshot", fullPage: true });
  }
  const body: Record<string, unknown> = {
    url,
    formats,
    onlyMainContent: opts.onlyMainContent ?? true,
    timeout: timeoutMs,
  };
  const pdfMode = opts.pdfMode === undefined ? "fast" : opts.pdfMode;
  if (pdfMode !== null) {
    body.parsers = [{ type: "pdf", mode: pdfMode }];
  }
  if (opts.maxAgeMs !== undefined) body.maxAge = opts.maxAgeMs;
  if (opts.storeInCache !== undefined) body.storeInCache = opts.storeInCache;

  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);
  let res: Response;
  try {
    res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${firecrawlApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(fuse);
    if ((e as { name?: string }).name === "AbortError") {
      throw new ApiError(
        `firecrawl scrape aborted after ${abortAfterMs}ms`,
        504,
      );
    }
    throw e;
  }
  clearTimeout(fuse);
  if (!res.ok) {
    throw new ApiError(
      `firecrawl scrape failed: ${res.status} ${await res.text()}`,
      502,
    );
  }
  const bodyJson = await res.json();
  const d = bodyJson?.data ?? {};
  const metadata = d.metadata ?? {};
  const sourceUrl =
    typeof metadata.sourceURL === "string" && metadata.sourceURL.trim()
      ? metadata.sourceURL
      : typeof metadata.url === "string" && metadata.url.trim()
      ? metadata.url
      : url;
  return {
    markdown: d.markdown ?? "",
    html: d.html,
    rawHtml: d.rawHtml ?? null,
    title: d.metadata?.title,
    metadata,
    requested_url: url,
    source_url: sourceUrl,
    fetched_at: new Date().toISOString(),
    status_code: typeof metadata.statusCode === "number"
      ? metadata.statusCode
      : undefined,
    ...(opts.snapshot && typeof d.screenshot === "string" && d.screenshot
      ? { screenshot_url: d.screenshot }
      : {}),
  };
}

/**
 * Firecrawl v2 /search endpoint. Returns up to `limit` SERP-style hits.
 *
 * Docs: https://docs.firecrawl.dev/api-reference/endpoint/search
 */
export async function firecrawlSearch(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const body: Record<string, unknown> = {
    query,
    limit: Math.min(Math.max(1, opts.limit ?? 10), 100),
    ignoreInvalidURLs: opts.ignoreInvalidURLs ?? true,
  };
  if (opts.sources?.length) body.sources = opts.sources;
  if (opts.categories?.length) body.categories = opts.categories;
  if (opts.lang) body.lang = opts.lang;
  if (opts.location) body.location = opts.location;
  if (opts.country) body.country = opts.country;
  if (opts.tbs) body.tbs = opts.tbs;
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains;
  if (opts.scrape) {
    body.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
  }

  const abortAfterMs = opts.abortAfterMs ?? 45_000;
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);
  let res: Response;
  try {
    res = await fetch(`${FIRECRAWL_BASE}/search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${firecrawlApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(fuse);
    if ((e as { name?: string }).name === "AbortError") {
      throw new ApiError(
        `firecrawl search aborted after ${abortAfterMs}ms`,
        504,
      );
    }
    throw e;
  }
  clearTimeout(fuse);
  if (!res.ok) {
    throw new ApiError(
      `firecrawl search failed: ${res.status} ${await res.text()}`,
      502,
    );
  }
  const j = await res.json();
  const data = j?.data;
  const hits: Array<Record<string, unknown> & { _source?: "web" | "news" }> =
    Array.isArray(data)
      ? data.map((h: Record<string, unknown>) => ({ ...h, _source: "web" }))
      : [
        ...((Array.isArray(data?.web) ? data.web : []) as Record<
          string,
          unknown
        >[]).map((h) => ({ ...h, _source: "web" as const })),
        ...((Array.isArray(data?.news) ? data.news : []) as Record<
          string,
          unknown
        >[]).map((h) => ({ ...h, _source: "news" as const })),
      ];
  return hits.map((h) => ({
    url: String(h.url ?? ""),
    title: typeof h.title === "string" ? h.title : undefined,
    description: typeof h.description === "string"
      ? h.description
      : typeof h.snippet === "string"
      ? h.snippet
      : undefined,
    markdown: typeof h.markdown === "string" ? h.markdown : undefined,
    date: typeof h.date === "string"
      ? h.date
      : typeof h.publishedDate === "string"
      ? h.publishedDate
      : null,
    source: h._source,
  })).filter((h: SearchHit) => h.url.length > 0);
}

/**
 * Firecrawl /map — enumerate links on a site without scraping each.
 *
 * Docs: https://docs.firecrawl.dev/api-reference/endpoint/map
 */
export async function firecrawlMap(
  url: string,
  opts: {
    limit?: number;
    includeSubdomains?: boolean;
    search?: string;
    sitemap?: "include" | "only" | "skip";
    ignoreQueryParameters?: boolean;
    ignoreCache?: boolean;
    timeoutMs?: number;
    /** Client-side AbortController fuse in ms. Defaults to (timeoutMs ?? 60_000) + 5000. */
    abortAfterMs?: number;
    country?: string;
    languages?: string[];
  } = {},
): Promise<string[]> {
  const requestBody: Record<string, unknown> = {
    url,
    limit: Math.min(Math.max(1, opts.limit ?? 200), 100_000),
    includeSubdomains: opts.includeSubdomains ?? true,
  };
  if (opts.search) requestBody.search = opts.search;
  if (opts.sitemap) requestBody.sitemap = opts.sitemap;
  if (opts.ignoreQueryParameters !== undefined) {
    requestBody.ignoreQueryParameters = opts.ignoreQueryParameters;
  }
  if (opts.ignoreCache !== undefined) {
    requestBody.ignoreCache = opts.ignoreCache;
  }
  if (opts.timeoutMs !== undefined) requestBody.timeout = opts.timeoutMs;
  if (opts.country || opts.languages?.length) {
    requestBody.location = {
      ...(opts.country ? { country: opts.country } : {}),
      ...(opts.languages?.length ? { languages: opts.languages } : {}),
    };
  }

  const abortAfterMs = opts.abortAfterMs ?? (opts.timeoutMs ?? 60_000) + 5_000;
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);
  let res: Response;
  try {
    res = await fetch(`${FIRECRAWL_BASE}/map`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${firecrawlApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(fuse);
    if ((e as { name?: string }).name === "AbortError") {
      throw new ApiError(`firecrawl map aborted after ${abortAfterMs}ms`, 504);
    }
    throw e;
  }
  clearTimeout(fuse);
  if (!res.ok) {
    throw new ApiError(
      `firecrawl map failed: ${res.status} ${await res.text()}`,
      502,
    );
  }
  const responseJson = await res.json() as {
    links?: unknown[];
    data?: { links?: unknown[] };
  };
  const links = Array.isArray(responseJson?.links)
    ? responseJson.links
    : Array.isArray(responseJson?.data?.links)
    ? responseJson.data.links
    : [];
  return links
    .map((l: unknown) =>
      typeof l === "string" ? l : (l as { url?: string }).url ?? ""
    )
    .filter((s: string) => typeof s === "string" && s.length > 0);
}

/**
 * Firecrawl v2 changeTracking scrape.
 *
 * CRITICAL SHAPE: the changeTracking config lives INSIDE the `formats` array
 * as an object `{ type: "changeTracking", tag }`. The older
 * `changeTrackingOptions` top-level key is rejected by the v2 API with HTTP
 * 400 "Unrecognized key". The `tag` is per-scout and caps at 128 chars.
 *
 * NOTE: this is a legacy Firecrawl-only feature. It is retired in U4 in favor
 * of in-house canonical-hash baselines; the Crawl4AI provider has no analog.
 */
export async function firecrawlChangeTrackingScrape(
  url: string,
  tag: string,
  opts: ChangeTrackingOptions = {},
): Promise<ChangeTrackingResult> {
  const safeTag = tag.length > 128 ? tag.slice(0, 128) : tag;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const abortAfterMs = opts.abortAfterMs ?? timeoutMs + 5_000;
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);
  let res: Response;
  try {
    res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${firecrawlApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: [...(opts.formats ?? ["markdown", "rawHtml"]), {
          type: "changeTracking",
          tag: safeTag,
        }],
        onlyMainContent: opts.onlyMainContent ?? true,
        timeout: timeoutMs,
      }),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(fuse);
    if ((e as { name?: string }).name === "AbortError") {
      throw new ApiError(
        `firecrawl change-tracking aborted after ${abortAfterMs}ms`,
        504,
      );
    }
    throw e;
  }
  clearTimeout(fuse);
  if (!res.ok) {
    throw new ApiError(
      `firecrawl change-tracking failed: ${res.status} ${await res.text()}`,
      502,
    );
  }
  const body = await res.json();
  const d = body?.data ?? {};
  const metadata = d.metadata ?? {};
  const ct = d.changeTracking ?? {};
  return {
    markdown: d.markdown ?? "",
    html: d.html,
    rawHtml: d.rawHtml ?? null,
    title: d.metadata?.title,
    metadata,
    source_url: url,
    fetched_at: new Date().toISOString(),
    change_status:
      (ct.changeStatus ?? "new") as ChangeTrackingResult["change_status"],
    visibility: ct.visibility,
    previous_scrape_at: ct.previousScrapeAt,
  };
}

/**
 * Double-probe: verify Firecrawl's changeTracking actually stores a baseline.
 * Returns "firecrawl" (baseline verified) or "firecrawl_plain" (ghost/dropped
 * baseline → caller falls back to plain scrape + SHA-256 hash dedup).
 * Retired in U4 alongside changeTracking.
 */
export async function doubleProbe(
  url: string,
  tag: string,
  opts: ChangeTrackingOptions = {},
): Promise<"firecrawl" | "firecrawl_plain"> {
  try {
    await firecrawlChangeTrackingScrape(url, tag, opts);
  } catch {
    return "firecrawl_plain";
  }
  let result2: ChangeTrackingResult;
  try {
    result2 = await firecrawlChangeTrackingScrape(url, tag, opts);
  } catch {
    return "firecrawl_plain";
  }
  const { previous_scrape_at: prev, change_status: status } = result2;
  if (prev && (status === "same" || status === "changed")) {
    return "firecrawl";
  }
  return "firecrawl_plain";
}
