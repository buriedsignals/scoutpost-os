/**
 * Beat preview scrape stage, bounded by the request budget.
 *
 * Sources are scraped a few at a time until the budget can no longer cover
 * one more scrape plus the reserve held back for extraction. Sources that
 * were never attempted are counted as skipped so the response can say so.
 */
import type { RequestBudget } from "../_shared/request_budget.ts";
import type { ScrapeOptions, ScrapeResult } from "../_shared/scrape_types.ts";

export interface BudgetedScrapeOptions {
  budget: RequestBudget;
  concurrency: number;
  /** Per-scrape timeout when time is plentiful. */
  defaultTimeoutMs: number;
  /** Time held back for the stages after scraping (extraction, response). */
  reserveMs: number;
  /** Minimum time a scrape needs to be worth starting. */
  floorMs: number;
  scrape: (url: string, opts: ScrapeOptions) => Promise<ScrapeResult>;
  scrapeOptions?: Omit<ScrapeOptions, "timeoutMs" | "abortAfterMs">;
  onFailure?: (url: string, error: unknown) => void;
}

export interface BudgetedScrapeOutcome {
  /** One entry per attempted hit, in input order; null when the scrape failed. */
  results: Array<ScrapeResult | null>;
  attempted: string[];
  skipped: number;
  budgetExhausted: boolean;
}

export async function scrapeWithinBudget<H extends { url: string }>(
  hits: H[],
  opts: BudgetedScrapeOptions,
): Promise<BudgetedScrapeOutcome> {
  const results: Array<ScrapeResult | null> = [];
  const attempted: string[] = [];
  let cursor = 0;
  let stopped = false;
  const worker = async () => {
    while (true) {
      if (stopped) return;
      if (
        !opts.budget.canStart({
          reserveMs: opts.reserveMs,
          floorMs: opts.floorMs,
        })
      ) {
        stopped = true;
        return;
      }
      const index = cursor++;
      if (index >= hits.length) return;
      const hit = hits[index];
      const slot = attempted.push(hit.url) - 1;
      results[slot] = null;
      const timeoutMs = opts.budget.timeoutFor(opts.defaultTimeoutMs, {
        reserveMs: opts.reserveMs,
      });
      try {
        results[slot] = await opts.scrape(hit.url, {
          ...(opts.scrapeOptions ?? {}),
          timeoutMs,
          abortAfterMs: timeoutMs + 5_000,
        });
      } catch (error) {
        opts.onFailure?.(hit.url, error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, hits.length) }, worker),
  );
  return {
    results,
    attempted,
    skipped: hits.length - attempted.length,
    budgetExhausted: opts.budget.exhausted,
  };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
