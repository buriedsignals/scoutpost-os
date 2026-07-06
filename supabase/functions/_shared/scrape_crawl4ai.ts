/**
 * Crawl4AI provider (SCRAPING-MIGRATION-PRD U2).
 *
 * Thin bearer-authed client for the self-hosted scrape-service `/scrape`
 * endpoint (FastAPI + Crawl4AI library). The KTD2 CrawlResult→ScrapeResult
 * mapping happens server-side, so this module only shapes the request,
 * authenticates, and translates transport errors into the shared taxonomy
 * (non-OK → 502, abort/timeout → 504) — identical to the Firecrawl provider,
 * so `isTransientScrapeError` classification transfers unchanged.
 */

import { ApiError } from "./errors.ts";
import type { ScrapeOptions, ScrapeResult } from "./scrape_types.ts";

function serviceConfig(): { url: string; token: string } {
  const url = Deno.env.get("SCRAPE_SERVICE_URL");
  if (!url) throw new ApiError("SCRAPE_SERVICE_URL not configured", 500);
  const token = Deno.env.get("SCRAPE_SERVICE_TOKEN");
  if (!token) throw new ApiError("SCRAPE_SERVICE_TOKEN not configured", 500);
  return { url: url.replace(/\/+$/, ""), token };
}

export async function crawl4aiScrape(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const { url: base, token } = serviceConfig();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const abortAfterMs = opts.abortAfterMs ?? timeoutMs + 5_000;

  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);
  let res: Response;
  try {
    res = await fetch(`${base}/scrape`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, timeout_ms: timeoutMs }),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(fuse);
    if ((e as { name?: string }).name === "AbortError") {
      throw new ApiError(
        `crawl4ai scrape aborted after ${abortAfterMs}ms`,
        504,
      );
    }
    throw e;
  }
  clearTimeout(fuse);
  if (!res.ok) {
    // Match the Firecrawl provider exactly: every non-OK upstream response
    // (including an upstream 504 body) → ApiError(502); only a *client-side*
    // abort maps to 504. This keeps run_lifecycle error-class accounting
    // identical across providers. The "<provider> scrape failed: <status>"
    // shape preserves the transient classifier's `/failed:\s*(\d{3})/` match,
    // so an upstream 5xx/429 is still detected as transient.
    throw new ApiError(
      `crawl4ai scrape failed: ${res.status} ${await res.text()}`,
      502,
    );
  }
  const d = await res.json();
  const metadata = (d.metadata ?? {}) as Record<string, unknown>;
  const sourceUrl = typeof d.source_url === "string" && d.source_url.trim()
    ? d.source_url
    : url;
  return {
    markdown: typeof d.markdown === "string" ? d.markdown : "",
    html: typeof d.html === "string" ? d.html : undefined,
    rawHtml: typeof d.rawHtml === "string" ? d.rawHtml : null,
    title: typeof d.title === "string" ? d.title : undefined,
    metadata,
    requested_url: url,
    source_url: sourceUrl,
    fetched_at: typeof d.fetched_at === "string"
      ? d.fetched_at
      : new Date().toISOString(),
    status_code: typeof d.status_code === "number" ? d.status_code : undefined,
  };
}
