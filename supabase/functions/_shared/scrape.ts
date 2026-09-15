/**
 * Provider-agnostic scrape port.
 *
 * Crawl4AI is the default primary renderer. Firecrawl Cloud is retained as a
 * classified anti-bot fallback and as an explicit compatibility provider when
 * `SCRAPE_PROVIDER=firecrawl`.
 */

import { ApiError } from "./errors.ts";
import { logEvent } from "./log.ts";
import { firecrawlScrape } from "./scrape_firecrawl.ts";
import { crawl4aiScrape } from "./scrape_crawl4ai.ts";
import {
  crawlerFallbackReason,
  scrapeFallbackOnce,
} from "./scrape_fallback.ts";
import type {
  PrimaryPageScrapeDeps,
  PrimaryPageScrapeOptions,
  PrimaryPageScrapeResult,
  PrimaryScrapeStrategy,
  ScrapeOptions,
  ScrapeResult,
} from "./scrape_types.ts";

export type ScrapeProvider = "firecrawl" | "crawl4ai";

export function scrapeProvider(): ScrapeProvider {
  return Deno.env.get("SCRAPE_PROVIDER") === "firecrawl"
    ? "firecrawl"
    : "crawl4ai";
}

/**
 * True when the active provider has the configuration it needs to fetch at
 * all. A runtime with no provider (a bare self-host smoke, a fresh install)
 * cannot probe a page, and "cannot probe" must not be reported as "the page
 * is unreachable" — the create gate skips itself and logs instead.
 */
export function scrapeProviderConfigured(): boolean {
  if (scrapeProvider() === "firecrawl") {
    return Boolean(Deno.env.get("FIRECRAWL_API_KEY"));
  }
  return Boolean(
    Deno.env.get("SCRAPE_SERVICE_URL") && Deno.env.get("SCRAPE_SERVICE_TOKEN"),
  );
}

/**
 * True when a provider error means the TARGET blocked us with anti-bot
 * protection (Cloudflare JS challenge, DataDome captcha, Imperva structural
 * challenge, 503 bot walls…). The scrape-service detects and labels all of
 * these uniformly ("Blocked by anti-bot protection: …"), which its client
 * wraps into the ApiError message. Deliberately narrow: transient provider
 * errors (timeouts, 5xx) must NOT match, or the fallback would double-spend
 * on every blip.
 */
export function isAntiBotBlockedError(e: unknown): e is ApiError {
  return e instanceof ApiError && /anti-bot|captcha|challenge/i.test(e.message);
}

/**
 * Scrape a single URL through the active provider. Page Scouts, Beat article
 * rendering, ingest, and document parsing use Crawl4AI unless an operator
 * deliberately selects Firecrawl compatibility mode.
 */
