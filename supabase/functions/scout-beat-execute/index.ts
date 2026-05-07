/**
 * scout-beat-execute Edge Function — Beat Scout (type='beat') runner.
 *
 * Scrapes up to 20 priority sources in parallel (concurrency 5), aggregates
 * markdown, persists raw_captures per source, and extracts atomic information
 * units via Gemini structured output. Used for Beat Scouts (topic/criteria
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
 *   - 500/502 on all firecrawl/gemini failures; failed runs mark scout_runs
 *     status='error' and call increment_scout_failures (auto-pause at 3).
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient, SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { NotFoundError, ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { normalizeDate } from "../_shared/date_utils.ts";
import {
  firecrawlScrape,
  firecrawlSearch,
  ScrapeResult,
} from "../_shared/firecrawl.ts";
import { isWithinRunDuplicate } from "../_shared/dedup.ts";
import { EMBEDDING_MODEL_TAG, geminiEmbed } from "../_shared/gemini.ts";
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
  beatCandidateRejectReason,
  discoverBeatHits,
  generateBeatSummary,
} from "../_shared/beat_pipeline.ts";
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

const InputSchema = z.object({
  scout_id: z.string().uuid(),
  run_id: z.string().uuid().optional(),
  baseline_only: z.boolean().optional(),
});

const MAX_SOURCES = 20;
const CONCURRENCY = 5;
const RAW_CAPTURE_TTL_DAYS = 30;
const DISCOVERY_SOURCE_LIMITS: Record<BeatScope, number> = {
  location: 4,
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

async function discoverPriorityDomainHits(opts: {
  domains: string[];
  criteria: string | null;
  topic: string | null;
  locationLabel: string | null;
  preferredLanguage: string;
  countryCode: string | null;
  excludedDomains: string[];
}): Promise<BeatHit[]> {
  if (opts.domains.length === 0) return [];
  const subject = compactSearchPart(opts.topic || opts.criteria || "news", 160);
  const location = compactSearchPart(opts.locationLabel ?? "", 80);
  const jobs = opts.domains.flatMap((domain) => {
    const main = [subject, location].filter(Boolean).join(" ");
    const fallback = [location, "news"].filter(Boolean).join(" ") ||
      "recent news";
    return uniqueStrings([
      `site:${domain} ${main || fallback}`,
      `site:${domain} ${fallback}`,
    ]).map((query) => ({ domain, query }));
  });
  const results = await mapLimit(jobs, 4, async (job) => {
    const hits = await firecrawlSearch(job.query, {
      limit: 5,
      lang: opts.preferredLanguage,
      location: opts.locationLabel ?? undefined,
      country: opts.countryCode ?? undefined,
      sources: ["web"],
      ignoreInvalidURLs: true,
      excludeDomains: opts.excludedDomains,
    });
    return hits
      .filter((hit) => urlMatchesDomain(hit.url, job.domain))
      .filter((hit) => beatCandidateRejectReason(hit) === null)
      .map((hit) => ({
        ...hit,
        date: hit.date ?? null,
        _pass: "news" as const,
        query: job.query,
      }));
  });
  const hits: BeatHit[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const hit of result.value) {
      if (!hit.url || seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
    }
  }
  return hits;
}

function compactSearchPart(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function urlMatchesDomain(rawUrl: string | null | undefined, domain: string): boolean {
  const host = safeDomain(rawUrl)?.replace(/^www\./i, "").toLowerCase();
  return Boolean(host && (host === domain || host.endsWith(`.${domain}`)));
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
    await db
      .from("scout_runs")
      .update({
        status: "error",
        error_message: msg,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    throw new ValidationError(msg);
  }

  // 3. Decrement credits before running the discovery pipeline. Baseline-only
  //    creation runs are setup work, not user-triggered monitoring runs.
  if (!baselineOnly) {
    try {
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
        return insufficientCreditsResponse(e.required, e.current);
      }
      throw e;
    }
  }

  try {
    // --- Stage 0: prepare pipeline inputs ---
    const locationObj = parseBeatLocation(scout.location);
    const cityName = locationObj.city ?? null;
    const countryName = locationObj.country ?? null;
    const countryCode = locationObj.countryCode ?? null;
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
    // Two branches, chosen by the user's setup:
    //  (A) priority_sources non-empty → direct scrape (legacy opt-in path)
    //  (B) empty → full 8-stage beat pipeline (query gen → search → dedup → AI filter)
    let finalUrls: string[];
    let newsBeatHits: BeatHit[] = [];
    let govBeatHits: BeatHit[] = [];
    let priorityBeatHits: BeatHit[] = [];
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
        priorityBeatHits = await discoverPriorityDomainHits({
          domains: priorityPlan.domains,
          criteria: searchCriteria,
          topic,
          locationLabel: cityName || extractLocationLabel(scout.location) ||
            countryName,
          preferredLanguage,
          countryCode,
          excludedDomains,
        });
      }
      newsBeatHits = (await discoverBeatHits({
        scope,
        sourceMode,
        category: "news",
        city: cityName,
        country: countryName,
        countryCode,
        criteria: searchCriteria,
        preferredLanguage,
        excludedDomains,
      })).hits;
      if (hasLocation && hasCriteria) {
        govBeatHits = (await discoverBeatHits({
          scope: "combined",
          sourceMode,
          category: "government",
          city: cityName,
          country: countryName,
          countryCode,
          criteria: searchCriteria,
          preferredLanguage,
          excludedDomains,
        })).hits;
      }
      finalUrls = [
        ...priorityBeatHits.map((h) => h.url),
        ...newsBeatHits.map((h) => h.url),
        ...govBeatHits.map((h) => h.url),
        ...priorityPlan.directUrls,
      ].filter((u, i, arr) => u && arr.indexOf(u) === i).slice(
        0,
        maxDiscoveredSources,
      );
    }
    const beatHitByUrl = new Map<string, BeatHit>();
    for (const hit of [...priorityBeatHits, ...newsBeatHits, ...govBeatHits]) {
      if (hit.url) beatHitByUrl.set(hit.url, hit);
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
      await db
        .from("scout_runs")
        .update({
          status: "success",
          scraper_status: true,
          criteria_status: false,
          articles_count: 0,
          merged_existing_count: 0,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runId);
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

    // --- Stage 2 continuation: parallel full-markdown scrapes (concurrency 5) ---
    const scraped = await mapLimit(
      finalUrls,
      CONCURRENCY,
      (url) => firecrawlScrape(url),
    );

    const succeeded: ScrapeResult[] = [];
    const failures: Array<{ url: string; error: string }> = [];
    scraped.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const v = r.value;
        if (v.markdown && v.markdown.trim().length > 0) {
          succeeded.push(v);
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

    if (succeeded.length === 0) {
      throw new Error(
        `all ${finalUrls.length} sources failed: ${
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
    const insertedStatements: string[] = [];
    const newsStatements: string[] = [];
    const govStatements: string[] = [];
    const runEmbeddings: number[][] = [];
    const baselineUnitIds = new Set<string>();
    const surfacedArticles = new Map<
      string,
      Article & { category: "news" | "government" }
    >();
    const factCheckConfig = loadFactCheckConfig();

    for (let i = 0; i < succeeded.length; i++) {
      const src = succeeded[i];
      const captureId = rawCaptureIds[i];
      const searchHit = beatHitByUrl.get(src.requested_url ?? src.source_url) ??
        beatHitByUrl.get(src.source_url);
      const sourceDate = sourcePublishedDate({
        scrape: src,
        searchDate: searchHit?.date,
      });
      const extractionConfig = scope === "location"
        ? { maxUnits: 2, contentLimit: 2200 }
        : { maxUnits: 3, contentLimit: 3000 };

      let extracted;
      try {
        extracted = await extractAtomicUnits({
          title: src.title ?? null,
          content: src.markdown ?? "",
          sourceUrl: src.source_url,
          publishedDate: sourceDate,
          language: preferredLanguage,
          criteria: searchCriteria,
          maxUnits: extractionConfig.maxUnits,
          contentLimit: extractionConfig.contentLimit,
        });
      } catch (e) {
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

      for (const u of extracted.units) {
        let embedding: number[];
        try {
          embedding = await geminiEmbed(u.statement, "RETRIEVAL_DOCUMENT", {
            title: src.title ?? null,
          });
        } catch (e) {
          logEvent({
            level: "warn",
            fn: "scout-beat-execute",
            event: "embed_failed",
            scout_id: scoutId,
            msg: e instanceof Error ? e.message : String(e),
          });
          continue;
        }

        // Within-run paraphrase guard first — avoids an RPC round-trip for
        // pairs that would both insert otherwise.
        if (isWithinRunDuplicate(embedding, runEmbeddings)) continue;
        runEmbeddings.push(embedding);

        // occurred_at priority: LLM-extracted → Firecrawl scrape metadata →
        // Firecrawl search date → null.
        const occurredAt = normalizeDate(u.occurred_at) ?? sourceDate;
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
          const result = await upsertCanonicalUnit(db, {
            userId: scout.user_id as string,
            statement: u.statement,
            unitType,
            entities: u.entities ?? [],
            embedding,
            embeddingModel: EMBEDDING_MODEL_TAG,
            sourceUrl: src.source_url,
            sourceDomain: deriveSourceDomain(src.source_url),
            sourceTitle: src.title ?? null,
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
                title: src.title ?? src.source_url,
                url: src.source_url,
                summary: "",
                source: safeDomain(src.source_url) ?? "",
                category: govUrlSet.has(src.source_url) ? "government" : "news",
              });
            }
            if (insertedStatements.length < 10) {
              insertedStatements.push(u.statement);
            }
            if (govUrlSet.has(src.source_url)) {
              if (govStatements.length < 5) govStatements.push(u.statement);
            } else {
              if (newsStatements.length < 5) newsStatements.push(u.statement);
            }
          } else if (result.mergedExisting && result.occurrenceCreated) {
            mergedExistingCount += 1;
          }
        } catch (e) {
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

    const noSurfaceReason = insertedCount === 0 && mergedExistingCount === 0
      ? "No usable information units were extracted from successfully scraped sources."
      : null;
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
    await db
      .from("scout_runs")
      .update({
        status: "success",
        scraper_status: true,
        criteria_status: baselineOnly ? false : !noSurfaceReason,
        articles_count: baselineOnly ? 0 : insertedCount,
        merged_existing_count: baselineOnly ? 0 : mergedExistingCount,
        error_message: baselineOnly ? null : noSurfaceReason,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);

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
    // cards for news vs government (legacy behaviour), with LLM-composed
    // summaries per section rather than raw statement bullets.
    if (!baselineOnly && insertedCount > 0 && insertedStatements.length > 0) {
      try {
        const newsArticles: Article[] = [...surfacedArticles.values()]
          .filter((article) => article.category === "news")
          .slice(0, 5)
          .map(({ category: _category, ...article }) => article);
        const govArticles: Article[] = [...surfacedArticles.values()]
          .filter((article) => article.category === "government")
          .slice(0, 5)
          .map(({ category: _category, ...article }) => article);

        // Prefer LLM-composed summaries when pipeline produced hits; fall back
        // to bulleted statement list for the manual-priority-sources path.
        const emailLang = (preferredLanguage ?? "en").toLowerCase();
        const surfacedUrls = new Set(surfacedArticles.keys());
        const successfulNewsHits = newsBeatHits.filter((h) =>
          surfacedUrls.has(h.url)
        );
        const successfulGovHits = govBeatHits.filter((h) =>
          surfacedUrls.has(h.url)
        );
        const summary = successfulNewsHits.length > 0
          ? await generateBeatSummary(successfulNewsHits, {
            city: cityName,
            language: emailLang,
            category: "news",
          })
          : newsStatements.slice(0, 5).map((s) => `- ${s}`).join("\n");
        const govSummary = successfulGovHits.length > 0
          ? await generateBeatSummary(successfulGovHits, {
            city: cityName,
            language: emailLang,
            category: "government",
          })
          : govStatements.slice(0, 5).map((s) => `- ${s}`).join("\n");

        const locationLabel = extractLocationLabel(scout.location);
        await sendBeatAlert(db, {
          userId: scout.user_id as string,
          scoutId: scout.id as string,
          runId,
          scoutName: (scout.name as string | null) ?? "Beat Scout",
          location: locationLabel,
          topic,
          summary: summary ||
            insertedStatements.slice(0, 5).map((s) => `- ${s}`).join("\n"),
          articles: newsArticles.length > 0 ? newsArticles : govArticles,
          govArticles: govArticles.length > 0 ? govArticles : undefined,
          govSummary: govSummary || undefined,
        });
      } catch (e) {
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
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .from("scout_runs")
      .update({
        status: "error",
        error_message: msg.slice(0, 2000),
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);

    if (!baselineOnly) {
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
