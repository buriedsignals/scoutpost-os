/**
 * beat-search Edge Function — synchronous preview search for Beat / Location
 * Scouts. Returns a `BeatSearchResponse`-shaped payload used by the New Scout
 * UI (BeatScoutView "Start Search" button). This is the v2 successor to the
 * old pulse preview search surface.
 *
 * Route:
 *   POST /beat-search
 *     body: {
 *       location?: { displayName?, city?, country? },
 *       category?: "news"|"government"|"analysis",
 *       source_mode?: "reliable"|"niche",
 *       criteria?: string,
 *       excluded_domains?: string[],
 *       priority_sources?: string[],
 *       custom_filter_prompt?: string
 *     }
 *     -> 200 { status, category, task_completed, articles, totalResults,
 *              search_queries_used, urls_scraped, processing_time_ms,
 *              summary, response_markdown, filteredOutCount, outcome, diagnostics }
 *
 * Pipeline:
 *   1. Shared Beat discovery pipeline (query generation, search, recency,
 *      dedup, AI relevance filter).
 *   2. Parallel scrape up to 8 selected hits for markdown.
 *   3. OpenRouter structured extraction → `articles` with { title, url, source,
 *      summary, date?, verified:true } filtered against criteria.
 *
 * Nothing is persisted; no credit decrement (preview only). The authoritative
 * decrement happens in `scout-beat-execute` when the scout actually runs.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { AuthedUser, requireUser } from "../_shared/auth.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { scrape } from "../_shared/scrape.ts";
import type { ScrapeResult } from "../_shared/scrape_types.ts";
import {
  createRequestBudget,
  type RequestBudget,
} from "../_shared/request_budget.ts";
import { mapLimit, scrapeWithinBudget } from "./budget_stage.ts";
import { openRouterExtract } from "../_shared/openrouter.ts";
import {
  type BeatCategory,
  type BeatHit,
  type BeatScope,
  type BeatSourceMode,
  countryPrimaryLanguage,
  discoverBeatHits,
  discoverPriorityDomainHits,
  isKnownStaleBeatDate,
  renderedArticleCandidates,
  summarizeSearchJobs,
} from "../_shared/beat_pipeline.ts";
import {
  buildBeatLocationMatcher,
  parseBeatLocation,
} from "../_shared/beat_location.ts";
import { buildBeatCriteriaRule } from "../_shared/beat_criteria.ts";
import {
  preferSourcePublishedDate,
  sourcePublishedDate,
} from "../_shared/atomic_extract.ts";

const LocationSchema = z.object({
  displayName: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  coords: z
    .object({ lat: z.number().optional(), lon: z.number().optional() })
    .partial()
    .optional(),
}).passthrough();

const InputSchema = z.object({
  location: LocationSchema.optional(),
  category: z.enum(["news", "government", "analysis"]).default("news"),
  source_mode: z.enum(["reliable", "niche"]).optional(),
  criteria: z.string().max(4000).optional(),
  excluded_domains: z.array(z.string()).max(100).optional(),
  priority_sources: z.array(z.string()).max(100).optional(),
  custom_filter_prompt: z.string().max(4000).optional(),
  exclude_urls: z.array(z.string()).max(200).optional(),
});

const MAX_SCRAPES = 8;
// The hosted gateway cuts a request at 150 s idle. Spend at most 120 s:
// scrapes stop early once fewer than reserve + floor remain, so extraction
// always runs and the user gets a (possibly partial) preview, never a 504.
const PREVIEW_BUDGET_MS = envMs("BEAT_PREVIEW_BUDGET_MS", 120_000);
const PREVIEW_SCRAPE_TIMEOUT_MS = envMs(
  "BEAT_PREVIEW_SCRAPE_TIMEOUT_MS",
  45_000,
);
const PREVIEW_RESERVE_MS = envMs("BEAT_PREVIEW_RESERVE_MS", 25_000);
const PREVIEW_SCRAPE_FLOOR_MS = envMs("BEAT_PREVIEW_SCRAPE_FLOOR_MS", 10_000);

function envMs(name: string, fallback: number): number {
  const raw = Number(Deno.env.get(name));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
// Keep preview bursts within the renderer's two ordinary admission slots.
const SCRAPE_CONCURRENCY = 2;
const MARKDOWN_PER_HIT = 6_000;
const PROMPT_MAX = 40_000;
const MAX_ARTICLES_OUT = 12;

interface ExtractedArticle {
  title: string;
  url: string;
  source?: string;
  summary: string;
  date?: string | null;
  matches_criteria?: boolean;
  matches_location?: boolean;
}

export interface BeatPreviewDiagnostics {
  search_failures: number;
  sources_attempted: number;
  sources_read: number;
  sources_failed: number;
  excluded_candidates: number;
  stale_sources: number;
  criteria_filtered: number;
  location_filtered: number;
  stale_articles: number;
  model_filtered: number;
  /** Candidates never attempted because the request budget ran out. */
  sources_skipped: number;
}

