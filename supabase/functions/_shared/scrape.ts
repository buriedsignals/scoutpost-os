/**
 * Scrape port (SCRAPING-MIGRATION-PRD U2).
 *
 * Provider-agnostic entry point for all production scraping. Dispatches
 * `scrape()` to the active provider (`SCRAPE_PROVIDER`, default "firecrawl"),
 * and owns the resilient multi-strategy orchestrator plus the transient-error
 * taxonomy — all provider-neutral. The two providers live in
 * `scrape_firecrawl.ts` (default, deleted U8) and `scrape_crawl4ai.ts` (the
 * self-hosted scrape-service).
 *
 * Landing dark: until U7 flips `SCRAPE_PROVIDER=crawl4ai` in production, this
 * dispatches to Firecrawl and behavior is byte-identical to the former
 * `firecrawl.ts`.
 */

import { ApiError } from "./errors.ts";
import { firecrawlChangeTrackingScrape, firecrawlScrape } from "./scrape_firecrawl.ts";
import { crawl4aiScrape } from "./scrape_crawl4ai.ts";
import type {
  ChangeTrackingOptions,
  ChangeTrackingResult,
  PrimaryPageScrapeDeps,
  PrimaryPageScrapeOptions,
  PrimaryPageScrapeResult,
  PrimaryScrapeStrategy,
  ScrapeOptions,
  ScrapeResult,
} from "./scrape_types.ts";

export type ScrapeProvider = "firecrawl" | "crawl4ai";

export function scrapeProvider(): ScrapeProvider {
  return Deno.env.get("SCRAPE_PROVIDER") === "crawl4ai" ? "crawl4ai" : "firecrawl";
}

/**
 * Scrape a single URL through the active provider — the switch point for the
 * U7 `SCRAPE_PROVIDER` flip. Reached today by `scrapePrimaryPageResilient`
 * (the web-scout primary path) and by direct callers that have migrated
 * (e.g. `ingest`). The remaining `firecrawlScrape` call sites stay on the
 * Firecrawl provider until their owning unit rewires them: civic PDF parsing
 * moves to the doc-parse port in U3, web change-detection callers route here
 * in U4, and Beat retrieval in U5. Until each is migrated it keeps hitting
 * Firecrawl (and needs `FIRECRAWL_API_KEY`) even after the flip — intentional,
 * per-subsystem cutover.
 */
export function scrape(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult> {
  return scrapeProvider() === "crawl4ai"
    ? crawl4aiScrape(url, opts)
    : firecrawlScrape(url, opts);
}

/**
 * Change-tracking scrape. This is inherently a Firecrawl feature (the
 * Crawl4AI provider has no server-side change tracking); it is retired in U4
 * in favor of in-house canonical-hash baselines. Until then it always routes
 * to Firecrawl regardless of `SCRAPE_PROVIDER` — production has zero
 * `provider="firecrawl"` scouts, so this path is effectively unused, and
 * `FIRECRAWL_API_KEY` remains configured through the U7 bake.
 */
export function changeTrackingScrape(
  url: string,
  tag: string,
  opts: ChangeTrackingOptions = {},
): Promise<ChangeTrackingResult> {
  return firecrawlChangeTrackingScrape(url, tag, opts);
}

const DEFAULT_PRIMARY_DEPS: PrimaryPageScrapeDeps = {
  scrape,
  changeTrackingScrape,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

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
    if (!isTransientScrapeError(e)) throw e;
    warnings.push(warningForScrapeError(e, "combined"));
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
    if (!isTransientScrapeError(e)) throw e;
    warnings.push(warningForScrapeError(e, "combined_retry"));
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
    throw new ApiError("scrape returned empty markdown", 502);
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
    warnings.push(warningForScrapeError(e, "raw_html"));
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

export function isTransientScrapeError(error: unknown): boolean {
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

export function warningForScrapeError(error: unknown, phase: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/aborted/i.test(message)) return `${phase}_aborted`;
  if (/timeout|timed out/i.test(message)) return `${phase}_timeout`;
  const upstreamStatus = message.match(/failed:\s*(\d{3})/)?.[1];
  if (upstreamStatus) return `${phase}_${upstreamStatus}`;
  if (error instanceof ApiError) return `${phase}_${error.status}`;
  return `${phase}_failed`;
}
