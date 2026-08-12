/**
 * Firecrawl Cloud v2 adapter.
 *
 * Beat discovery uses `/search`. Page rendering reaches `/scrape` only through
 * the scrape port's classified anti-bot fallback; Crawl4AI remains the primary
 * renderer.
 *
 * Docs: https://docs.firecrawl.dev/api-reference
 */

import { ApiError } from "./errors.ts";
import type {
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
  const onlyMainContent = opts.onlyMainContent ?? true;
  const body: Record<string, unknown> = {
    url,
    formats,
    onlyMainContent,
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
  const markdown = typeof d.markdown === "string" ? d.markdown : "";
  return {
    markdown,
    comparison_markdown: onlyMainContent && markdown.trim() ? markdown : null,
    comparison_strategy: onlyMainContent ? "provider_main" : "full",
    comparison_ratio: onlyMainContent ? 1 : undefined,
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
  if (opts.includeDomains?.length && opts.excludeDomains?.length) {
    throw new ApiError(
      "firecrawl search includeDomains and excludeDomains are mutually exclusive",
      400,
    );
  }
  const body: Record<string, unknown> = {
    query,
    limit: Math.min(Math.max(1, opts.limit ?? 10), 100),
    ignoreInvalidURLs: opts.ignoreInvalidURLs ?? true,
  };
  if (opts.sources?.length) body.sources = opts.sources;
  if (opts.location) body.location = opts.location;
  if (opts.country) body.country = opts.country;
  if (opts.tbs) body.tbs = opts.tbs;
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains;

  const abortAfterMs = opts.abortAfterMs ?? 45_000;
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${firecrawlApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new ApiError(
        `firecrawl search failed: ${res.status} ${await res.text()}`,
        502,
      );
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") throw e;
      throw new ApiError("firecrawl search returned invalid JSON", 502);
    }
    if (!isRecord(payload)) {
      throw new ApiError("firecrawl search returned a malformed response", 502);
    }
    if (payload.success === false) {
      const detail = typeof payload.error === "string"
        ? `: ${payload.error}`
        : "";
      throw new ApiError(`firecrawl search failed${detail}`, 502);
    }
    if (!("data" in payload)) {
      throw new ApiError(
        "firecrawl search returned a malformed response: missing data",
        502,
      );
    }

    const data = payload.data;
    const hits: Array<
      Record<string, unknown> & { _source: "web" | "news" }
    > = Array.isArray(data)
      ? normalizeSearchSource(data, "web")
      : normalizeSearchDataObject(data);
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
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      throw new ApiError(
        `firecrawl search aborted after ${abortAfterMs}ms`,
        504,
      );
    }
    throw e;
  } finally {
    clearTimeout(fuse);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSearchSource(
  value: unknown[],
  source: "web" | "news",
): Array<Record<string, unknown> & { _source: "web" | "news" }> {
  if (!value.every(isRecord)) {
    throw new ApiError(
      `firecrawl search returned malformed ${source} results`,
      502,
    );
  }
  return value.map((hit) => ({ ...hit, _source: source }));
}

function normalizeSearchDataObject(
  data: unknown,
): Array<Record<string, unknown> & { _source: "web" | "news" }> {
  if (!isRecord(data)) {
    throw new ApiError(
      "firecrawl search returned a malformed response: data must be an object or array",
      502,
    );
  }
  if (data.web !== undefined && !Array.isArray(data.web)) {
    throw new ApiError(
      "firecrawl search returned malformed web results",
      502,
    );
  }
  if (data.news !== undefined && !Array.isArray(data.news)) {
    throw new ApiError(
      "firecrawl search returned malformed news results",
      502,
    );
  }
  return [
    ...normalizeSearchSource(
      Array.isArray(data.web) ? data.web : [],
      "web",
    ),
    ...normalizeSearchSource(
      Array.isArray(data.news) ? data.news : [],
      "news",
    ),
  ];
}
