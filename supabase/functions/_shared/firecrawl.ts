/**
 * Firecrawl v2 API client. Minimal surface: single-page scrape and
 * change-tracking scrape (per-scout baseline).
 *
 * Docs: https://docs.firecrawl.dev/api-reference
 */

import { ApiError } from "./errors.ts";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

function firecrawlApiKey(): string {
  const k = Deno.env.get("FIRECRAWL_API_KEY");
  if (!k) throw new ApiError("FIRECRAWL_API_KEY not configured", 500);
  return k;
}

export interface ScrapeResult {
  markdown: string;
  html?: string;
  rawHtml?: string | null;
  title?: string;
  metadata?: Record<string, unknown>;
  requested_url?: string;
  source_url: string;
  fetched_at: string;
}

export interface ScrapeOptions {
  formats?: Array<"markdown" | "html" | "rawHtml">;
  onlyMainContent?: boolean;
  /**
   * PDF parser mode. Defaults to "fast", which matches the dorfkoenig
   * reference benchmark (far more section markers, zero OCR hallucinations
   * on InDesign/embedded-text PDFs vs. the default "auto"/"ocr" modes).
   * Pass `null` to omit the parsers field entirely (e.g. for HTML-only callers
   * that want to avoid any PDF-specific behaviour).
   */
  pdfMode?: "fast" | "auto" | "ocr" | null;
  /** Firecrawl server-side timeout in ms. Default 120_000 for civic PDFs. */
  timeoutMs?: number;
  /** Client-side AbortController fuse in ms. Defaults to timeoutMs + 5000. */
  abortAfterMs?: number;
  /** Firecrawl cache freshness in ms. Omitted by default to preserve caller behavior. */
  maxAgeMs?: number;
  /** Whether Firecrawl may store this scrape in its cache. Omitted by default. */
  storeInCache?: boolean;
}

export async function firecrawlScrape(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const abortAfterMs = opts.abortAfterMs ?? timeoutMs + 5_000;

  const body: Record<string, unknown> = {
    url,
    formats: opts.formats ?? ["markdown", "rawHtml"],
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
  };
}

export interface SearchHit {
  url: string;
  title?: string;
  description?: string;
  markdown?: string;
  date?: string | null;
  source?: "web" | "news";
}

export interface FirecrawlSearchOptions {
  limit?: number;
  scrape?: boolean;
  lang?: string;
  location?: string;
  country?: string;
  sources?: Array<"web" | "news">;
  categories?: Array<"github" | "pdf" | "research">;
  tbs?: string;
  ignoreInvalidURLs?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
}

/**
 * Firecrawl v2 /search endpoint. Returns up to `limit` SERP-style hits.
 *
 * Docs: https://docs.firecrawl.dev/api-reference/endpoint/search
 */
