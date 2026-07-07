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
import type {
  ScrapeOptions,
  ScrapeResult,
  ScrapeSnapshotPayload,
} from "./scrape_types.ts";

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
  // `"on_fallback"` is a detection-fetch hint for the Firecrawl fallback
  // branch — this provider deliberately ignores it (KTD9).
  const snapshot = opts.snapshot === true;
  // Capture fetches run extra crawl4ai phases timed separately from
  // page_timeout; the service budgets 2×timeout+20s (scrape_fuse_seconds),
  // so the client fuse must sit outside that or heavy captures 504 here
  // while the service is still working.
  const abortAfterMs = opts.abortAfterMs ??
    (snapshot ? timeoutMs * 2 + 25_000 : timeoutMs + 5_000);

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
      body: JSON.stringify({
        url,
        timeout_ms: timeoutMs,
        ...(snapshot ? { snapshot: true } : {}),
      }),
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
    response_headers: mapResponseHeaders(d.response_headers),
    ...(snapshot
      ? {
        snapshot: mapSnapshotPayload(d.snapshot),
        ...(typeof d.snapshot_error === "string"
          ? { snapshot_error: d.snapshot_error }
          : {}),
      }
      : {}),
  };
}

function mapResponseHeaders(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") headers[k] = v;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Shape-validate the inline capture payload (U1's contract). A payload with
 * missing/mistyped fields is treated as absent — the caller degrades to a
 * markdown_only record rather than trusting a malformed capture. */
function mapSnapshotPayload(value: unknown): ScrapeSnapshotPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (
    typeof p.mhtml_b64 !== "string" || typeof p.mhtml_sha256 !== "string" ||
    typeof p.screenshot_b64 !== "string" ||
    typeof p.screenshot_sha256 !== "string"
  ) {
    return null;
  }
  const sizes = (p.sizes && typeof p.sizes === "object" &&
      !Array.isArray(p.sizes))
    ? p.sizes as { mhtml?: number; screenshot?: number }
    : undefined;
  return {
    mhtml_b64: p.mhtml_b64,
    mhtml_sha256: p.mhtml_sha256,
    screenshot_b64: p.screenshot_b64,
    screenshot_sha256: p.screenshot_sha256,
    ...(sizes ? { sizes } : {}),
  };
}
