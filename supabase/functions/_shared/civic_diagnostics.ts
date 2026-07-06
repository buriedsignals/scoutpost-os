export type CivicTrackedUrlState =
  | "unsupported"
  | "scraped"
  | "scrape_failed"
  // "gone": the tracked page returned a 4xx (removed/forbidden) — a PERMANENT
  // condition, distinct from a transient "scrape_failed". Kept separate so a
  // single dead page cannot count as a run failure and auto-pause an otherwise
  // healthy scout; the all-gone case is handled by allTrackedUrlsGone.
  | "gone"
  | "unchanged"
  | "queued"
  | "already_seen"
  | "no_new_documents";

export interface CivicTrackedUrlStatus {
  url: string;
  status: CivicTrackedUrlState;
  change_status?: string | null;
  upstream_status?: number | null;
  queued_documents?: number;
  error?: string | null;
}

export function firecrawlUpstreamStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  // Matches both provider prefixes: "firecrawl scrape failed: 502" and
  // "crawl4ai scrape failed: 502" (SCRAPING-MIGRATION-PRD U2).
  const match = message.match(/(?:firecrawl|crawl4ai) [^:]+ failed:\s*(\d{3})\b/i) ??
    message.match(/\bstatus[=:\s]+(\d{3})\b/i);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
}

/**
 * True when EVERY tracked URL is permanently gone (4xx). Signals a dead scout
 * whose run should be skipped + refunded rather than retried. A run with any
 * live, transiently-failed (5xx / provider error), or successfully-scraped URL
 * returns false so it follows the normal path.
 */
export function allTrackedUrlsGone(
  statuses: CivicTrackedUrlStatus[],
  trackedCount: number,
): boolean {
  return trackedCount > 0 && statuses.length === trackedCount &&
    statuses.every((entry) => entry.status === "gone");
}