export async function firecrawlSearch(
  query: string,
  opts: FirecrawlSearchOptions = {},
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

  const res = await fetch(`${FIRECRAWL_BASE}/search`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${firecrawlApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
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

  const res = await fetch(`${FIRECRAWL_BASE}/map`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${firecrawlApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
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

export interface ChangeTrackingResult extends ScrapeResult {
  change_status: "new" | "same" | "changed" | "removed";
  visibility?: "visible" | "hidden";
  previous_scrape_at?: string;
}

export interface ChangeTrackingOptions {
  formats?: Array<"markdown" | "html" | "rawHtml">;
  onlyMainContent?: boolean;
  /** Firecrawl server-side timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** Client-side AbortController fuse in ms. Defaults to timeoutMs + 5000. */
  abortAfterMs?: number;
}

/**
 * Firecrawl v2 changeTracking scrape.
 *
 * CRITICAL SHAPE (matches the production FastAPI implementation — see
 * cojournalist/backend/app/services/scout_service.py::_firecrawl_scrape):
 * the changeTracking config lives INSIDE the `formats` array as an object
 * `{ type: "changeTracking", tag }`. The older `changeTrackingOptions`
 * top-level key is rejected by the v2 API with HTTP 400 "Unrecognized key".
 *
 * The `tag` is per-scout and caps at 128 chars.
 */
/**
 * Double-probe: verify that Firecrawl's changeTracking actually stores a
 * baseline for this URL. Some sites are "ghost baseline" — Firecrawl returns
 * a `previousScrapeAt` timestamp but no stored content, so the next call
 * always reports `changeStatus="new"`. We detect this by doing two sequential
 * changeTracking scrapes with the same tag and inspecting the second result.
 *
 * Returns:
 *   "firecrawl"        — baseline verified (previousScrapeAt set + changeStatus
 *                        is same/changed). Future runs can trust changeTracking.
 *   "firecrawl_plain"  — baseline dropped or ghost. Future runs must use
 *                        plain scrape + SHA-256 hash dedup.
 *
 * Port of backend/app/services/scout_service.py::double_probe.
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

export type PrimaryScrapeStrategy =
  | "combined"
  | "combined_retry"
  | "split"
  | "markdown_only_fallback";

export interface PrimaryPageScrapeResult extends ScrapeResult {
  change_status?: ChangeTrackingResult["change_status"];
  visibility?: ChangeTrackingResult["visibility"];
  previous_scrape_at?: string;
  scrape_strategy: PrimaryScrapeStrategy;
  scrape_attempts: number;
  scrape_warning?: string;
}

interface PrimaryPageScrapeDeps {
  scrape: typeof firecrawlScrape;
  changeTrackingScrape: typeof firecrawlChangeTrackingScrape;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_PRIMARY_DEPS: PrimaryPageScrapeDeps = {
  scrape: firecrawlScrape,
  changeTrackingScrape: firecrawlChangeTrackingScrape,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface PrimaryPageScrapeOptions {
  url: string;
  changeTrackingTag?: string;
  onlyMainContent?: boolean;
  timeoutMs?: number;
  abortAfterMs?: number;
  maxAgeMs?: number;
  storeInCache?: boolean;
  retryDelayMs?: number;
  deps?: Partial<PrimaryPageScrapeDeps>;
}

export async function scrapePrimaryPageResilient(
  opts: PrimaryPageScrapeOptions,
): Promise<PrimaryPageScrapeResult> {
  const deps: PrimaryPageScrapeDeps = {
    ...DEFAULT_PRIMARY_DEPS,
    ...opts.deps,
  };
  const baseOpts = {
    onlyMainContent: opts.onlyMainContent,
    timeoutMs: opts.timeoutMs,
    abortAfterMs: opts.abortAfterMs,
    maxAgeMs: opts.maxAgeMs,
    storeInCache: opts.storeInCache,
  };
  const retryDelayMs = opts.retryDelayMs ?? 2_000;
  const warnings: string[] = [];
  let attempts = 0;

  const combined = async () => {
    attempts++;
    if (opts.changeTrackingTag) {
      return await deps.changeTrackingScrape(
        opts.url,
        opts.changeTrackingTag,
        baseOpts,
      );
    }
    return await deps.scrape(opts.url, {
      ...baseOpts,
      formats: ["markdown", "rawHtml"],
    });
  };

  let firstError: unknown;
  try {
    const result = await combined();
    return withPrimaryMetadata(result, "combined", attempts);
  } catch (e) {
    firstError = e;
    if (!isTransientFirecrawlError(e)) throw e;
    warnings.push(warningForFirecrawlError(e, "combined"));
  }

  if (retryDelayMs > 0) await deps.sleep(retryDelayMs);
  try {
    const result = await combined();
    return withPrimaryMetadata(
      result,
      "combined_retry",
      attempts,
      warnings,
    );
  } catch (e) {
    if (!isTransientFirecrawlError(e)) throw e;
    warnings.push(warningForFirecrawlError(e, "combined_retry"));
  }

  let markdownResult: ScrapeResult | ChangeTrackingResult;
  try {
    attempts++;
    markdownResult = opts.changeTrackingTag
      ? await deps.changeTrackingScrape(opts.url, opts.changeTrackingTag, {
        ...baseOpts,
        formats: ["markdown"],
      })
      : await deps.scrape(opts.url, { ...baseOpts, formats: ["markdown"] });
  } catch (e) {
    if (firstError instanceof Error) throw firstError;
    throw e;
  }

  if (!markdownResult.markdown?.trim()) {
    throw new ApiError("firecrawl returned empty markdown", 502);
  }

  try {
    attempts++;
    const rawHtmlResult = await deps.scrape(opts.url, {
      ...baseOpts,
      formats: ["rawHtml"],
    });
    return withPrimaryMetadata(
      {
        ...markdownResult,
        rawHtml: rawHtmlResult.rawHtml ?? null,
        html: rawHtmlResult.html ?? markdownResult.html,
        title: markdownResult.title ?? rawHtmlResult.title,
        source_url: markdownResult.source_url || rawHtmlResult.source_url,
        requested_url: markdownResult.requested_url ??
          rawHtmlResult.requested_url,
      },
      "split",
      attempts,
      warnings,
    );
  } catch (e) {
    warnings.push(warningForFirecrawlError(e, "raw_html"));
    return withPrimaryMetadata(
      { ...markdownResult, rawHtml: null },
      "markdown_only_fallback",
      attempts,
      warnings,
    );
  }
}

function withPrimaryMetadata(
  result: ScrapeResult | ChangeTrackingResult,
  scrapeStrategy: PrimaryScrapeStrategy,
  scrapeAttempts: number,
  warnings: string[] = [],
): PrimaryPageScrapeResult {
  const change = result as ChangeTrackingResult;
  return {
    ...result,
    change_status: change.change_status,
    visibility: change.visibility,
    previous_scrape_at: change.previous_scrape_at,
    scrape_strategy: scrapeStrategy,
    scrape_attempts: scrapeAttempts,
    scrape_warning: warnings.length > 0 ? warnings.join(",") : undefined,
  };
}

export function isTransientFirecrawlError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/SCRAPE_UNSUPPORTED_FILE_ERROR/i.test(message)) return false;
  if (/aborted|timeout|timed out|network/i.test(message)) return true;

  const upstreamStatus = message.match(/failed:\s*(\d{3})/)?.[1];
  if (upstreamStatus) {
    const status = Number(upstreamStatus);
    return status === 429 || status >= 500;
  }

  if (error instanceof ApiError) {
    return error.status === 429 || error.status === 504 ||
      error.status >= 500;
  }
  return false;
}

function warningForFirecrawlError(error: unknown, phase: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted/i.test(message)) return `${phase}_aborted`;
  if (/timeout|timed out/i.test(message)) return `${phase}_timeout`;
  const upstreamStatus = message.match(/failed:\s*(\d{3})/)?.[1];
  if (upstreamStatus) return `${phase}_${upstreamStatus}`;
  if (error instanceof ApiError) return `${phase}_${error.status}`;
  return `${phase}_failed`;
}
