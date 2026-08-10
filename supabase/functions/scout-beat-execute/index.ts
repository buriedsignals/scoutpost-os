/**
 * scout-beat-execute Edge Function — Beat Scout (type='beat') runner.
 *
 * Scrapes up to 20 priority sources in parallel (concurrency 5), aggregates
 * markdown, persists raw_captures per source, and extracts atomic information
 * units via OpenRouter structured output. Used for Beat Scouts (topic/criteria
 * monitoring of a fixed list of reliable sources) in the v2 pipeline.
 *
 * Route:
 *   POST /scout-beat-execute
 *     body: { scout_id: uuid, run_id?: uuid }
 *     -> 200 { status: "ok", sources_scraped: N, articles_count: M, run_id }
 *
 * Auth: shared service auth (X-Service-Key header, with service-role fallback
 * for operator tooling). Invoked by pg_cron and the scouts router's run
 * dispatcher — not from user browsers.
 *
 * Errors:
 *   - 404 if scout missing
 *   - 400 if scout has no location, criteria, or topic
 *   - 500/502 on all Firecrawl/OpenRouter failures; failed runs mark scout_runs
 *     status='error' and call increment_scout_failures (auto-pause at 3).
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient, SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { NotFoundError, ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { scrape, scrapeProvider } from "../_shared/scrape.ts";
import type { ScrapeResult } from "../_shared/scrape_types.ts";
import { isWithinRunDuplicateWithGuards } from "../_shared/dedup.ts";
import { embedBatch, EMBEDDING_MODEL_TAG } from "../_shared/embedding.ts";
import {
  type CanonicalUnitType,
  deriveSourceDomain,
  sha256Hex,
  upsertCanonicalUnit,
} from "../_shared/unit_dedup.ts";
import {
  BeatHit,
  BeatScope,
  BeatSourceMode,
  discoverBeatHits,
  discoverPriorityDomainHits,
  isKnownStaleBeatDate,
  renderedArticleCandidates,
  summarizeSearchJobs,
} from "../_shared/beat_pipeline.ts";
import {
  type DigestArticle,
  formatBeatDigest,
  verifyPlaceNamesGrounded,
} from "../_shared/extractive_summary.ts";
import {
  CREDIT_COSTS,
  decrementOrThrow,
  InsufficientCreditsError,
  insufficientCreditsResponse,
  refundCredits,
} from "../_shared/credits.ts";
import { Article, sendBeatAlert } from "../_shared/notifications.ts";
import { incrementAndMaybeNotify } from "../_shared/scout_failures.ts";
import {
  extractAtomicUnits,
  preferSourcePublishedDate,
  sourcePublishedDate,
} from "../_shared/atomic_extract.ts";
import {
  type FactCheckResult,
  factCheckUnit,
  isFactCheckEnabled,
  loadFactCheckConfig,
} from "../_shared/fact_check.ts";
import { parseBeatLocation } from "../_shared/beat_location.ts";
import { repairMissingBeatBaseline } from "../_shared/baseline_repair.ts";
import {
  classifyRunError,
  markNotificationAttempted,
  markNotificationResult,
  markRunError,
  markRunStage,
  markRunSuccess,
  shouldIncrementScoutFailure,
} from "../_shared/run_lifecycle.ts";

const InputSchema = z.object({
  scout_id: z.string().uuid(),
  run_id: z.string().uuid().optional(),
  baseline_only: z.boolean().optional(),
});

const MAX_SOURCES = 20;
// The self-hosted renderer has two ordinary browser slots. Matching that
// capacity avoids creating 125-second queues inside one Beat invocation; the
// scrape service still sheds cross-scout bursts as a final safety boundary.
const CONCURRENCY = 2;
const RAW_CAPTURE_TTL_DAYS = 30;
const DISCOVERY_SOURCE_LIMITS: Record<BeatScope, number> = {
  // Match topic coverage while keeping location extraction at two units/source.
  location: 6,
  topic: 6,
  combined: 8,
};

function rawCaptureExpiresAt(days = RAW_CAPTURE_TTL_DAYS): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

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
    const hasPath = path.length > 0;
    if (!host.includes(".")) return null;
    if (!hasPath && !url.search) return { kind: "domain", value: host };
    return { kind: "url", value: url.toString() };
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function mergeRunMetadata(
  db: SupabaseClient,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const { data: run } = await db
      .from("scout_runs")
      .select("metadata")
      .eq("id", runId)
      .maybeSingle();
    const metadata = {
      ...asObject((run as { metadata?: unknown } | null)?.metadata),
      ...patch,
    };
    const { error } = await db
      .from("scout_runs")
      .update({ metadata })
      .eq("id", runId);
    if (error) throw new Error(error.message);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "scout-beat-execute",
      event: "run_metadata_update_failed",
      run_id: runId,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
}

interface RetrievalDiscoveryOpts {
  scope: BeatScope;
  sourceMode: BeatSourceMode;
  cityName: string | null;
  stateName: string | null;
  countryName: string | null;
  countryCode: string | null;
  displayName: string | null;
  searchCriteria: string | null;
  preferredLanguage: string;
  excludedDomains: string[];
  includeGovernment: boolean;
  usage?: {
    db: SupabaseClient;
    userId: string;
    scoutId: string;
    runId: string;
    functionName: string;
  };
}

interface RetrievalDiscoveryResult {
  news: BeatHit[];
  gov: BeatHit[];
  jobsAttempted: number;
  jobsErrored: number;
}

async function discoverWithFirecrawl(
  opts: RetrievalDiscoveryOpts,
): Promise<RetrievalDiscoveryResult> {
  const newsDiscovery = await discoverBeatHits({
    scope: opts.scope,
    sourceMode: opts.sourceMode,
    category: "news",
    city: opts.cityName,
    state: opts.stateName,
    country: opts.countryName,
    countryCode: opts.countryCode,
    displayName: opts.displayName,
    criteria: opts.searchCriteria,
    preferredLanguage: opts.preferredLanguage,
    excludedDomains: opts.excludedDomains,
    usage: opts.usage,
  });
  let gov: BeatHit[] = [];
  let govJobsAttempted = 0;
  let govJobsErrored = 0;
  if (opts.includeGovernment) {
    const govDiscovery = await discoverBeatHits({
      scope: "combined",
      sourceMode: opts.sourceMode,
      category: "government",
      city: opts.cityName,
      state: opts.stateName,
      country: opts.countryName,
      countryCode: opts.countryCode,
      displayName: opts.displayName,
      criteria: opts.searchCriteria,
      preferredLanguage: opts.preferredLanguage,
      excludedDomains: opts.excludedDomains,
      usage: opts.usage,
    });
    gov = govDiscovery.hits;
    govJobsAttempted = govDiscovery.jobsAttempted;
    govJobsErrored = govDiscovery.jobsErrored;
  }
  return {
    news: newsDiscovery.hits,
    gov,
    jobsAttempted: newsDiscovery.jobsAttempted + govJobsAttempted,
    jobsErrored: newsDiscovery.jobsErrored + govJobsErrored,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  try {
    requireServiceKey(req);
  } catch (e) {
    return jsonFromError(e);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }
  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      parsed.error.issues.map((i) => i.message).join("; "),
      400,
    );
  }
  const { scout_id, run_id, baseline_only } = parsed.data;

  try {
    return await execute(scout_id, run_id, baseline_only === true);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "scout-beat-execute",
      event: "unhandled",
      scout_id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

async function execute(
  scoutId: string,
  runIdIn?: string,
  baselineOnly = false,
): Promise<Response> {
  const db = getServiceClient();

  // 1. Load scout
  const { data: scout, error: scoutErr } = await db
    .from("scouts")
    .select("*")
    .eq("id", scoutId)
    .maybeSingle();
  if (scoutErr) throw new Error(scoutErr.message);
  if (!scout) throw new NotFoundError("scout");

  // Explicit priority_sources shortcut: user pasted URLs directly. Scrape those
  // unchanged — skips the 8-stage discovery pipeline, keeps behavior predictable.
  const manualSourcesRaw: string[] = Array.isArray(scout.priority_sources)
    ? scout.priority_sources
    : [];
  const manualSources = manualSourcesRaw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .slice(0, MAX_SOURCES);

  // 2. Resolve / create scout_runs row before any charge so missing baselines
  //    fail visibly without spending credits.
  const runId = await resolveRun(db, scout, runIdIn);
  await markRunStage(db, runId, "dispatch");
  await mergeRunMetadata(db, runId, { retrieval: "firecrawl" });
  let chargedCredits = false;

  if (!baselineOnly && !scout.baseline_established_at) {
    const repair = await repairMissingBeatBaseline(db, scoutId);
    if (repair.repaired) {
      logEvent({
        level: "info",
        fn: "scout-beat-execute",
        event: "baseline_backfilled_from_successful_run",
        scout_id: scoutId,
        repaired_at: repair.repairedAt,
      });
      scout.baseline_established_at = repair.repairedAt;
    }
  }

  if (!baselineOnly && !scout.baseline_established_at) {
    const msg =
      "beat scout has no baseline; recreate or reschedule the scout so creation can establish one before Run Now";
    logEvent({
      level: "warn",
      fn: "scout-beat-execute",
      event: "missing_baseline_no_repair_source",
      scout_id: scoutId,
    });
    await markRunError(db, runId, {
      stage: "dispatch",
      errorClass: "no_baseline",
      message: msg,
    });
    throw new ValidationError(msg);
  }

  // 3. Decrement credits before running the discovery pipeline. Baseline-only
  //    creation runs are setup work, not user-triggered monitoring runs.
  if (!baselineOnly) {
    try {
      await markRunStage(db, runId, "credits");
      await decrementOrThrow(db, {
        userId: scout.user_id,
        cost: CREDIT_COSTS.beat,
        scoutId: scout.id,
        scoutType: "beat",
        operation: "beat",
      });
      chargedCredits = true;
    } catch (e) {
      if (e instanceof InsufficientCreditsError) {
        await markRunError(db, runId, {
          stage: "credits",
          errorClass: "quota",
          message: e.message,
          status: "skipped",
        });
        return insufficientCreditsResponse(e.required, e.current);
      }
      const classified = classifyRunError(e, "credits");
      await markRunError(db, runId, {
        stage: classified.stage,
        errorClass: classified.errorClass,
        message: classified.message,
      });
      throw e;
    }
  }

  try {
    await markRunStage(db, runId, "scrape");
    // --- Stage 0: prepare pipeline inputs ---
    const locationObj = parseBeatLocation(scout.location);
    const cityName = locationObj.city ?? null;
    const stateName = locationObj.state ?? null;
    const countryName = locationObj.country ?? null;
    const countryCode = locationObj.countryCode ?? null;
    const displayName = locationObj.displayName ?? null;
    const topic = (scout.topic as string | null)?.trim() ?? null;
    const criteria = typeof scout.criteria === "string"
      ? scout.criteria.trim()
      : "";
    const searchCriteria = criteria || topic;
    const sourceMode: BeatSourceMode =
      (scout.source_mode as string | null) === "niche" ? "niche" : "reliable";
    const excludedDomains = Array.isArray(scout.excluded_domains)
      ? scout.excluded_domains.filter((d: unknown): d is string =>
        typeof d === "string" && d.trim().length > 0
      )
      : [];
    const hasLocation = Boolean(cityName || countryName);
    const hasCriteria = Boolean(searchCriteria);
    const scope: BeatScope = hasCriteria && hasLocation
      ? "combined"
      : hasCriteria
      ? "topic"
      : "location";
    if (scope === "location" && !hasLocation) {
      throw new ValidationError(
        "beat scout requires location, criteria, or topic",
      );
    }
    const preferredLanguage = (scout.preferred_language as string | null) ??
      "en";

    // --- Resolve final source list ---
    // Direct priority URLs bypass discovery only when they are the sole priority
    // source. Mixed source lists run discovery too, while keeping those direct
    // URLs ahead of discovered results before the source cap is applied.
    let finalUrls: string[];
    let newsBeatHits: BeatHit[] = [];
    let govBeatHits: BeatHit[] = [];
    let priorityBeatHits: BeatHit[] = [];
    let retrievalSearchErrored = false;
    let prioritySearchJobsAttempted = 0;
    let prioritySearchJobsErrored = 0;
    const priorityPlan = partitionPrioritySources(manualSources);

    if (
      priorityPlan.directUrls.length > 0 && priorityPlan.domains.length === 0
    ) {
      // Explicit article/page URLs remain an opt-in direct scrape path.
      finalUrls = priorityPlan.directUrls;
    } else {
      const maxDiscoveredSources = DISCOVERY_SOURCE_LIMITS[scope];
      // Full pipeline branch — news + optional parallel government fan-out.
      // Domain-only priority sources are treated as preferred source domains,
      // not as homepage URLs to scrape directly.
      if (priorityPlan.domains.length > 0) {
        const priorityDiscovery = await discoverPriorityDomainHits({
          domains: priorityPlan.domains,
          criteria: searchCriteria,
          location: locationObj,
          excludedDomains,
        });
        priorityBeatHits = priorityDiscovery.hits;
        prioritySearchJobsAttempted = priorityDiscovery.jobsAttempted;
        prioritySearchJobsErrored = priorityDiscovery.jobsErrored;
      }
      const baseDiscoveryOpts = {
        scope,
        sourceMode,
        cityName,
        stateName,
        countryName,
        countryCode,
        displayName,
        searchCriteria,
        preferredLanguage,
        excludedDomains,
        includeGovernment: hasLocation && hasCriteria,
        usage: {
          db,
          userId: scout.user_id as string,
          scoutId,
          runId,
          functionName: "scout-beat-execute",
        },
      };
      const primaryDiscovery = await discoverWithFirecrawl(baseDiscoveryOpts);
      newsBeatHits = primaryDiscovery.news;
      govBeatHits = primaryDiscovery.gov;
      const searchStats = summarizeSearchJobs(
        {
          jobsAttempted: prioritySearchJobsAttempted,
          jobsErrored: prioritySearchJobsErrored,
        },
        primaryDiscovery,
      );
      retrievalSearchErrored = searchStats.allErrored;
      await mergeRunMetadata(db, runId, {
        priority_search_jobs_attempted: prioritySearchJobsAttempted,
        priority_search_jobs_errored: prioritySearchJobsErrored,
        priority_search_hit_count: priorityBeatHits.length,
        search_jobs_attempted: searchStats.jobsAttempted,
        search_jobs_errored: searchStats.jobsErrored,
      });
      finalUrls = [
        ...priorityPlan.directUrls,
        ...priorityBeatHits.map((h) => h.url),
        ...newsBeatHits.map((h) => h.url),
        ...govBeatHits.map((h) => h.url),
      ].filter((u, i, arr) => u && arr.indexOf(u) === i).slice(
        0,
        maxDiscoveredSources,
      );
    }
    const beatHitByUrl = new Map<string, BeatHit>();
    for (const hit of [...priorityBeatHits, ...newsBeatHits, ...govBeatHits]) {
      if (hit.url) beatHitByUrl.set(hit.url, hit);
    }

    if (finalUrls.length === 0 && retrievalSearchErrored && !baselineOnly) {
      // Zero URLs because EVERY search query threw — a provider outage (revoked
      // key, Firecrawl down, 429 storm), not a quiet news day. Recording a no-op
      // success here (as the block below does) would make the two
      // indistinguishable and silently hide a total retrieval failure until the
      // weekly benchmark noticed. Fail the run and refund the pre-charge so it
      // surfaces in run status.
      const msg =
        "beat retrieval failed: every search query errored (provider outage or throttling)";
      logEvent({
        level: "error",
        fn: "scout-beat-execute",
        event: "retrieval_all_queries_failed",
        scout_id: scoutId,
        run_id: runId,
        retrieval: "firecrawl",
      });
      await markRunError(db, runId, {
        stage: "scrape",
        errorClass: "provider",
        message: msg,
      });
      if (chargedCredits) {
        await refundCredits(db, {
          userId: scout.user_id as string,
          cost: CREDIT_COSTS.beat,
          scoutId,
          scoutType: "beat",
          operation: "beat",
        });
      }
      throw new Error(msg);
    }

    if (finalUrls.length === 0) {
      // Empty pipeline outcome (no discovered URLs) — record a no-op success
      // and refund the pre-charge (matches legacy source behaviour).
      if (baselineOnly) {
        const { error: baselineErr } = await db
          .from("scouts")
          .update({ baseline_established_at: new Date().toISOString() })
          .eq("id", scoutId);
        if (baselineErr) throw new Error(baselineErr.message);
      }
      await markRunSuccess(db, runId, {
        unitsCreated: 0,
        unitsMerged: 0,
        criteriaStatus: false,
        notificationStatus: baselineOnly ? "not_applicable" : "skipped",
        sourcesScraped: 0,
        sourcesFailed: 0,
      });
      if (chargedCredits) {
        await refundCredits(db, {
          userId: scout.user_id as string,
          cost: CREDIT_COSTS.beat,
          scoutId,
          scoutType: "beat",
          operation: "beat",
        });
      }
      return jsonOk({
        status: "ok",
        run_id: runId,
        sources_scraped: 0,
        sources_failed: 0,
        articles_count: 0,
        merged_existing_count: 0,
        note: baselineOnly
          ? "beat baseline initialized with zero discovered sources"
          : "beat pipeline produced zero sources for this query",
        baseline_initialized: baselineOnly,
      });
    }

    // --- Stage 2 continuation: bounded full-markdown scrapes ---
    const initialScraped = await mapLimit(
      finalUrls,
      CONCURRENCY,
      (url) =>
        scrape(url, {
          workloadClass: "scout",
          tenantKey: scout.user_id as string,
        }),
    );

    const failures: Array<{ url: string; error: string }> = [];
    const initialByUrl = new Map<string, {
      hit: BeatHit;
      scrape: ScrapeResult;
    }>();
    initialScraped.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const v = r.value;
        if (v.markdown && v.markdown.trim().length > 0) {
          const hit = beatHitByUrl.get(finalUrls[i]) ?? {
            url: finalUrls[i],
            title: v.title,
          };
          initialByUrl.set(finalUrls[i], { hit, scrape: v });
        } else {
          failures.push({ url: finalUrls[i], error: "empty markdown" });
        }
      } else {
        failures.push({
          url: finalUrls[i],
          error: r.reason instanceof Error
            ? r.reason.message
            : String(r.reason),
        });
      }
    });

    // Search snippets can omit the concrete links shown after rendering a news
    // section. Use that first render as a bounded discovery carrier, then
    // replace it with article-page scrapes. Explicit direct URLs remain direct
    // and are never expanded.
    const expandedHits: BeatHit[] = [];
    const expandedSeen = new Set<string>();
    const govDiscoveryUrls = new Set(govBeatHits.map((hit) => hit.url));
    for (const [url, item] of initialByUrl) {
      const isDiscovered = beatHitByUrl.has(url);
      const linked = isDiscovered
        ? renderedArticleCandidates(item.hit, item.scrape)
        : [];
      for (const hit of linked.length > 0 ? linked : [item.hit]) {
        if (expandedSeen.has(hit.url)) continue;
        expandedSeen.add(hit.url);
        expandedHits.push(hit);
        beatHitByUrl.set(hit.url, hit);
        if (govDiscoveryUrls.has(url) && hit.url !== url) {
          govBeatHits.push(hit);
        }
      }
    }
    const effectiveHits = expandedHits.slice(
      0,
      priorityPlan.directUrls.length > 0 && priorityPlan.domains.length === 0
        ? MAX_SOURCES
        : DISCOVERY_SOURCE_LIMITS[scope],
    );
    const followupHits = effectiveHits.filter((hit) =>
      !initialByUrl.has(hit.url)
    );
    const followupScraped = await mapLimit(
      followupHits,
      CONCURRENCY,
      (hit) =>
        scrape(hit.url, {
          workloadClass: "scout",
          tenantKey: scout.user_id as string,
        }),
    );
    const followupByUrl = new Map<string, {
      hit: BeatHit;
      scrape: ScrapeResult;
    }>();
    followupScraped.forEach((r, i) => {
      const hit = followupHits[i];
      if (r.status === "fulfilled") {
        if (r.value.markdown?.trim()) {
          followupByUrl.set(hit.url, { hit, scrape: r.value });
        } else {
          failures.push({ url: hit.url, error: "empty markdown" });
        }
      } else {
        failures.push({
          url: hit.url,
          error: r.reason instanceof Error
            ? r.reason.message
            : String(r.reason),
        });
      }
    });
    const readableScrapes = effectiveHits.flatMap((hit) => {
      const item = initialByUrl.get(hit.url) ?? followupByUrl.get(hit.url);
      return item ? [item] : [];
    });
    const effectiveScrapes = readableScrapes.filter(({ hit, scrape }) =>
      !isKnownStaleBeatDate(
        sourcePublishedDate({ scrape, searchDate: hit.date }),
      )
    );
    const staleSourcesFiltered = readableScrapes.length -
      effectiveScrapes.length;
    const succeeded = effectiveScrapes.map((item) => item.scrape);
    const attemptedScrapeCount = initialScraped.length + followupScraped.length;
    finalUrls = effectiveScrapes.map((item) => item.hit.url);

    // Provider telemetry (audit 2026-07-07): stamp which scraper actually
    // served each URL so beat has the same crawl4ai / anti-bot-fallback
    // visibility as web scouts (it had none before), and the benchmark can
    // assert crawl4ai instead of assuming it.
    const scrapeServed = [...initialScraped, ...followupScraped].reduce(
      (acc, r) => {
        if (r.status === "fulfilled") {
          if (r.value.served_by === "crawl4ai") acc.crawl4ai++;
          else if (r.value.served_by === "firecrawl") acc.firecrawl++;
        }
        return acc;
      },
      { crawl4ai: 0, firecrawl: 0 },
    );
    await mergeRunMetadata(db, runId, {
      scrape_provider: scrapeProvider(),
      scrape_served_crawl4ai: scrapeServed.crawl4ai,
      scrape_served_firecrawl: scrapeServed.firecrawl,
      stale_sources_filtered: staleSourcesFiltered,
    });

    if (succeeded.length === 0) {
      throw new Error(
        `all ${attemptedScrapeCount} sources failed: ${
          failures
            .map((f) => `${f.url} (${f.error})`)
            .slice(0, 3)
            .join("; ")
        }`,
      );
    }

    // Keep a lookup so per-URL gov vs news partitioning survives the scrape step.
    const govUrlSet = new Set(govBeatHits.map((h) => h.url));

    // 5. Persist raw_captures for each successful scrape.
    const rawCaptureIds: string[] = [];
    const rawCaptureHashes: string[] = [];
    await markRunStage(db, runId, "insert_units");
    for (const s of succeeded) {
      const md = s.markdown ?? "";
      const hash = await sha256Hex(md);
      const { data: cap, error: capErr } = await db
        .from("raw_captures")
        .insert({
          user_id: scout.user_id,
          scout_id: scout.id,
          scout_run_id: runId,
          source_url: s.source_url,
          source_domain: safeDomain(s.source_url),
          content_md: md.slice(0, 200_000),
          content_sha256: hash,
          token_count: Math.ceil(md.length / 4),
          captured_at: s.fetched_at,
          expires_at: rawCaptureExpiresAt(),
        })
        .select("id")
        .single();
      if (capErr) throw new Error(capErr.message);
      rawCaptureIds.push(cap.id as string);
      rawCaptureHashes.push(hash);
    }

    // 6 + 7. Per-article extraction with forced target language.
    //
    // We extract 1-3 units per successfully scraped source (prod shape) and
    // attribute each unit to its own source URL. Fixes three audit regressions:
    //   - language: system prompt forces preferred_language, article-by-article
    //   - source_diversity: each unit carries its real source, not primary's
    //   - undated_ratio: Firecrawl metadata publishedTime feeds occurred_at
    //     as a fallback when the LLM can't extract one
    let insertedCount = 0;
    let mergedExistingCount = 0;
    let abstainedCount = 0;
    let extractionFailureCount = 0;
    let extractionEmptyCount = 0;
    let extractionFilteredCount = 0;
    let extractedUnitCount = 0;
    let embedFailureCount = 0;
    let unitInsertFailureCount = 0;
    const insertedStatements: string[] = [];
    const runUnits: Array<{ statement: string; embedding: number[] }> = [];
    const baselineUnitIds = new Set<string>();
    const surfacedArticles = new Map<
      string,
      Article & { category: "news" | "government" }
    >();
    const factCheckConfig = loadFactCheckConfig();

    await markRunStage(db, runId, "extract");
    for (let i = 0; i < succeeded.length; i++) {
      const src = succeeded[i];
      const captureId = rawCaptureIds[i];
      const searchHit = beatHitByUrl.get(src.requested_url ?? src.source_url) ??
        beatHitByUrl.get(src.source_url);
      const sourceTitle = src.title?.trim() || searchHit?.title?.trim() || null;
      const sourceDate = sourcePublishedDate({
        scrape: src,
        searchDate: searchHit?.date,
      });
      const extractionConfig = scope === "location"
        // Keep location digests concise without truncating article context.
        ? { maxUnits: 2, contentLimit: 3000 }
        : { maxUnits: 3, contentLimit: 3000 };

      let extracted;
      try {
        extracted = await extractAtomicUnits({
          title: sourceTitle,
          content: src.markdown ?? "",
          sourceUrl: src.source_url,
          publishedDate: sourceDate,
          language: preferredLanguage,
          criteria: searchCriteria,
          maxUnits: extractionConfig.maxUnits,
          contentLimit: extractionConfig.contentLimit,
          anchorToTitle: true,
          usage: {
            db,
            userId: scout.user_id as string,
            scoutId,
            runId,
            functionName: "scout-beat-execute",
            operation: "beat_extract_article",
          },
        });
      } catch (e) {
        extractionFailureCount += 1;
        logEvent({
          level: "warn",
          fn: "scout-beat-execute",
          event: "extract_failed",
          scout_id: scoutId,
          source_url: src.source_url,
          msg: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      extractedUnitCount += extracted.diagnostics.returned_units;
      if (extracted.diagnostics.outcome === "failed") {
        extractionFailureCount += 1;
      } else if (extracted.diagnostics.outcome === "filtered") {
        extractionFilteredCount += 1;
      } else if (extracted.diagnostics.outcome === "empty") {
        extractionEmptyCount += 1;
      }

      let embeddings: number[][];
      try {
        embeddings = await embedBatch(extracted.units.map((unit) => ({
          text: unit.statement,
          taskType: "RETRIEVAL_DOCUMENT",
          title: sourceTitle,
        })));
      } catch (e) {
        embedFailureCount += extracted.units.length;
        logEvent({
          level: "warn",
          fn: "scout-beat-execute",
          event: "embed_batch_failed",
          scout_id: scoutId,
          msg: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      for (const [unitIndex, u] of extracted.units.entries()) {
        const embedding = embeddings[unitIndex];

        // Within-run paraphrase guard first — avoids an RPC round-trip for
        // pairs that would both insert otherwise.
        const candidate = { statement: u.statement, embedding };
        if (isWithinRunDuplicateWithGuards(candidate, runUnits)) continue;
        runUnits.push(candidate);

        // Prefer source metadata/search dates over extracted dates so a future
        // year mentioned in the story cannot become the publication date.
        const occurredAt = preferSourcePublishedDate(
          sourceDate,
          u.occurred_at,
        );
        const unitType = u.type as CanonicalUnitType;

        // Fact-check via Abstain-R1 (no-op when endpoint not configured).
        let fcResult: FactCheckResult = {
          fact_checked: false,
          confidence_score: null,
          abstained: false,
          abstain_reason: null,
        };
        if (isFactCheckEnabled(factCheckConfig)) {
          try {
            fcResult = await factCheckUnit(u.statement, factCheckConfig, {
              sourceDomain: deriveSourceDomain(src.source_url),
              occurredAt,
            });
            if (fcResult.abstained) abstainedCount += 1;
          } catch (e) {
            logEvent({
              level: "warn",
              fn: "scout-beat-execute",
              event: "fact_check_failed",
              scout_id: scoutId,
              msg: e instanceof Error ? e.message : String(e),
            });
          }
        }

        try {
          await markRunStage(db, runId, "insert_units");
          const result = await upsertCanonicalUnit(db, {
            userId: scout.user_id as string,
            statement: u.statement,
            unitType,
            entities: u.entities ?? [],
            embedding,
            embeddingModel: EMBEDDING_MODEL_TAG,
            sourceUrl: src.source_url,
            sourceDomain: deriveSourceDomain(src.source_url),
            sourceTitle,
            contextExcerpt: u.context_excerpt ?? null,
            occurredAt,
            extractedAt: new Date().toISOString(),
            sourceType: "scout",
            contentSha256: rawCaptureHashes[i] ?? null,
            scoutId: scout.id as string,
            scoutType: "beat",
            scoutRunId: runId,
            projectId: (scout.project_id as string | null) ?? null,
            rawCaptureId: captureId,
            metadata: {
              category: govUrlSet.has(src.source_url) ? "government" : "news",
              ...(baselineOnly ? { baseline: true } : {}),
            },
            factChecked: fcResult.fact_checked,
            confidenceScore: fcResult.confidence_score,
            abstained: fcResult.abstained,
            abstainReason: fcResult.abstain_reason,
          });

          if (result.createdCanonical) {
            insertedCount += 1;
            if (baselineOnly) baselineUnitIds.add(result.unitId);
            if (!surfacedArticles.has(src.source_url)) {
              surfacedArticles.set(src.source_url, {
                title: sourceTitle ?? src.source_url,
                url: src.source_url,
                summary: u.context_excerpt ?? u.statement,
                source: safeDomain(src.source_url) ?? "",
                category: govUrlSet.has(src.source_url) ? "government" : "news",
              });
            }
            if (insertedStatements.length < 10) {
              insertedStatements.push(u.statement);
            }
          } else if (result.mergedExisting && result.occurrenceCreated) {
            mergedExistingCount += 1;
          }
        } catch (e) {
          unitInsertFailureCount += 1;
          logEvent({
            level: "warn",
            fn: "scout-beat-execute",
            event: "unit_insert_failed",
            scout_id: scoutId,
            source_url: src.source_url,
            msg: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
      }
    }

    await mergeRunMetadata(db, runId, {
      unit_pipeline: {
        sources_scraped: succeeded.length,
        sources_failed: failures.length,
        extraction_failed_sources: extractionFailureCount,
        extraction_empty_sources: extractionEmptyCount,
        extraction_filtered_sources: extractionFilteredCount,
        extracted_units: extractedUnitCount,
        embedding_failures: embedFailureCount,
        insert_failures: unitInsertFailureCount,
        units_created: insertedCount,
        units_merged: mergedExistingCount,
      },
    });

    const noSurfaceReason = insertedCount === 0 && mergedExistingCount === 0
      ? "No usable information units were extracted from successfully scraped sources."
      : null;
    if (
      noSurfaceReason &&
      (extractionFailureCount > 0 || embedFailureCount > 0 ||
        unitInsertFailureCount > 0)
    ) {
      throw new Error(
        [
          "unit pipeline failed before surfacing units",
          extractionFailureCount > 0
            ? `extract failed=${extractionFailureCount}`
            : "",
          embedFailureCount > 0 ? `embed failed=${embedFailureCount}` : "",
          unitInsertFailureCount > 0
            ? `unit insert failed=${unitInsertFailureCount}`
            : "",
        ].filter(Boolean).join("; "),
      );
    }
    if (noSurfaceReason && chargedCredits) {
      await refundCredits(db, {
        userId: scout.user_id as string,
        cost: CREDIT_COSTS.beat,
        scoutId,
        scoutType: "beat",
        operation: "beat",
      });
    }

    if (baselineOnly) {
      if (baselineUnitIds.size > 0) {
        const { error: hideErr } = await db
          .from("information_units")
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by: scout.user_id,
            deletion_reason: "baseline",
          })
          .in("id", [...baselineUnitIds]);
        if (hideErr) throw new Error(hideErr.message);
      }
      const { error: baselineErr } = await db
        .from("scouts")
        .update({ baseline_established_at: new Date().toISOString() })
        .eq("id", scoutId);
      if (baselineErr) throw new Error(baselineErr.message);
    }

    // 9. Mark run success + reset failures.
    const willNotify = !baselineOnly && insertedCount > 0 &&
      insertedStatements.length > 0;
    await markRunSuccess(db, runId, {
      unitsCreated: baselineOnly ? 0 : insertedCount,
      unitsMerged: baselineOnly ? 0 : mergedExistingCount,
      criteriaStatus: baselineOnly ? false : !noSurfaceReason,
      notificationStatus: baselineOnly
        ? "not_applicable"
        : willNotify
        ? "pending"
        : "skipped",
      errorMessage: baselineOnly ? null : noSurfaceReason,
      sourcesScraped: succeeded.length,
      sourcesFailed: failures.length,
    });
    const { error: resetErr } = await db.rpc("reset_scout_failures", {
      p_scout_id: scoutId,
    });
    if (resetErr) {
      logEvent({
        level: "warn",
        fn: "scout-beat-execute",
        event: "reset_failures_failed",
        scout_id: scoutId,
        msg: resetErr.message,
      });
    }

    logEvent({
      level: "info",
      fn: "scout-beat-execute",
      event: "success",
      scout_id: scoutId,
      run_id: runId,
      sources_scraped: succeeded.length,
      articles_count: baselineOnly ? 0 : insertedCount,
      merged_existing_count: baselineOnly ? 0 : mergedExistingCount,
      ...(abstainedCount > 0 ? { abstained_count: abstainedCount } : {}),
      ...(baselineOnly ? { baseline_only: true } : {}),
    });

    // Notify user when new, non-duplicate units landed. Build separate article
    // cards for news vs government and deterministic extractive digest text for
    // each section.
    if (willNotify) {
      try {
        const newsArticleRecords = [...surfacedArticles.values()]
          .filter((article) => article.category === "news")
          .slice(0, 5);
        const govArticleRecords = [...surfacedArticles.values()]
          .filter((article) => article.category === "government")
          .slice(0, 5);
        const newsArticles: Article[] = newsArticleRecords.map((
          { category: _category, ...article },
        ) => article);
        const govArticles: Article[] = govArticleRecords.map((
          { category: _category, ...article },
        ) => article);

        // Deterministic extractive digest. Every summary line is composed from
        // the same article records rendered below, so it cannot cite discarded
        // URLs or introduce a separately-generated location claim.
        const emailLang = (preferredLanguage ?? "en").toLowerCase();
        const newsDigestArticles = newsArticleRecords.map(toDigestArticle);
        const govDigestArticles = govArticleRecords.map(toDigestArticle);
        const summary = formatBeatDigest(newsDigestArticles, {
          language: emailLang,
          maxBullets: 5,
        });
        const govSummary = formatBeatDigest(govDigestArticles, {
          language: emailLang,
          maxBullets: 5,
        });
        const primaryDigestArticles = newsDigestArticles.length > 0
          ? newsDigestArticles
          : govDigestArticles;
        const grounded = verifyPlaceNamesGrounded(
          [summary, govSummary].filter(Boolean).join("\n"),
          [...newsDigestArticles, ...govDigestArticles],
          cityName,
        );
        if (!grounded.ok) {
          throw new Error(
            `beat digest grounding failed: urls=${
              grounded.offendingUrls.join(",") || "none"
            } tokens=${grounded.offendingTokens.join(",") || "none"}`,
          );
        }

        const locationLabel = extractLocationLabel(scout.location);
        await markNotificationAttempted(db, runId).catch((markErr) =>
          logEvent({
            level: "warn",
            fn: "scout-beat-execute",
            event: "notify_status_update_failed",
            scout_id: scoutId,
            run_id: runId,
            msg: markErr instanceof Error ? markErr.message : String(markErr),
          })
        );
        const notification = await sendBeatAlert(db, {
          userId: scout.user_id as string,
          scoutId: scout.id as string,
          runId,
          scoutName: (scout.name as string | null) ?? "Beat Scout",
          location: locationLabel,
          topic,
          summary: summary || formatBeatDigest(primaryDigestArticles, {
            language: emailLang,
            maxBullets: 5,
          }) ||
            insertedStatements.slice(0, 5).map((s) => `- ${s}`).join("\n"),
          articles: newsArticles.length > 0 ? newsArticles : govArticles,
          govArticles: govArticles.length > 0 ? govArticles : undefined,
          govSummary: govSummary || undefined,
        });
        await markNotificationResult(
          db,
          runId,
          notification.ok
            ? "sent"
            : notification.reason === "missing_email"
            ? "skipped"
            : "failed",
          notification.ok ? { providerId: notification.providerId ?? null } : {
            message: notification.error ?? notification.reason ??
              "notification not sent",
            reason: notification.reason ?? "unknown",
          },
        ).catch((markErr) =>
          logEvent({
            level: "warn",
            fn: "scout-beat-execute",
            event: "notify_status_update_failed",
            scout_id: scoutId,
            run_id: runId,
            msg: markErr instanceof Error ? markErr.message : String(markErr),
          })
        );
      } catch (e) {
        await markNotificationResult(
          db,
          runId,
          "failed",
          e instanceof Error ? e.message : String(e),
        ).catch((markErr) =>
          logEvent({
            level: "warn",
            fn: "scout-beat-execute",
            event: "notify_status_update_failed",
            scout_id: scoutId,
            run_id: runId,
            msg: markErr instanceof Error ? markErr.message : String(markErr),
          })
        );
        logEvent({
          level: "warn",
          fn: "scout-beat-execute",
          event: "notify_failed",
          scout_id: scoutId,
          run_id: runId,
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return jsonOk({
      status: "ok",
      run_id: runId,
      sources_scraped: succeeded.length,
      sources_failed: failures.length,
      articles_count: baselineOnly ? 0 : insertedCount,
      merged_existing_count: baselineOnly ? 0 : mergedExistingCount,
      no_surface_reason: baselineOnly ? null : noSurfaceReason,
      baseline_initialized: baselineOnly,
    });
  } catch (e) {
    const classified = classifyRunError(e, "finalize");
    await markRunError(db, runId, {
      stage: classified.stage,
      errorClass: classified.errorClass,
      message: classified.message,
    });

    if (!baselineOnly && shouldIncrementScoutFailure(classified.errorClass)) {
      await incrementAndMaybeNotify(db, {
        scoutId,
        userId: scout.user_id as string,
        scoutName: (scout.name as string | null) ?? "Beat Scout",
        scoutType: "beat",
        language: scout.preferred_language as string | null,
      });
    }
    if (chargedCredits) {
      // Refund the 7-credit pre-charge — the run produced no billable output.
      await refundCredits(db, {
        userId: scout.user_id as string,
        cost: CREDIT_COSTS.beat,
        scoutId,
        scoutType: "beat",
        operation: "beat",
      });
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------

async function resolveRun(
  db: SupabaseClient,
  scout: Record<string, unknown>,
  runIdIn: string | undefined,
): Promise<string> {
  if (runIdIn) {
    const { data, error } = await db
      .from("scout_runs")
      .select("id")
      .eq("id", runIdIn)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.id) {
      await db
        .from("scout_runs")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", runIdIn);
      return runIdIn;
    }
    // fall through: invalid run_id, create a new row
  }
  const { data, error } = await db
    .from("scout_runs")
    .insert({
      scout_id: scout.id as string,
      user_id: scout.user_id as string,
      status: "running",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/**
 * Run `fn` against `items` with at most `limit` concurrent in-flight tasks.
 * Returns PromiseSettledResult<R>[] in the same order as `items`.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const nWorkers = Math.min(limit, items.length);
  for (let w = 0; w < nWorkers; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          try {
            const value = await fn(items[idx]);
            results[idx] = { status: "fulfilled", value };
          } catch (reason) {
            results[idx] = { status: "rejected", reason };
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

function safeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function toDigestArticle(
  article: Article & { category: "news" | "government" },
): DigestArticle {
  const url = article.url ?? "";
  return {
    title: article.title || url || "Untitled",
    url,
    excerpt: article.summary || article.title || "",
    domain: article.source || safeDomain(url) || "source",
    category: article.category,
  };
}

function extractLocationLabel(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v || null;
  if (typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const candidates = [rec.displayName, rec.display_name, rec.label, rec.city];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c;
    }
  }
  return null;
}

// normalizeDate moved to ../_shared/date_utils.ts (imported at the top).