export type BeatPreviewOutcome =
  | "results"
  | "filtered_empty"
  | "no_candidates"
  | "unreadable_sources"
  | "unverified_empty"
  | "error";

interface PrioritySourcePlan {
  directUrls: string[];
  domains: string[];
}

function partitionPrioritySources(sources: string[]): PrioritySourcePlan {
  const directUrls: string[] = [];
  const domains: string[] = [];
  for (const source of sources) {
    const normalized = normalizePrioritySource(source);
    if (!normalized) continue;
    if (normalized.kind === "url") directUrls.push(normalized.value);
    else domains.push(normalized.value);
  }
  return {
    directUrls: uniqueStrings(directUrls),
    domains: uniqueStrings(domains),
  };
}

function normalizePrioritySource(
  source: string,
): { kind: "url" | "domain"; value: string } | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (!host.includes(".")) return null;
    if (!path && !url.search) return { kind: "domain", value: host };
    return { kind: "url", value: url.toString() };
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

const ARTICLES_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          source: { type: "string" },
          summary: { type: "string" },
          date: { type: ["string", "null"] },
          matches_criteria: { type: "boolean" },
          matches_location: { type: "boolean" },
        },
        required: ["title", "url", "summary"],
        additionalProperties: false,
      },
    },
    filtered_out: { type: "integer" },
  },
  required: ["summary", "articles"],
  additionalProperties: false,
};

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  let user: AuthedUser;
  try {
    user = await requireUser(req);
  } catch (e) {
    return jsonFromError(e);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonFromError(new ValidationError("invalid JSON body"));
  }
  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonFromError(
      new ValidationError(
        parsed.error.issues.map((i) => i.message).join("; "),
      ),
    );
  }
  const input = parsed.data;

  if (!input.location && !input.criteria) {
    return jsonFromError(
      new ValidationError("location or criteria is required"),
    );
  }

  const startedAt = Date.now();
  const diagnostics: BeatPreviewDiagnostics = {
    search_failures: 0,
    sources_attempted: 0,
    sources_read: 0,
    sources_failed: 0,
    excluded_candidates: 0,
    stale_sources: 0,
    criteria_filtered: 0,
    location_filtered: 0,
    stale_articles: 0,
    model_filtered: 0,
    sources_skipped: 0,
  };
  const budget = createRequestBudget({ totalMs: PREVIEW_BUDGET_MS });

  try {
    return await runSearch(input, user, startedAt, diagnostics, budget);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "beat-search",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonOk({
      status: "failed",
      outcome: "error",
      diagnostics,
      category: input.category,
      task_completed: false,
      articles: [],
      totalResults: 0,
      search_queries_used: [],
      urls_scraped: [],
      processing_time_ms: Date.now() - startedAt,
      summary: "",
      response_markdown: "Search failed. Please try again.",
      filteredOutCount: 0,
      budget_exhausted: budget.exhausted,
      sources_skipped: diagnostics.sources_skipped,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

// ---------------------------------------------------------------------------

async function runSearch(
  input: z.infer<typeof InputSchema>,
  user: AuthedUser,
  startedAt: number,
  diagnostics: BeatPreviewDiagnostics,
  budget: RequestBudget,
): Promise<Response> {
  const excluded = new Set(
    (input.excluded_domains ?? []).map((d) => d.toLowerCase()),
  );
  const priority = (input.priority_sources ?? []).map((s) => s.trim()).filter(
    (s) => s.length > 0,
  );
  const priorityPlan = partitionPrioritySources(priority);
  const seen = new Set<string>();
  const excludeUrls = new Set(input.exclude_urls ?? []);

  let queries: string[] = [];
  let selectedHits: BeatHit[] = [];

  if (
    priorityPlan.directUrls.length > 0 && priorityPlan.domains.length === 0
  ) {
    selectedHits = priorityPlan.directUrls.map((url) => ({ url }));
  } else {
    selectedHits.push(...priorityPlan.directUrls.map((url) => ({ url })));
    let prioritySearchStats = { jobsAttempted: 0, jobsErrored: 0 };
    const location = parseBeatLocation(input.location);
    const scope: BeatScope = input.location && input.criteria
      ? "combined"
      : input.location
      ? "location"
      : "topic";
    const sourceMode: BeatSourceMode = input.source_mode === "niche"
      ? "niche"
      : "reliable";
    const category = input.category as BeatCategory;
    if (priorityPlan.domains.length > 0) {
      const priorityDiscovery = await discoverPriorityDomainHits({
        domains: priorityPlan.domains,
        criteria: input.criteria?.trim() || null,
        location,
        excludedDomains: input.excluded_domains ?? [],
      });
      queries.push(...priorityDiscovery.queries);
      selectedHits.push(...priorityDiscovery.hits);
      prioritySearchStats = priorityDiscovery;
    }
    const discoveryOpts = {
      scope,
      sourceMode,
      category,
      city: location.city,
      state: location.state,
      country: location.country,
      countryCode: location.countryCode,
      displayName: location.displayName,
      criteria: input.criteria?.trim() || null,
      preferredLanguage: location.countryCode
        ? countryPrimaryLanguage(location.countryCode)
        : "en",
      excludedDomains: input.excluded_domains,
    };
    const discovery = await discoverBeatHits(discoveryOpts);
    queries.push(...discovery.queriesUsed);
    selectedHits.push(...discovery.hits);
    const searchStats = summarizeSearchJobs(prioritySearchStats, discovery);
    diagnostics.search_failures = searchStats.jobsErrored;
    if (
      searchStats.allErrored &&
      selectedHits.length === 0
    ) {
      throw new Error(
        "beat retrieval failed: every Firecrawl search query errored",
      );
    }
  }

  const filteredHits: BeatHit[] = [];
  for (const h of selectedHits) {
    if (!h.url || seen.has(h.url)) continue;
    if (excludeUrls.has(h.url)) {
      diagnostics.excluded_candidates++;
      continue;
    }
    const dom = safeDomain(h.url);
    if (dom && excluded.has(dom)) {
      diagnostics.excluded_candidates++;
      continue;
    }
    seen.add(h.url);
    filteredHits.push(h);
    if (filteredHits.length >= MAX_SCRAPES) break;
  }

  if (filteredHits.length === 0) {
    return jsonOk(
      emptyResponse(
        input.category,
        startedAt,
        "No candidates available after discovery and request exclusions",
        "no_candidates",
        diagnostics,
        queries,
      ),
    );
  }

  // 4. Scrape with bounded concurrency inside the request budget.
  const budgetedScrape = (hits: BeatHit[], event: string) =>
    scrapeWithinBudget(hits, {
      budget,
      concurrency: SCRAPE_CONCURRENCY,
      defaultTimeoutMs: PREVIEW_SCRAPE_TIMEOUT_MS,
      reserveMs: PREVIEW_RESERVE_MS,
      floorMs: PREVIEW_SCRAPE_FLOOR_MS,
      scrape,
      scrapeOptions: { workloadClass: "utility", tenantKey: user.id },
      onFailure: (url, e) =>
        logEvent({
          level: "warn",
          fn: "beat-search",
          event,
          user_id: user.id,
          url,
          msg: e instanceof Error ? e.message : String(e),
        }),
    });
  const initial = await budgetedScrape(filteredHits, "scrape_failed");
  const initialAttemptedHits = filteredHits.slice(0, initial.attempted.length);
  const initialScrapedOk: Array<{ hit: BeatHit; scrape: ScrapeResult }> = [];
  for (let i = 0; i < initialAttemptedHits.length; i++) {
    const s = initial.results[i];
    if (s && s.markdown && s.markdown.trim().length > 0) {
      initialScrapedOk.push({ hit: initialAttemptedHits[i], scrape: s });
    }
  }

  // A rendered section page can expose fresh article links that Firecrawl's
  // search snippet omitted. Replace that discovery carrier with a bounded set
  // of concrete article scrapes so publication dates and source URLs come from
  // the article itself.
  const initialByUrl = new Map(
    initialScrapedOk.map((item) => [item.hit.url, item]),
  );
  const expandedHits: BeatHit[] = [];
  const expandedSeen = new Set<string>();
  for (const item of initialScrapedOk) {
    const linked = renderedArticleCandidates(item.hit, item.scrape);
    for (const hit of linked.length > 0 ? linked : [item.hit]) {
      if (!expandedSeen.has(hit.url)) {
        expandedSeen.add(hit.url);
        expandedHits.push(hit);
      }
    }
  }
  const effectiveHits = expandedHits.slice(0, MAX_SCRAPES);
  const followupHits = effectiveHits.filter((hit) =>
    !initialByUrl.has(hit.url)
  );
  const followup = await budgetedScrape(
    followupHits,
    "article_followup_scrape_failed",
  );
  const followupAttemptedHits = followupHits.slice(
    0,
    followup.attempted.length,
  );
  const followupByUrl = new Map<string, {
    hit: BeatHit;
    scrape: ScrapeResult;
  }>();
  for (let i = 0; i < followupAttemptedHits.length; i++) {
    const s = followup.results[i];
    if (s?.markdown?.trim()) {
      followupByUrl.set(followupAttemptedHits[i].url, {
        hit: followupAttemptedHits[i],
        scrape: s,
      });
    }
  }
  const readableScrapes = effectiveHits.flatMap((hit) => {
    const item = initialByUrl.get(hit.url) ?? followupByUrl.get(hit.url);
    return item ? [item] : [];
  });
  const scrapedOk = readableScrapes.filter(({ hit, scrape }) =>
    !isKnownStaleBeatDate(
      sourcePublishedDate({ scrape, searchDate: hit.date }),
    )
  );
  const staleFilteredOut = readableScrapes.length - scrapedOk.length;
  const attemptedScrapeUrls = [...initial.attempted, ...followup.attempted];
  const budgetExhausted = initial.budgetExhausted || followup.budgetExhausted;
  diagnostics.sources_skipped = initial.skipped + followup.skipped;
  if (budgetExhausted) {
    logEvent({
      level: "warn",
      fn: "beat-search",
      event: "preview_budget_exhausted",
      user_id: user.id,
      elapsed_ms: budget.elapsedMs(),
      attempted: attemptedScrapeUrls.length,
      skipped: diagnostics.sources_skipped,
    });
  }
  diagnostics.sources_attempted = attemptedScrapeUrls.length;
  // Count actual successful reads, including section pages used for discovery.
  diagnostics.sources_read = initialScrapedOk.length + followupByUrl.size;
  diagnostics.sources_failed = diagnostics.sources_attempted -
    diagnostics.sources_read;
  diagnostics.stale_sources = staleFilteredOut;

  if (scrapedOk.length === 0) {
    // A budget cut leaves candidates unread, so emptiness is unproven.
    const outcome = readableScrapes.length === 0
      ? "unreadable_sources"
      : !budgetExhausted && diagnostics.sources_failed === 0 &&
          diagnostics.search_failures === 0
      ? "filtered_empty"
      : "unverified_empty";
    return jsonOk(
      emptyResponse(
        input.category,
        startedAt,
        outcome === "filtered_empty"
          ? "All readable article sources were outside the freshness window"
          : outcome === "unreadable_sources"
          ? "Sources could not be read"
          : budgetExhausted
          ? "Preview ran out of time before enough sources were read"
          : "Readable article sources were stale; other retrievals failed",
        outcome,
        diagnostics,
        queries,
        attemptedScrapeUrls,
        budgetExhausted,
      ),
    );
  }

  // 5. OpenRouter extraction.
  const locationInstructions = buildLocationFilterInstructions(input.location);
  const parsedLocation = parseBeatLocation(input.location);
  const locationMatcher = buildBeatLocationMatcher(parsedLocation);
  const aggregated = scrapedOk
    .map(({ hit, scrape }) =>
      `=== SOURCE: ${hit.url}\nTITLE: ${
        scrape.title ?? hit.title ?? ""
      }\nSEARCH_DATE: ${hit.date ?? "unknown"}\nSOURCE_DATE: ${
        sourcePublishedDate({ scrape, searchDate: hit.date }) ?? "unknown"
      }\n\n${(scrape.markdown ?? "").slice(0, MARKDOWN_PER_HIT)}\n`
    )
    .join("\n\n");

  const filterInstructions = buildFilterInstructions(input);
  const prompt =
    `You are a news analyst. From the sources below, extract up to ${MAX_ARTICLES_OUT} ` +
    `distinct articles and return them as JSON matching the provided schema.\n\n` +
    `For each article: title, url (reuse the SOURCE URL exactly), source (the domain ` +
    `without www.), summary (2-3 sentences), date (ISO 8601 if known else null), ` +
    `matches_criteria (true if the article matches the criteria — if no criteria, default true), ` +
    `matches_location (true if the article is primarily about the requested location — if no location, default true).\n\n` +
    `${filterInstructions}\n${locationInstructions}\n\n` +
    `Also provide an overall "summary" field (1-3 sentences) describing what the ` +
    `results say about the topic/location. Set "filtered_out" to the number of ` +
    `articles you dropped as irrelevant.\n\n` +
    `SOURCES:\n${aggregated.slice(0, PROMPT_MAX)}`;

  let extraction: {
    summary: string;
    articles: ExtractedArticle[];
    filtered_out?: number;
  };
  try {
    extraction = await openRouterExtract(prompt, ARTICLES_SCHEMA);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "beat-search",
      event: "extract_failed",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonOk({
      status: "partial",
      outcome: "error",
      diagnostics,
      error: e instanceof Error ? e.message : String(e),
      category: input.category,
      task_completed: false,
      articles: scrapedOk.slice(0, MAX_ARTICLES_OUT).map(({ hit, scrape }) => ({
        title: scrape.title ?? hit.title ?? hit.url,
        url: hit.url,
        source: safeDomain(hit.url) ?? "",
        summary: (scrape.markdown ?? "").slice(0, 240).replace(/\s+/g, " ")
          .trim(),
        date: sourcePublishedDate({ scrape, searchDate: hit.date }),
        imageUrl: null,
        verified: false,
      })),
      totalResults: scrapedOk.length,
      search_queries_used: queries,
      urls_scraped: attemptedScrapeUrls,
      processing_time_ms: Date.now() - startedAt,
      summary: "",
      response_markdown: "Partial results — LLM extraction failed.",
      filteredOutCount: 0,
    });
  }

  const extractedArticles = Array.isArray(extraction.articles)
    ? extraction.articles
    : [];
  const scrapedByUrl = new Map<
    string,
    { hit: BeatHit; scrape: ScrapeResult }
  >();
  for (const { hit, scrape } of scrapedOk) {
    scrapedByUrl.set(hit.url, { hit, scrape });
    scrapedByUrl.set(scrape.source_url, { hit, scrape });
  }
  const seenUrls = new Set<string>();
  const articles = [] as Array<{
    title: string;
    url: string;
    source: string;
    summary: string;
    date: string | null;
    imageUrl: string | null;
    verified: boolean;
  }>;
  let filteredOut = staleFilteredOut;
  for (const a of extractedArticles) {
    if (!a || typeof a.url !== "string" || !a.url.trim()) continue;
    if (seenUrls.has(a.url)) continue;
    if (input.criteria && a.matches_criteria === false) {
      filteredOut += 1;
      diagnostics.criteria_filtered++;
      continue;
    }
    if (input.location && a.matches_location === false) {
      filteredOut += 1;
      diagnostics.location_filtered++;
      continue;
    }
    if (
      input.location &&
      locationMatcher &&
      !locationMatcher(
        [a.title, a.summary, a.source, a.url].filter(Boolean).join(" "),
      )
    ) {
      filteredOut += 1;
      diagnostics.location_filtered++;
      continue;
    }
    const source = scrapedByUrl.get(a.url);
    const fallbackDate = source
      ? sourcePublishedDate({
        scrape: source.scrape,
        searchDate: source.hit.date,
      })
      : null;
    const publishedDate = preferSourcePublishedDate(
      fallbackDate,
      a.date ?? null,
    );
    if (isKnownStaleBeatDate(publishedDate)) {
      filteredOut += 1;
      diagnostics.stale_articles++;
      continue;
    }
    seenUrls.add(a.url);
    articles.push({
      title: String(a.title ?? "").slice(0, 300) || a.url,
      url: a.url,
      source: a.source ?? safeDomain(a.url) ?? "",
      summary: String(a.summary ?? ""),
      date: publishedDate,
      imageUrl: null,
      verified: true,
    });
    if (articles.length >= MAX_ARTICLES_OUT) break;
  }

  if (
    Number.isInteger(extraction.filtered_out) &&
    extraction.filtered_out! >= 0
  ) {
    diagnostics.model_filtered = extraction.filtered_out!;
    filteredOut = Math.max(filteredOut, diagnostics.model_filtered);
  }
  // A stale source alone cannot explain why extraction of fresh sources was empty.
  const verifiedFilteredEmpty = Array.isArray(extraction.articles) &&
    !budgetExhausted &&
    diagnostics.sources_failed === 0 && diagnostics.search_failures === 0 &&
    (diagnostics.criteria_filtered + diagnostics.location_filtered +
        diagnostics.stale_articles + diagnostics.model_filtered > 0);

  const finalSummary = input.location &&
      locationMatcher &&
      extraction.summary &&
      !locationMatcher(extraction.summary)
    ? articles.slice(0, 3).map((article) => article.summary).filter((s) =>
      typeof s === "string" && s.trim().length > 0
    ).join(" ")
    : extraction.summary ?? "";

  logEvent({
    level: "info",
    fn: "beat-search",
    event: "success",
    user_id: user.id,
    queries: queries.length,
    scraped: scrapedOk.length,
    articles: articles.length,
    filtered_out: filteredOut,
    budget_exhausted: budgetExhausted,
    sources_skipped: diagnostics.sources_skipped,
    elapsed_ms: budget.elapsedMs(),
  });

  return jsonOk({
    status: articles.length > 0 ? "completed" : "not_found",
    outcome: articles.length > 0
      ? "results"
      : verifiedFilteredEmpty
      ? "filtered_empty"
      : "unverified_empty",
    diagnostics,
    category: input.category,
    task_completed: true,
    articles,
    totalResults: articles.length,
    search_queries_used: queries,
    urls_scraped: attemptedScrapeUrls,
    processing_time_ms: Date.now() - startedAt,
    summary: finalSummary,
    response_markdown: finalSummary,
    filteredOutCount: filteredOut,
    budget_exhausted: budgetExhausted,
    sources_skipped: diagnostics.sources_skipped,
  });
}

function buildFilterInstructions(
  input: z.infer<typeof InputSchema>,
): string {
  if (input.custom_filter_prompt) {
    return `Filter each article against these instructions: ${input.custom_filter_prompt}`;
  }
  if (input.criteria) {
    return `Only include articles that match this criteria: "${input.criteria}". ` +
      `${buildBeatCriteriaRule(input.criteria)} ` +
      `Set matches_criteria=true when the article clearly relates; false otherwise.`;
  }
  return `Include any article that is recent and substantive. ` +
    `Set matches_criteria=true for all included articles.`;
}

function buildLocationFilterInstructions(
  location: z.infer<typeof LocationSchema> | undefined,
): string {
  if (!location) {
    return `No location filter. Set matches_location=true for all included articles.`;
  }
  const parsed = parseBeatLocation(location);
  const locationLabel = parsed.city && parsed.country
    ? `${parsed.city}, ${parsed.country}`
    : parsed.city || parsed.country || location.displayName ||
      "the requested location";
  return `Only include articles primarily about ${locationLabel}. ` +
    `If an article is mainly about another city, region, or country, set matches_location=false even if the topic matches. ` +
    `For country targets, do not substitute same-language coverage from another country.`;
}

function emptyResponse(
  category: string,
  startedAt: number,
  reason: string,
  outcome: BeatPreviewOutcome,
  diagnostics: BeatPreviewDiagnostics,
  queries: string[] = [],
  urls: string[] = [],
  budgetExhausted = false,
) {
  return {
    status: outcome === "unreadable_sources" ? "failed" : "not_found",
    outcome,
    diagnostics,
    category,
    task_completed: outcome !== "unreadable_sources",
    articles: [] as unknown[],
    totalResults: 0,
    search_queries_used: queries,
    urls_scraped: urls,
    processing_time_ms: Date.now() - startedAt,
    summary: "",
    response_markdown: reason,
    filteredOutCount: diagnostics.stale_sources,
    budget_exhausted: budgetExhausted,
    sources_skipped: diagnostics.sources_skipped,
    ...(outcome === "unreadable_sources" ? { error: reason } : {}),
  };
}

function safeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// normalizeDate moved to ../_shared/date_utils.ts (imported at the top).
