import { ApiError } from "./errors.ts";
import { firecrawlScrape } from "./scrape_firecrawl.ts";
import type { ScrapeOptions, ScrapeResult } from "./scrape_types.ts";

export type ScrapeFallbackReason = "anti_bot" | "timeout_exhausted";

/** Mirrors the durable crawler completion policy; transport/admission errors do not qualify. */
export function crawlerFallbackReason(
  operation: string,
  errorClass: string | null,
  attempts: number,
  maxAttempts: number,
): ScrapeFallbackReason | null {
  if (operation !== "scrape") return null;
  if (errorClass === "anti_bot") return "anti_bot";
  return errorClass === "timeout" && maxAttempts > 0 && attempts >= maxAttempts
    ? "timeout_exhausted"
    : null;
}

/** Ownership is acquired by the caller before this single, non-retrying request. */
export async function scrapeFallbackOnce(
  url: string,
  opts: ScrapeOptions,
  reason: ScrapeFallbackReason,
  deadlineMs: number,
): Promise<ScrapeResult> {
  const remainingMs = Math.floor(deadlineMs - Date.now());
  if (
    opts.noAntibotFallback || remainingMs < 1_000 ||
    !Deno.env.get("FIRECRAWL_API_KEY")
  ) {
    throw new ApiError(
      "scrape fallback unavailable or original deadline exhausted",
      502,
      "scrape_fallback_failed",
    );
  }
  try {
    return {
      ...await firecrawlScrape(url, {
        ...opts,
        // A primary navigation limit is not a second limit on exhausted-timeout recovery.
        timeoutMs: reason === "timeout_exhausted"
          ? remainingMs
          : Math.min(opts.timeoutMs ?? 120_000, remainingMs),
        abortAfterMs: remainingMs,
      }),
      served_by: "firecrawl",
      fallback_reason: reason,
    };
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : String(error),
      error instanceof ApiError ? error.status : 502,
      "scrape_fallback_failed",
    );
  }
}
