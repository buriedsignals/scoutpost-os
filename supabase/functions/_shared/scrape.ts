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
  try {
    return { ...await crawl4aiScrape(url, opts), served_by: "crawl4ai" };
  } catch (e) {
    // Anti-bot fallback (Tom, 2026-07-06): Firecrawl stays as a scoped
    // fallback for hosts whose bot protection our own service cannot pass
    // (measured 2026-07-06: 8 of 53 fleet URLs — Cloudflare, DataDome,
    // Imperva). Fires ONLY on anti-bot classification, never on transient
    // errors; every fallback is logged and the result is stamped so the
    // weekly scoreboard attributes serving per provider.
    //
    // KTD2 capture-fetch pin: `noAntibotFallback` propagates the block
    // instead — a Firecrawl-served capture must never masquerade as a local
    // render; the caller degrades to a markdown_only record.
    if (
      opts.noAntibotFallback || !isAntiBotBlockedError(e) ||
      !Deno.env.get("FIRECRAWL_API_KEY")
    ) {
      throw e;
    }
    logEvent({
      level: "warn",
      fn: "scrape-port",
      event: "antibot_fallback_to_firecrawl",
      url,
      msg: e.message.slice(0, 300),
    });
    // A snapshot hint (either mode) rides into the Firecrawl request as the
    // KTD9 same-fetch capture formats — this branch is the only place the
    // "on_fallback" hint materializes into artifacts.
    return { ...await firecrawlScrape(url, opts), served_by: "firecrawl" };
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
  let attempts = 0;

  const combined = async () => {
    attempts++;
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

  let markdownResult: ScrapeResult;
  try {
    attempts++;
    // The split path issues TWO independent fetches (markdown, then rawHtml),
    // which can be served by different providers — so it can never satisfy the
    // KTD9 same-fetch capture guarantee. Drop the snapshot hint from both
    // sub-fetches (no wasted screenshot work, no stray screenshot_url) and
    // clear any capture artifacts from the merged result below, so a
    // split-path detection scrape degrades to markdown_only rather than
    // sealing a screenshot and rawHtml from two different fetches as one
    // "rendered_thirdparty" snapshot.
    const splitOpts = { ...baseOpts, snapshot: undefined };
    markdownResult = await deps.scrape(opts.url, {
      ...splitOpts,
      formats: ["markdown"],
    });
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
      snapshot: undefined,
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
