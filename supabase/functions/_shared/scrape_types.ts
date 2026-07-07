/**
 * Provider-neutral scrape types (SCRAPING-MIGRATION-PRD U2).
 *
 * These shapes are the contract every scrape provider (Firecrawl today,
 * the self-hosted Crawl4AI scrape-service going forward) must satisfy. Kept
 * in a dependency-free module so both providers and the port can import them
 * without an import cycle.
 */

/**
 * Inline snapshot payload from the scrape-service capture fetch
 * (PAGE-ARCHIVE-PRD U1/KTD2). Hashes are computed server-side over the exact
 * bytes the base64 fields decode to; the Edge Function re-verifies before
 * storing (hash-before-store, R2).
 */
export interface ScrapeSnapshotPayload {
  mhtml_b64: string;
  mhtml_sha256: string;
  screenshot_b64: string;
  screenshot_sha256: string;
  sizes?: { mhtml?: number; screenshot?: number };
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
  /**
   * Response headers of the target page, when the provider surfaces them
   * (the scrape-service maps CrawlResult.response_headers; Firecrawl has no
   * equivalent). Persisted on page_snapshots rows (KTD4).
   */
  response_headers?: Record<string, string>;
  /** Same-render capture artifacts — present only when the crawl4ai provider
   * served a `snapshot: true` fetch and capture succeeded (KTD1/KTD2). */
  snapshot?: ScrapeSnapshotPayload | null;
  /** Structured reason the service omitted the snapshot payload (over-cap,
   * incomplete capture, non-PNG error card). The scrape itself succeeded. */
  snapshot_error?: string;
  /** Firecrawl full-page screenshot URL (short-lived CDN link, ~24h) — present
   * only when a snapshot-hinted fetch was served by Firecrawl (KTD9). The
   * caller must download and persist the bytes promptly. */
  screenshot_url?: string;
  /**
   * HTTP status of the TARGET page (not the provider API). Both providers
   * return the page content even for a 4xx target (a dead/removed page comes
   * back HTTP 200 from the provider with status_code 404), so civic uses this
   * to detect removed pages — the signal the retired changeTracking "removed"
   * status used to carry. From firecrawl's metadata.statusCode / the
   * scrape-service's status_code; undefined when the provider omits it.
   */
  status_code?: number;
  /**
   * Which provider actually served this result. Differs from the requested
   * provider when the anti-bot fallback fired (crawl4ai blocked -> firecrawl).
   * Surfaced into scout_runs.metadata.scrape_provider_served for the weekly
   * scoreboard's fallback-health monitoring.
   */
  served_by?: "firecrawl" | "crawl4ai";
}

export interface ScrapeOptions {
  formats?: Array<"markdown" | "html" | "rawHtml">;
  onlyMainContent?: boolean;
  /**
   * PDF parser mode. Defaults to "fast" (embedded-text extraction, no OCR) —
   * see SCRAPING-MIGRATION-PRD KTD4. Firecrawl honors this; the Crawl4AI
   * provider ignores it (PDFs route to the doc-parse port in U3, not /scrape).
   * Pass `null` to omit the parsers field entirely.
   */
  pdfMode?: "fast" | "auto" | "ocr" | null;
  /** Provider server-side timeout in ms. Default 120_000 for civic PDFs. */
  timeoutMs?: number;
  /** Client-side AbortController fuse in ms. Defaults to timeoutMs + 5000. */
  abortAfterMs?: number;
  /** Cache freshness in ms. Firecrawl-only; ignored by Crawl4AI. */
  maxAgeMs?: number;
  /** Whether the provider may store this scrape in its cache. Firecrawl-only. */
  storeInCache?: boolean;
  /**
   * Snapshot capture (PAGE-ARCHIVE-PRD KTD2/KTD9).
   *
   * `true` — capture fetch: the crawl4ai provider requests same-render
   * MHTML + full-page screenshot, returned inline as `snapshot`. On the
   * Firecrawl provider this degenerates to the same-fetch third-party
   * artifacts below (a baseline scrape on an anti-bot host lands here).
   *
   * `"on_fallback"` — detection-fetch hint: the crawl4ai provider ignores it
   * (no capture flags sent); if the anti-bot fallback fires inside `scrape()`,
   * the Firecrawl request adds rawHtml + full-page-screenshot formats so the
   * alert-firing fetch itself carries the KTD9 artifacts (`screenshot_url` +
   * `rawHtml`). Without this hint the rendered_thirdparty tier is unreachable.
   */
  snapshot?: true | "on_fallback";
  /**
   * Disable the anti-bot Firecrawl fallback for this call (KTD2 capture-fetch
   * pin): a Firecrawl-served capture must never masquerade as a local render.
   * An anti-bot block then propagates as an error for the caller to degrade.
   */
  noAntibotFallback?: boolean;
}

export interface SearchHit {
  url: string;
  title?: string;
  description?: string;
  markdown?: string;
  date?: string | null;
  source?: "web" | "news";
}

export interface SearchOptions {
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
  /** Client-side AbortController fuse in ms. Defaults to 45_000. */
  abortAfterMs?: number;
}

/** @deprecated Firecrawl-era name; use {@link SearchOptions}. */
export type FirecrawlSearchOptions = SearchOptions;

export interface ChangeTrackingResult extends ScrapeResult {
  change_status: "new" | "same" | "changed" | "removed";
  visibility?: "visible" | "hidden";
  previous_scrape_at?: string;
}

export interface ChangeTrackingOptions {
  formats?: Array<"markdown" | "html" | "rawHtml">;
  onlyMainContent?: boolean;
  /** Provider server-side timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** Client-side AbortController fuse in ms. Defaults to timeoutMs + 5000. */
  abortAfterMs?: number;
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

export interface PrimaryPageScrapeDeps {
  scrape: (url: string, opts?: ScrapeOptions) => Promise<ScrapeResult>;
  changeTrackingScrape: (
    url: string,
    tag: string,
    opts?: ChangeTrackingOptions,
  ) => Promise<ChangeTrackingResult>;
  sleep: (ms: number) => Promise<void>;
}

export interface PrimaryPageScrapeOptions {
  url: string;
  changeTrackingTag?: string;
  onlyMainContent?: boolean;
  timeoutMs?: number;
  abortAfterMs?: number;
  maxAgeMs?: number;
  storeInCache?: boolean;
  retryDelayMs?: number;
  /**
   * Detection-fetch capture hint only (KTD9). The resilient ladder never
   * issues a local capture fetch — `snapshot: true` is reserved for the
   * dedicated provider-pinned capture call (KTD2), outside this ladder.
   */
  snapshot?: "on_fallback";
  deps?: Partial<PrimaryPageScrapeDeps>;
}