export async function scrape(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult> {
  if (scrapeProvider() !== "crawl4ai") {
    // Explicit Firecrawl compatibility path: the KTD9
    // `snapshot: "on_fallback"` hint is a
    // FALLBACK signal — it must not fire a same-fetch capture on the primary
    // provider (that would append a full-page screenshot to every detection
    // scrape, including `same` runs). Only an explicit `snapshot: true` capture
    // fetch materializes here, and those are pinned to crawl4ai (never reach
    // this branch). So strip the hint. The fallback branch below keeps it.
    return {
      ...await firecrawlScrape(url, { ...opts, snapshot: undefined }),
      served_by: "firecrawl",
    };
  }
  const deadlineMs = Date.now() +
    (opts.abortAfterMs ?? (opts.timeoutMs ?? 120_000) + 5_000);
  try {
    return { ...await crawl4aiScrape(url, opts), served_by: "crawl4ai" };
  } catch (e) {
    const reason = isAntiBotBlockedError(e)
      ? "anti_bot"
      : e instanceof ApiError && e.code === "primary_timeout_exhausted"
      ? "timeout_exhausted"
      : null;
    if (
      opts.noAntibotFallback || !reason || !Deno.env.get("FIRECRAWL_API_KEY")
    ) {
      throw e;
    }
    // Both eligibility cases above require an ApiError.
    const failure = e as ApiError;
    logEvent({
      level: "warn",
      fn: "scrape-port",
      event: reason === "anti_bot"
        ? "antibot_fallback_to_firecrawl"
        : "timeout_fallback_to_firecrawl",
      url,
      msg: failure.message.slice(0, 300),
    });
    // A snapshot hint (either mode) rides into the Firecrawl request as the
    // KTD9 same-fetch capture formats — this branch is the only place the
    // "on_fallback" hint materializes into artifacts.
    // Inline timeout recovery keeps the original remaining budget; durable
    // Page recovery supplies its independently admitted renderer window.
    return await scrapeFallbackOnce(
      url,
      {
        ...opts,
        timeoutMs: reason === "timeout_exhausted"
          ? Math.floor(deadlineMs - Date.now())
          : opts.timeoutMs,
      },
      reason,
      deadlineMs,
    );
  }
}

const DEFAULT_PRIMARY_DEPS: PrimaryPageScrapeDeps = {
  scrape,
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
    requestId: crypto.randomUUID(),
    workloadClass: opts.workloadClass,
    tenantKey: opts.tenantKey,
    onlyMainContent: opts.onlyMainContent,
    timeoutMs: opts.timeoutMs,
    abortAfterMs: opts.abortAfterMs,
    maxAgeMs: opts.maxAgeMs,
    storeInCache: opts.storeInCache,
    // Detection-fetch capture hint (KTD9) — rides every ladder attempt so a
    // fallback-served detection fetch carries its same-fetch artifacts.
    snapshot: opts.snapshot,
  };
  const retryDelayMs = opts.retryDelayMs ?? 2_000;
  const warnings: string[] = [];
  // Reuse the existing maximum ladder budget (two combined + Markdown + HTML).
  // A terminal timeout uses the unused HTML slot, not an additional timeout.
  const deadlineMs = opts.deadlineMs ?? Date.now() +
      4 * (opts.abortAfterMs ?? (opts.timeoutMs ?? 120_000) + 5_000) +
      retryDelayMs;
  let attempts = 0;
  let navigationTimeouts = 0;

  const request = (
    formats: ScrapeOptions["formats"],
    capture = true,
    noAntibotFallback = false,
  ) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      throw new ApiError(
        "primary scrape deadline exhausted",
        504,
        "primary_deadline_exhausted",
      );
    }
    attempts++;
    return deps.scrape(opts.url, {
      ...baseOpts,
      formats,
      snapshot: capture ? baseOpts.snapshot : undefined,
      noAntibotFallback,
      timeoutMs: Math.min(opts.timeoutMs ?? 120_000, remaining),
      abortAfterMs: Math.min(
        opts.abortAfterMs ?? (opts.timeoutMs ?? 120_000) + 5_000,
        remaining,
      ),
    });
  };

  let firstError: unknown;
  try {
    const result = await request(["markdown", "rawHtml"]);
    return withPrimaryMetadata(result, "combined", attempts);
  } catch (e) {
    firstError = e;
    if (e instanceof ApiError && e.code === "navigation_timeout") {
      navigationTimeouts++;
    }
    if (!isTransientScrapeError(e)) throw e;
    warnings.push(warningForScrapeError(e, "combined"));
  }

  if (retryDelayMs > 0) {
    await deps.sleep(
      Math.min(retryDelayMs, Math.max(0, deadlineMs - Date.now())),
    );
  }
  try {
    const result = await request(["markdown", "rawHtml"]);
    return withPrimaryMetadata(
      result,
      "combined_retry",
      attempts,
      warnings,
    );
  } catch (e) {
    if (e instanceof ApiError && e.code === "navigation_timeout") {
      navigationTimeouts++;
    }
    if (!isTransientScrapeError(e)) throw e;
    warnings.push(warningForScrapeError(e, "combined_retry"));
  }

  let markdownResult: ScrapeResult;
  try {
    // The split path issues TWO independent fetches (markdown, then rawHtml),
    // which can be served by different providers — so it can never satisfy the
    // KTD9 same-fetch capture guarantee. Drop the snapshot hint from both
    // sub-fetches (no wasted screenshot work, no stray screenshot_url) and
    // clear any capture artifacts from the merged result below, so a
    // split-path detection scrape degrades to markdown_only rather than
    // sealing a screenshot and rawHtml from two different fetches as one
    // "rendered_thirdparty" snapshot.
    markdownResult = await request(["markdown"], false);
  } catch (e) {
    if (e instanceof ApiError && e.code === "navigation_timeout") {
      navigationTimeouts++;
    }
    if (!isTransientScrapeError(e)) throw e;
    if (
      e instanceof ApiError && e.code === "navigation_timeout" &&
      crawlerFallbackReason("scrape", "timeout", navigationTimeouts, 3) ===
        "timeout_exhausted"
    ) {
      const result = await scrapeFallbackOnce(
        opts.url,
        {
          ...baseOpts,
          formats: ["markdown", "rawHtml"],
          timeoutMs: Math.floor(deadlineMs - Date.now()),
        },
        "timeout_exhausted",
        deadlineMs,
      );
      return withPrimaryMetadata(
        result,
        "timeout_fallback",
        attempts,
        warnings,
      );
    }
    if (firstError instanceof Error) throw firstError;
    throw e;
  }

  if (!markdownResult.markdown?.trim()) {
    throw new ApiError("scrape returned empty markdown", 502);
  }

  try {
    const rawHtmlResult = await request(
      ["rawHtml"],
      false,
      markdownResult.served_by === "firecrawl",
    );
    return withPrimaryMetadata(
      {
        ...markdownResult,
        rawHtml: rawHtmlResult.rawHtml ?? null,
        html: rawHtmlResult.html ?? markdownResult.html,
        title: markdownResult.title ?? rawHtmlResult.title,
        source_url: markdownResult.source_url || rawHtmlResult.source_url,
        requested_url: markdownResult.requested_url ??
          rawHtmlResult.requested_url,
        // Capture artifacts can never be same-fetch on the split path — clear
        // them so no mismatched rendered_thirdparty snapshot can be sealed.
        screenshot_url: undefined,
        snapshot: null,
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
  result: ScrapeResult,
  scrapeStrategy: PrimaryScrapeStrategy,
  scrapeAttempts: number,
  warnings: string[] = [],
): PrimaryPageScrapeResult {
  return {
    ...result,
    scrape_strategy: scrapeStrategy,
    scrape_attempts: scrapeAttempts,
    scrape_warning: warnings.length > 0 ? warnings.join(",") : undefined,
  };
}

export function isTransientScrapeError(error: unknown): boolean {
  if (
    error instanceof ApiError && (
      error.code === "scrape_fallback_failed" ||
      error.code === "unsupported_document" ||
      error.code === "primary_timeout_exhausted" ||
      error.code === "primary_deadline_exhausted"
    )
  ) return false;
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
