/**
 * Bundle B — Exa /search retrieval client.
 *
 * Mirrors the firecrawl.ts surface (`SearchHit[]` return shape) so downstream
 * stages (`filterUsableBeatCandidates`, `aiFilterResults`, `extractAtomicUnits`)
 * are unchanged. Adds Exa-native fields (`publishedDate`, `highlights`) on a
 * superset interface for callers that want them.
 *
 * Beat-scout retrieval port selection happens in scout-beat-execute via:
 *   - `scout.metadata.retrieval = "exa" | "firecrawl"` (per-scout override)
 *   - `BEAT_RETRIEVAL` env var (global kill-switch)
 *
 * Docs: https://docs.exa.ai/reference/search-api-guide-for-coding-agents
 *
 * Rollout stays guarded by the retrieval-port default, Firecrawl fallback, and
 * explicit live benchmark gates before Exa becomes the Beat default.
 */

import { ApiError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type { SearchHit } from "./scrape_types.ts";

const EXA_BASE = "https://api.exa.ai";

function exaApiKey(): string {
  const k = Deno.env.get("EXA_API_KEY");
  if (!k) throw new ApiError("EXA_API_KEY not configured", 500);
  return k;
}

/**
 * Exa search hit. Superset of Firecrawl SearchHit so downstream code that
 * only consumes the base fields keeps working unchanged.
 */
export interface ExaSearchHit extends SearchHit {
  /** First-class publishedDate (87% coverage in benchmark vs <50% Firecrawl SERP). */
  publishedDate?: string | null;
  /** Query-relevant excerpts. Used as the digest's `excerpt` source. */
  highlights?: string[];
  highlightScores?: number[];
  /** Exa relevance score (0-1). */
  score?: number;
}

export type ExaCategory =
  | "news"
  | "personal site"
  | "company"
  | "people"
  | "research paper"
  | "financial report";

export type ExaSearchType =
  | "auto"
  | "fast"
  | "instant"
  | "deep-lite"
  | "deep"
  | "deep-reasoning";

export interface ExaSearchOptions {
  /** Content type lane. `news` is the Beat default; `personal site` for niche mode. */
  category?: ExaCategory;
  /** ISO 3166-1 alpha-2 country code. e.g. "CH", "SE", "CA". */
  userLocation?: string;
  /** Up to 1200 domains. Wildcards `*.domain.com` and path prefixes supported. */
  includeDomains?: string[];
  /** Up to 1200 domains. */
  excludeDomains?: string[];
  /** ISO 8601. Filters `publishedDate` server-side — replaces Firecrawl Stage 3 date filter. */
  startPublishedDate?: string;
  endPublishedDate?: string;
  /** 1-100. Beat default = 25 (enough candidates to feed AI filter). */
  numResults?: number;
  /** Default `"auto"`. `"deep"`/`"deep-reasoning"` cost more; useful for outputSchema synthesis. */
  type?: ExaSearchType;
  /** Per-result content extraction. */
  contents?: {
    highlights?: boolean;
    text?: { maxCharacters?: number; verbosity?: "compact" | "full" };
    summary?: { query?: string };
    /** Cache window. 0 = always livecrawl; -1 = cache only; omit = default fallback. */
    maxAgeHours?: number;
    livecrawlTimeout?: number;
  };
  /** Optional client-side abort fuse in ms. */
  abortAfterMs?: number;
}

interface RawExaResult {
  url?: string;
  title?: string;
  text?: string;
  publishedDate?: string | null;
  highlights?: string[];
  highlightScores?: number[];
  score?: number;
}

interface RawExaResponse {
  results?: RawExaResult[];
  resolvedSearchType?: string;
  costDollars?: { total?: number };
  requestId?: string;
}

export interface ExaSearchResponse {
  hits: ExaSearchHit[];
  totalCostDollars: number | null;
  requestId: string | null;
  resolvedSearchType: string | null;
}

/**
 * Single POST to /search. Returns SearchHit-compatible array; callers
 * that need Exa-only fields (publishedDate, highlights) can cast to
 * `ExaSearchHit[]`.
 */
export async function exaSearch(
  query: string,
  opts: ExaSearchOptions = {},
): Promise<ExaSearchHit[]> {
  return (await exaSearchWithMetadata(query, opts)).hits;
}

/**
 * Same request as `exaSearch`, but preserves response-level metadata used by
 * production canary accounting.
 */
export async function exaSearchWithMetadata(
  query: string,
  opts: ExaSearchOptions = {},
): Promise<ExaSearchResponse> {
  const abortAfterMs = opts.abortAfterMs ?? 45_000;
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);

  const body: Record<string, unknown> = {
    query,
    type: opts.type ?? "auto",
    numResults: Math.max(1, Math.min(opts.numResults ?? 10, 100)),
  };
  if (opts.category) body.category = opts.category;
  if (opts.userLocation) body.userLocation = opts.userLocation;
  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains;
  if (opts.startPublishedDate) {
    body.startPublishedDate = opts.startPublishedDate;
  }
  if (opts.endPublishedDate) body.endPublishedDate = opts.endPublishedDate;
  if (opts.contents) {
    const c: Record<string, unknown> = {};
    if (opts.contents.highlights !== undefined) {
      c.highlights = opts.contents.highlights;
    }
    if (opts.contents.text !== undefined) c.text = opts.contents.text;
    if (opts.contents.summary !== undefined) c.summary = opts.contents.summary;
    if (opts.contents.maxAgeHours !== undefined) {
      c.maxAgeHours = opts.contents.maxAgeHours;
    }
    if (opts.contents.livecrawlTimeout !== undefined) {
      c.livecrawlTimeout = opts.contents.livecrawlTimeout;
    }
    body.contents = c;
  }

  let res: Response;
  try {
    res = await fetch(`${EXA_BASE}/search`, {
      method: "POST",
      headers: {
        "x-api-key": exaApiKey(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(fuse);
    if (e instanceof Error && e.name === "AbortError") {
      throw new ApiError(`exa search aborted after ${abortAfterMs}ms`, 504);
    }
    throw e;
  }
  clearTimeout(fuse);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`exa search failed: ${res.status} ${text}`, 502);
  }

  const json = await res.json() as RawExaResponse;
  const results = Array.isArray(json.results) ? json.results : [];

  const hits = results
    .map((r): ExaSearchHit => ({
      url: String(r.url ?? ""),
      title: typeof r.title === "string" ? r.title : undefined,
      description: typeof r.text === "string"
        ? r.text.slice(0, 240)
        : undefined,
      // Map Exa publishedDate → SearchHit.date so downstream Firecrawl-shaped
      // code keeps working.
      date: typeof r.publishedDate === "string" ? r.publishedDate : null,
      publishedDate: typeof r.publishedDate === "string"
        ? r.publishedDate
        : null,
      highlights: Array.isArray(r.highlights) ? r.highlights : undefined,
      highlightScores: Array.isArray(r.highlightScores)
        ? r.highlightScores
        : undefined,
      score: typeof r.score === "number" ? r.score : undefined,
      source: "web",
    }))
    .filter((h) => h.url.length > 0);
  return {
    hits,
    totalCostDollars: typeof json.costDollars?.total === "number"
      ? json.costDollars.total
      : null,
    requestId: typeof json.requestId === "string" ? json.requestId : null,
    resolvedSearchType: typeof json.resolvedSearchType === "string"
      ? json.resolvedSearchType
      : null,
  };
}

/**
 * Per-scout retrieval port resolver. Reads in priority order:
 *   1. BEAT_RETRIEVAL env (global kill-switch — set to "firecrawl" to roll back)
 *   2. scout.metadata.retrieval (per-scout override)
 *   3. default "exa"
 */
export function resolveBeatRetrievalPort(
  scoutMetadata: Record<string, unknown> | null | undefined,
): "exa" | "firecrawl" {
  // Exa is the sole Beat retrieval port (SCRAPING-MIGRATION-PRD U5). The
  // Firecrawl kill-switch (env BEAT_RETRIEVAL=firecrawl / scout metadata
  // retrieval=firecrawl) is retired; a lingering request is logged and
  // ignored. Signature keeps the union so the beat_pipeline firecrawl branch
  // (dead, deleted with Firecrawl in U8) still typechecks.
  const requested = normalizeRetrievalPort(Deno.env.get("BEAT_RETRIEVAL")) ??
    normalizeRetrievalPort(scoutMetadata?.retrieval);
  if (requested === "firecrawl") {
    logEvent({
      level: "warn",
      fn: "beat-retrieval",
      event: "firecrawl_retrieval_deprecated",
      msg: "BEAT_RETRIEVAL=firecrawl is retired; using Exa",
    });
  }
  return "exa";
}

export function normalizeRetrievalPort(
  value: unknown,
): "exa" | "firecrawl" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "exa" || normalized === "firecrawl" ? normalized : null;
}

export function shouldFallbackFromExa(opts: {
  requestedRetrieval: "firecrawl" | "exa";
  retrievalEnv?: string | null;
  discoveredCount: number;
  scoutMetadata?: Record<string, unknown> | null;
}): boolean {
  if (opts.requestedRetrieval !== "exa") return false;
  if (normalizeRetrievalPort(opts.retrievalEnv) === "exa") return false;
  if (opts.scoutMetadata?.exa_fallback === false) return false;
  return opts.discoveredCount < 2;
}
