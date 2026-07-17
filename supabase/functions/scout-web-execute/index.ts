/**
 * scout-web-execute Edge Function — synchronous Page Scout pipeline.
 *
 * Called internally by execute-scout. Must complete within ~50s. Flow:
 *   1. Load scout.
 *   2. Create (or reuse) a scout_runs row with status='running'.
 *   3. Scrape the page and compare either the local canonical hash baseline
 *      or, for legacy scouts only, Firecrawl changeTracking.
 *   4. If change_status === "same": mark run success, reset failures, return.
 *   5. Else: store raw_capture, extract units, dedup each unit through
 *      canonical unit upsert, insert non-dupes, mark run success.
 *   5b. Phase B: if index extraction flags isListingPage, extract same-host
 *       subpage links, scrape each sequentially, extract units per subpage.
 *       Single-hop only — nested listings are skipped. CAP = 10.
 *   6. On any throw: mark run error, increment_scout_failures, surface error.
 *
 * Auth: shared service auth (X-Service-Key, with service-role bearer fallback
 *       for operator tooling).
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient, SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import {
  ApiError,
  AuthError,
  NotFoundError,
  ValidationError,
} from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { normalizeDate } from "../_shared/date_utils.ts";
import { firecrawlScrape } from "../_shared/scrape_firecrawl.ts";
import {
  scrapePrimaryPageResilient,
  scrapeProvider,
} from "../_shared/scrape.ts";
import { hashChangeStatusForUrl } from "../_shared/canonical_baseline.ts";
import type {
  ChangeTrackingResult,
  PrimaryPageScrapeResult,
} from "../_shared/scrape_types.ts";
import {
  type CaptureStoreContext,
  performArchiveCapture,
  resolveArchiveGate,
  runSnapshotInBackground,
  snapshotDiagnostics,
} from "../_shared/snapshot_capture.ts";
import { applyTrustLayer, scoutWaybackEnabled } from "../_shared/trust.ts";
import { embedBatch, EMBEDDING_MODEL_TAG } from "../_shared/embedding.ts";
import {
  extractAtomicUnits,
  type ExtractedUnit,
  sourcePublishedDate,
} from "../_shared/atomic_extract.ts";
import {
  type FactCheckResult,
  factCheckUnit,
  isFactCheckEnabled,
  loadFactCheckConfig,
} from "../_shared/fact_check.ts";
import { isWithinRunDuplicateWithGuards } from "../_shared/dedup.ts";
import { shouldSendPageScoutAlert } from "../_shared/page_scout_notifications.ts";
import {
  filterSubpageUrls,
  hasDeterministicListingSignal,
  isLikelyArticleUrl,
} from "../_shared/subpage-filter.ts";
import {
  type CanonicalUnitType,
  deriveSourceDomain,
  normalizeSourceUrl,
  sha256Hex,
  upsertCanonicalUnit,
} from "../_shared/unit_dedup.ts";
import {
  WEB_CANONICALIZER_VERSION,
  WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
  webCanonicalHash,
  webCanonicalHashEnabled,
} from "../_shared/web_content_canonical.ts";
import {
  CREDIT_COSTS,
  decrementOrThrow,
  InsufficientCreditsError,
  insufficientCreditsResponse,
  refundCredits,
} from "../_shared/credits.ts";
import { sendPageScoutAlert } from "../_shared/notifications.ts";
import { incrementAndMaybeNotify } from "../_shared/scout_failures.ts";
import {
  classifyRunError,
  markNotificationAttempted,
  markNotificationResult,
  markRunError,
  markRunStage,
  markRunSuccess,
  shouldIncrementScoutFailure,
} from "../_shared/run_lifecycle.ts";

const SUBPAGE_FETCH_CAP = 10;
const FIRECRAWL_STAGGER_MS = 2000;
const PRIMARY_SCRAPE_TIMEOUT_MS = 25_000;
const PRIMARY_SCRAPE_ABORT_AFTER_MS = 30_000;
const PRIMARY_EXTRACTION_TIMEOUT_MS = 20_000;
const PHASE_B_TOTAL_BUDGET_MS = 35_000;
const SUBPAGE_SCRAPE_TIMEOUT_MS = 12_000;
const SUBPAGE_SCRAPE_ABORT_AFTER_MS = 15_000;
const SUBPAGE_EXTRACTION_TIMEOUT_MS = 12_000;
const RAW_CAPTURE_TTL_DAYS = 30;

const InputSchema = z.object({
  scout_id: z.string().uuid(),
  run_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

const PROMPT_CONTENT_MAX = 12_000;

function rawCaptureExpiresAt(days = RAW_CAPTURE_TTL_DAYS): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
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
    return jsonFromError(e instanceof AuthError ? e : new AuthError());
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
      new ValidationError(parsed.error.issues.map((i) => i.message).join("; ")),
    );
  }

  const svc = getServiceClient();
  const { scout_id } = parsed.data;
  let { run_id } = parsed.data;

  // 1. Load scout.
  const { data: scout, error: scoutErr } = await svc
    .from("scouts")
    .select(
      "id, user_id, type, name, url, criteria, project_id, is_active, provider, preferred_language, baseline_established_at, archive_enabled, wayback_enabled",
    )
    .eq("id", scout_id)
    .maybeSingle();
  if (scoutErr) return jsonFromError(new Error(scoutErr.message));
  if (!scout) return jsonFromError(new NotFoundError("scout"));
  if (!scout.url) {
    return jsonFromError(new ValidationError("scout has no url"));
  }

  // 2. Ensure scout_runs row exists.
  if (!run_id) {
    const { data: runRow, error: runErr } = await svc
      .from("scout_runs")
      .insert({
        scout_id: scout.id,
        user_id: scout.user_id,
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (runErr) return jsonFromError(new Error(runErr.message));
    run_id = runRow.id as string;
  }
  const runId = run_id as string;
  await markRunStage(svc, runId, "dispatch");

  let chargedCredits = false;

  try {
    if (!scout.baseline_established_at) {
      const msg =
        "page scout has no baseline; recreate or reschedule the scout so creation can establish one before Run Now";
      throw new ValidationError(msg);
    }

    // 3. Decrement credits before any billable work.
    try {
      await markRunStage(svc, runId, "credits");
      await decrementOrThrow(svc, {
        userId: scout.user_id,
        cost: CREDIT_COSTS.website_extraction,
        scoutId: scout.id,
        scoutType: "web",
        operation: "website_extraction",
      });
      chargedCredits = true;
    } catch (e) {
      if (e instanceof InsufficientCreditsError) {
        await markRunError(svc, runId, {
          stage: "credits",
          errorClass: "quota",
          message: e.message,
          status: "skipped",
        });
        return insufficientCreditsResponse(e.required, e.current);
      }
      const classified = classifyRunError(e, "credits");
      await markRunError(svc, runId, {
        stage: classified.stage,
        errorClass: classified.errorClass,
        message: classified.message,
      });
      return jsonFromError(e);
    }

    const result = await runPipeline(svc, scout, runId);
    const willNotify = shouldSendPageScoutAlert(result);

    await markRunSuccess(svc, runId, {
      unitsCreated: result.articles_count,
      unitsMerged: result.merged_existing_count,
      criteriaStatus: result.criteria_ran,
      notificationStatus: willNotify ? "pending" : "skipped",
      sourcesScraped: 1,
      sourcesFailed: 0,
    });

    // Reset failure counter + (if changed) stamp baseline_established_at.
    await svc.rpc("reset_scout_failures", { p_scout_id: scout.id });
    if (result.change_status === "same" || result.change_status === "changed") {
      await svc
        .from("scouts")
        .update({ baseline_established_at: new Date().toISOString() })
        .eq("id", scout.id);
    }

    logEvent({
      level: "info",
      fn: "scout-web-execute",
      event: "success",
      scout_id: scout.id,
      run_id: runId,
      change: result.change_status,
      articles_count: result.articles_count,
      merged_existing_count: result.merged_existing_count,
    });

    // Notify user when the run produced new, non-duplicate units. Criteria
    // scouts only produce units when criteria match; Any Change scouts skip
    // criteria analysis but should still alert on changed content.
    // Never throws — a mail failure must not flip the run into error.
    if (willNotify) {
      const summary = result.summary!.trim();
      try {
        await markNotificationAttempted(svc, runId).catch((markErr) =>
          logEvent({
            level: "warn",
            fn: "scout-web-execute",
            event: "notify_status_update_failed",
            scout_id: scout.id,
            run_id: runId,
            msg: markErr instanceof Error ? markErr.message : String(markErr),
          })
        );
        const notification = await sendPageScoutAlert(svc, {
          userId: scout.user_id,
          scoutId: scout.id,
          runId,
          scoutName: scout.name ?? "Page Scout",
          url: scout.url,
          criteria: scout.criteria ?? "",
          summary,
          matchedUrl: result.matchedUrl ?? null,
          matchedTitle: result.matchedTitle ?? null,
          matchedSummary: result.matchedSummary ?? null,
          // Archive deep link (U5): archiveContext is present exactly when this
          // run was gated (archive on) + changed/new, which guarantees a
          // snapshot row lands from the background capture.
          archiveEnabled: !!result.archiveContext,
        });
        if (!notification.ok) {
          await markNotificationResult(
            svc,
            runId,
            notification.reason === "missing_email" ? "skipped" : "failed",
            {
              message: notification.error ?? notification.reason ??
                "notification not sent",
              reason: notification.reason ?? "unknown",
            },
          ).catch((markErr) =>
            logEvent({
              level: "warn",
              fn: "scout-web-execute",
              event: "notify_status_update_failed",
              scout_id: scout.id,
              run_id: runId,
              msg: markErr instanceof Error ? markErr.message : String(markErr),
            })
          );
          logEvent({
            level: "warn",
            fn: "scout-web-execute",
            event: "notify_not_sent",
            scout_id: scout.id,
            run_id: runId,
            msg: notification.reason ?? "unknown",
          });
        } else {
          await markNotificationResult(svc, runId, "sent", {
            providerId: notification.providerId ?? null,
          }).catch((markErr) =>
            logEvent({
              level: "warn",
              fn: "scout-web-execute",
              event: "notify_status_update_failed",
              scout_id: scout.id,
              run_id: runId,
              msg: markErr instanceof Error ? markErr.message : String(markErr),
            })
          );
        }
      } catch (e) {
        await markNotificationResult(
          svc,
          runId,
          "failed",
          e instanceof Error ? e.message : String(e),
        ).catch((markErr) =>
          logEvent({
            level: "warn",
            fn: "scout-web-execute",
            event: "notify_status_update_failed",
            scout_id: scout.id,
            run_id: runId,
            msg: markErr instanceof Error ? markErr.message : String(markErr),
          })
        );
        logEvent({
          level: "warn",
          fn: "scout-web-execute",
          event: "notify_failed",
          scout_id: scout.id,
          run_id: runId,
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Archive capture (PAGE-ARCHIVE-PRD U3) — scheduled AFTER the run is
    // marked success and the notification is sent, so a capture fetch that
    // takes tens of seconds never delays or endangers either (R11). The row
    // and its scout_runs.metadata diagnostics land asynchronously. Dark unless
    // the scout's archive gate resolved on (KTD6).
    if (result.archiveContext) {
      const { detection, ctx } = result.archiveContext;
      const waybackEnabled = scoutWaybackEnabled(scout.wayback_enabled);
      runSnapshotInBackground((async () => {
        const outcome = await performArchiveCapture(svc, ctx, detection);
        // Land the capture diagnostics FIRST, then run the slower trust layer
        // (up to ~30s of TSA/Wayback). If the isolate is evicted mid-trust, the
        // snapshot row + its scout_runs.metadata diagnostics are already saved;
        // only the trust columns stay at their honest 'pending' default.
        await mergeRunMetadata(svc, runId, snapshotDiagnostics(outcome));
        if (outcome.stored) {
          try {
            await applyTrustLayer(svc, outcome.stored, waybackEnabled);
          } catch (e) {
            logEvent({
              level: "warn",
              fn: "scout-web-execute",
              event: "trust_layer_failed",
              scout_id: scout.id,
              run_id: runId,
              msg: e instanceof Error ? e.message : String(e),
            });
          }
        }
      })());
    }

    return jsonOk({
      status: "ok",
      change: result.change_status,
      articles_count: result.articles_count,
      merged_existing_count: result.merged_existing_count,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const classified = classifyRunError(e, "finalize");
    try {
      await markRunError(svc, runId, {
        stage: classified.stage,
        errorClass: classified.errorClass,
        message: classified.message,
      });
      if (shouldIncrementScoutFailure(classified.errorClass)) {
        await incrementAndMaybeNotify(svc, {
          scoutId: scout.id as string,
          userId: scout.user_id as string,
          scoutName: (scout.name as string | null) ?? "Page Scout",
          scoutType: "web",
          language: scout.preferred_language as string | null,
        });
      }
      if (chargedCredits) {
        // Refund the pre-run charge on failure — users shouldn't pay for
        // scheduled scrapes that never produced billable output.
        await refundCredits(svc, {
          userId: scout.user_id as string,
          cost: CREDIT_COSTS.website_extraction,
          scoutId: scout.id as string,
          scoutType: "web",
          operation: "website_extraction",
        });
      }
    } catch (cleanupErr) {
      logEvent({
        level: "error",
        fn: "scout-web-execute",
        event: "cleanup_failed",
        scout_id: scout.id,
        run_id: runId,
        msg: cleanupErr instanceof Error
          ? cleanupErr.message
          : String(cleanupErr),
      });
    }
    logEvent({
      level: "error",
      fn: "scout-web-execute",
      event: "failed",
      scout_id: scout.id,
      run_id: runId,
      error_class: classified.errorClass,
      msg,
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

interface ScoutRow {
  id: string;
  user_id: string;
  type: string;
  name: string | null;
  url: string;
  criteria: string | null;
  project_id: string | null;
  is_active: boolean;
  provider: "firecrawl" | "firecrawl_plain" | null;
  preferred_language: string | null;
  baseline_established_at?: string | null;
  archive_enabled?: boolean | null;
  wayback_enabled?: boolean | null;
}

interface PipelineResult {
  change_status: "new" | "same" | "changed" | "removed";
  articles_count: number;
  merged_existing_count: number;
  criteria_ran: boolean;
  summary?: string;
  matchedUrl?: string | null;
  matchedTitle?: string | null;
  matchedSummary?: string | null;
  rawHtml?: string | null;
  /** Present only when the archive gate is on AND the run is changed/new
   * (KTD6/R4). Handed to the background capture AFTER the run + notification
   * finalize, so capture latency never touches the run's critical path (R11). */
  archiveContext?: {
    detection: PrimaryPageScrapeResult;
    ctx: CaptureStoreContext;
  };
}

/** Best-effort merge into scout_runs.metadata (same pattern as beat's
 * requested_retrieval). Never fails the run. */
async function mergeRunMetadata(
  svc: SupabaseClient,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const { data: run } = await svc
      .from("scout_runs")
      .select("metadata")
      .eq("id", runId)
      .maybeSingle();
    const existing = (run as { metadata?: unknown } | null)?.metadata;
    const metadata = {
      ...(existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing as Record<string, unknown>
        : {}),
      ...patch,
    };
    const { error } = await svc
      .from("scout_runs")
      .update({ metadata })
      .eq("id", runId);
    if (error) throw new Error(error.message);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "scout-web-execute",
      event: "run_metadata_update_failed",
      run_id: runId,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
}

async function runPipeline(
  svc: SupabaseClient,
  scout: ScoutRow,
  runId: string,
): Promise<PipelineResult> {
  await markRunStage(svc, runId, "scrape");
  // Stamp which scrape backend serves this run (firecrawl | crawl4ai) so the
  // weekly scoreboard and bake monitoring can attribute results per provider —
  // the U7 flip's observability contract (mirrors beat's requested_retrieval).
  await mergeRunMetadata(svc, runId, { scrape_provider: scrapeProvider() });

  // Archive gate (KTD6). Resolved before the detection scrape so a
  // fallback-served host carries the KTD9 same-fetch capture hint. Off →
  // nothing about this run changes (dark by default).
  const archiveGateOn = await resolveArchiveGate(svc, {
    user_id: scout.user_id,
    archive_enabled: scout.archive_enabled,
  });
  const snapshotHint: "on_fallback" | undefined = archiveGateOn
    ? "on_fallback"
    : undefined;
  // 3. Scrape via the provider recorded for this scout:
  //      - "firecrawl_plain": fresh scrape + local canonical hash compare.
  //      - "firecrawl" or null: legacy changeTracking scrape. On a successful
  //        run, migrate to a local canonical baseline.
  const tag = `scout-${scout.id}`.slice(0, 128);

  let markdown: string;
  let changeStatus: ChangeTrackingResult["change_status"];
  let scrapeTitle: string | null = null;

  let rawHtml: string | null = null;
  let scrapeMetadata: Record<string, unknown> | undefined;
  let scrapeStrategy = "combined";
  let scrapeWarning: string | undefined;
  let servedBy: string | undefined;
  // The full detection scrape result is retained (not just its fields) so the
  // background archive capture can read served_by + any KTD9 same-fetch
  // artifacts (screenshot_url/rawHtml) that a fallback-served fetch carried.
  let detectionResult: PrimaryPageScrapeResult | null = null;

  if (scout.provider === "firecrawl_plain") {
    const plain = await scrapePrimaryPageResilient({
      url: scout.url,
      timeoutMs: PRIMARY_SCRAPE_TIMEOUT_MS,
      abortAfterMs: PRIMARY_SCRAPE_ABORT_AFTER_MS,
      snapshot: snapshotHint,
      ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
    });
    detectionResult = plain;
    markdown = plain.markdown ?? "";
    rawHtml = plain.rawHtml ?? null;
    scrapeTitle = plain.title ?? null;
    scrapeMetadata = plain.metadata;
    scrapeStrategy = plain.scrape_strategy;
    scrapeWarning = plain.scrape_warning;
    servedBy = plain.served_by;
    changeStatus = await hashChangeStatusForUrl(svc, scout.id, markdown, {
      fn: "scout-web-execute",
    });
  } else {
    try {
      const ct = await scrapePrimaryPageResilient({
        url: scout.url,
        changeTrackingTag: tag,
        timeoutMs: PRIMARY_SCRAPE_TIMEOUT_MS,
        abortAfterMs: PRIMARY_SCRAPE_ABORT_AFTER_MS,
        snapshot: snapshotHint,
      });
      detectionResult = ct;
      markdown = ct.markdown ?? "";
      rawHtml = ct.rawHtml ?? null;
      scrapeTitle = ct.title ?? null;
      scrapeMetadata = ct.metadata;
      scrapeStrategy = ct.scrape_strategy;
      scrapeWarning = ct.scrape_warning;
      servedBy = ct.served_by;
      changeStatus = ct.change_status ?? "new";
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "scout-web-execute",
        event: "change_tracking_fallback",
        scout_id: scout.id,
        msg: e instanceof Error ? e.message : String(e),
      });
      const plain = await scrapePrimaryPageResilient({
        url: scout.url,
        timeoutMs: PRIMARY_SCRAPE_TIMEOUT_MS,
        abortAfterMs: PRIMARY_SCRAPE_ABORT_AFTER_MS,
        snapshot: snapshotHint,
        ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
      });
      detectionResult = plain;
      markdown = plain.markdown ?? "";
      rawHtml = plain.rawHtml ?? null;
      scrapeTitle = plain.title ?? null;
      scrapeMetadata = plain.metadata;
      scrapeStrategy = `plain_${plain.scrape_strategy}`;
      scrapeWarning = plain.scrape_warning;
      servedBy = plain.served_by;
      changeStatus = await hashChangeStatusForUrl(svc, scout.id, markdown, {
        fn: "scout-web-execute",
      });
    }
  }

  // Which backend ACTUALLY served the content — differs from scrape_provider
  // when the anti-bot fallback fired (crawl4ai blocked → firecrawl). The
  // weekly scoreboard monitors this to prove the fallback path stays healthy.
  await mergeRunMetadata(svc, runId, {
    scrape_provider_served: servedBy ?? scrapeProvider(),
  });

  if (scrapeStrategy !== "combined" || scrapeWarning) {
    logEvent({
      level: "info",
      fn: "scout-web-execute",
      event: "primary_scrape_resilience",
      scout_id: scout.id,
      run_id: runId,
      strategy: scrapeStrategy,
      warning: scrapeWarning ?? null,
      raw_html_available: !!rawHtml?.trim(),
    });
  }

  let phaseBLinks = rawHtml?.trim()
    ? extractLinksFromHtml(rawHtml, scout.url)
    : [];
  if (phaseBLinks.length === 0 && markdown.trim()) {
    const markdownLinks = extractLinksFromMarkdown(markdown, scout.url);
    if (markdownLinks.length > 0) {
      phaseBLinks = markdownLinks;
      logEvent({
        level: "info",
        fn: "scout-web-execute",
        event: "phase_b_using_markdown_links",
        scout_id: scout.id,
        run_id: runId,
        links_found: markdownLinks.length,
      });
    }
  }
  const phaseBCandidates = phaseBLinks.length > 0
    ? filterSubpageUrls(phaseBLinks.map(([url]) => url), scout.url)
    : [];
  const deterministicListingPage = hasDeterministicListingSignal(
    scout.url,
    phaseBCandidates,
  );

  if (changeStatus === "same" && !deterministicListingPage) {
    if (
      scout.provider !== "firecrawl_plain" &&
      webCanonicalHashEnabled() &&
      markdown.trim()
    ) {
      const contentHash = await sha256Hex(markdown);
      await insertRawCapture(svc, {
        scout,
        runId,
        sourceUrl: scout.url,
        sourceDomain: deriveSourceDomain(scout.url),
        markdown,
        contentHash,
      });
      await markScoutCanonicalProvider(svc, scout.id);
    }
    return {
      change_status: "same",
      articles_count: 0,
      merged_existing_count: 0,
      criteria_ran: false,
    };
  }

  if (!markdown.trim()) {
    throw new ApiError("firecrawl returned empty markdown", 502);
  }
  await markRunStage(svc, runId, "insert_units");
  // Keep the legacy local name for the rest of the pipeline below.
  const scrape = {
    markdown,
    change_status: changeStatus,
    title: scrapeTitle,
    rawHtml,
    metadata: scrapeMetadata,
  };
  const primaryPublishedDate = sourcePublishedDate({ scrape });

  // 4. Insert raw_capture for the scraped index content. Phase B subpages get
  // their own capture rows so units can trace back to the exact article URL.
  const contentHash = await sha256Hex(markdown);
  const sourceDomain = deriveSourceDomain(scout.url);
  const rawCaptureId = await insertRawCapture(svc, {
    scout,
    runId,
    sourceUrl: scout.url,
    sourceDomain,
    markdown,
    contentHash,
  });

  // Archive capture context (R4): built only for gated changed/new runs.
  // 'same' returned earlier; 'removed' (page gone) has nothing to capture.
  // The capture itself runs in the background after the run finalizes (below),
  // binding to the exact detection markdown that fired (KTD4/Decision 10).
  const archiveContext = (archiveGateOn && detectionResult &&
      (changeStatus === "changed" || changeStatus === "new"))
    ? {
      detection: detectionResult,
      ctx: {
        scoutId: scout.id,
        userId: scout.user_id,
        scoutRunId: runId,
        rawCaptureId,
        captureKind: "change" as const,
        requestedUrl: scout.url,
        fallbackMarkdown: markdown,
        contentSha256: contentHash,
        canonicalContentSha256: await webCanonicalHash(markdown),
      } satisfies CaptureStoreContext,
    }
    : undefined;

  // 5. Extract units and insert non-dupes.
  // Always run extraction; criteria narrows focus when set.
  await markRunStage(svc, runId, "extract");
  const hasCriteria = !!scout.criteria?.trim();

  const extracted = deterministicListingPage
    ? { units: [], isListingPage: true }
    : await extractAtomicUnits({
      title: scrape.title ?? null,
      content: markdown,
      sourceUrl: scout.url,
      publishedDate: primaryPublishedDate,
      language:
        (scout as { preferred_language?: string | null }).preferred_language ??
          "en",
      criteria: hasCriteria ? scout.criteria : null,
      maxUnits: 8,
      contentLimit: PROMPT_CONTENT_MAX,
      timeoutMs: PRIMARY_EXTRACTION_TIMEOUT_MS,
      usage: {
        db: svc,
        userId: scout.user_id,
        scoutId: scout.id,
        runId,
        functionName: "scout-web-execute",
        operation: "web_extract_primary",
      },
    });
  const indexIsListingPage = deterministicListingPage ||
    extracted.isListingPage;

  if (indexIsListingPage && !rawHtml?.trim()) {
    logEvent({
      level: "warn",
      fn: "scout-web-execute",
      event: "phase_b_skipped_raw_html_unavailable",
      scout_id: scout.id,
      run_id: runId,
      strategy: scrapeStrategy,
      warning: scrapeWarning ?? null,
    });
  }

  if (deterministicListingPage) {
    logEvent({
      level: "info",
      fn: "scout-web-execute",
      event: "phase_b_deterministic_listing",
      scout_id: scout.id,
      run_id: runId,
      candidates: phaseBCandidates.length,
    });
  }

  let inserted = 0;
  let mergedExisting = 0;
  const insertedStatements: string[] = [];
  let matchedUrl: string | null = null;
  let matchedTitle: string | null = null;
  let matchedSummary: string | null = null;

  // Hard gate: listing pages yield no Phase A units — full articles come via Phase B.
  const phaseAUnits = indexIsListingPage ? [] : withHeadlineFallback(
    extracted.units,
    {
      title: scrape.title ?? null,
      markdown,
      sourceDomain,
      publishedDate: primaryPublishedDate,
      hasCriteria,
    },
  );
  await markRunStage(svc, runId, "insert_units");
  const phaseA = await insertExtractedUnits(
    svc,
    phaseAUnits,
    scout,
    runId,
    rawCaptureId,
    scout.url,
    scrape.title ?? null,
    sourceDomain,
    contentHash,
    primaryPublishedDate,
    {
      change_status: scrape.change_status,
      phase: "primary",
    },
  );
  inserted += phaseA.insertedCount;
  mergedExisting += phaseA.mergedExistingCount;
  insertedStatements.push(...phaseA.insertedStatements.slice(0, 3));
  if (phaseA.firstMatchedUrl) {
    matchedUrl = phaseA.firstMatchedUrl;
    matchedTitle = phaseA.firstMatchedTitle ?? null;
    matchedSummary = phaseA.firstMatchedSummary ?? null;
  }

  // =========================================================================
  // Phase B — follow listing subpages
  // =========================================================================
  if (indexIsListingPage && phaseBCandidates.length > 0) {
    try {
      const subpageResult = await runPhaseB(
        svc,
        scout,
        runId,
        phaseBLinks,
        phaseBCandidates,
        Date.now() + PHASE_B_TOTAL_BUDGET_MS,
      );
      inserted += subpageResult.totalInserted;
      mergedExisting += subpageResult.totalMergedExisting;
      for (const statement of subpageResult.insertedStatements) {
        if (insertedStatements.length >= 3) break;
        insertedStatements.push(statement);
      }
      if (!matchedUrl && subpageResult.firstMatchedUrl) {
        matchedUrl = subpageResult.firstMatchedUrl;
        matchedTitle = subpageResult.firstMatchedTitle ?? null;
        matchedSummary = subpageResult.firstMatchedSummary ?? null;
      }
      logEvent({
        level: "info",
        fn: "scout-web-execute",
        event: "phase_b",
        scout_id: scout.id,
        run_id: runId,
        links_found: subpageResult.linksFound,
        candidates: subpageResult.candidates,
        fresh: subpageResult.fresh,
        processed: subpageResult.processed,
        nested_listings_skipped: subpageResult.nestedListings,
        failed: subpageResult.failed,
        units_inserted: subpageResult.totalInserted,
        units_merged_existing: subpageResult.totalMergedExisting,
      });
    } catch (error) {
      logEvent({
        level: "warn",
        fn: "scout-web-execute",
        event: "phase_b_failed",
        scout_id: scout.id,
        run_id: runId,
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Build a short summary for the notification email from the first few
  // statements (bulleted if 2+). Matches legacy summary shape.
  const summary = insertedStatements.length === 1
    ? insertedStatements[0]
    : insertedStatements.map((s) => `- ${s}`).join("\n");

  if (scout.provider !== "firecrawl_plain" && webCanonicalHashEnabled()) {
    await markScoutCanonicalProvider(svc, scout.id);
  }

  return {
    change_status: scrape.change_status,
    articles_count: inserted,
    merged_existing_count: mergedExisting,
    criteria_ran: hasCriteria,
    summary: summary || undefined,
    matchedUrl,
    matchedTitle,
    matchedSummary,
    archiveContext,
  };
}

// =========================================================================
// Phase B helpers
// =========================================================================

const DENYLIST_EXTENSIONS = [
  ".css",
  ".js",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
];

/** Extract href links from raw HTML, filtering same-host only. */
function extractLinksFromHtml(
  html: string,
  pageUrl: string,
): [string, string][] {
  const parsed = new URL(pageUrl);
  const pageDomain = parsed.hostname.toLowerCase();
  const seenUrls = new Set<string>();
  const links: [string, string][] = [];

  const regex =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    let href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const anchorText = (match[4] ?? "").replace(/<[^>]+>/g, "").trim();

    // Skip non-HTTP schemes
    if (
      href.startsWith("mailto:") || href.startsWith("javascript:") ||
      href.startsWith("#")
    ) continue;

    // Skip static assets
    const hrefLower = href.toLowerCase();
    if (DENYLIST_EXTENSIONS.some((ext) => hrefLower.endsWith(ext))) continue;

    // Resolve relative URLs
    if (href.startsWith("/")) {
      href = `${parsed.protocol}//${parsed.host}${href}`;
    } else if (!href.startsWith("http://") && !href.startsWith("https://")) {
      continue;
    }

    // Same-host filter
    try {
      const linkDomain = new URL(href).hostname.toLowerCase();
      if (linkDomain !== pageDomain) continue;
    } catch {
      continue;
    }

    // Skip self-referential links
    const hrefNoFragment = href.split("#")[0].replace(/\/+$/, "");
    const pageNoFragment = pageUrl.split("#")[0].replace(/\/+$/, "");
    if (hrefNoFragment === pageNoFragment) continue;

    // Deduplicate
    if (!seenUrls.has(hrefNoFragment)) {
      seenUrls.add(hrefNoFragment);
      links.push([hrefNoFragment, anchorText]);
    }
  }

  return links;
}

function extractLinksFromMarkdown(
  markdown: string,
  pageUrl: string,
): [string, string][] {
  const parsed = new URL(pageUrl);
  const pageDomain = parsed.hostname.toLowerCase();
  const seenUrls = new Set<string>();
  const links: [string, string][] = [];
  const regex = /\[([^\]]{0,240})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdown)) !== null) {
    const anchorText = (match[1] ?? "").trim();
    let href = (match[2] ?? "").trim();
    if (!href || href.startsWith("#")) continue;
    if (href.startsWith("mailto:") || href.startsWith("javascript:")) {
      continue;
    }
    const hrefLower = href.toLowerCase();
    if (DENYLIST_EXTENSIONS.some((ext) => hrefLower.endsWith(ext))) continue;

    if (href.startsWith("/")) {
      href = `${parsed.protocol}//${parsed.host}${href}`;
    } else if (!href.startsWith("http://") && !href.startsWith("https://")) {
      continue;
    }

    try {
      const link = new URL(href);
      if (link.hostname.toLowerCase() !== pageDomain) continue;
      link.hash = "";
      const clean = link.toString().replace(/\/+$/, "");
      const pageNoFragment = pageUrl.split("#")[0].replace(/\/+$/, "");
      if (clean === pageNoFragment) continue;
      if (!seenUrls.has(clean)) {
        seenUrls.add(clean);
        links.push([clean, anchorText]);
      }
    } catch {
      continue;
    }
  }
  return links;
}

function withHeadlineFallback(
  units: ExtractedUnit[],
  opts: {
    title: string | null;
    markdown: string;
    sourceDomain: string | null;
    publishedDate: string | null;
    hasCriteria: boolean;
  },
): ExtractedUnit[] {
  if (units.length > 0 || opts.hasCriteria) return units;
  if (!isLikelyArticleDocument(opts.markdown, opts.title)) return units;
  const title = cleanTitle(opts.title);
  if (!title) return units;
  const source = opts.sourceDomain ? ` by ${opts.sourceDomain}` : "";
  const date = opts.publishedDate ? ` on ${opts.publishedDate}` : "";
  return [{
    statement: `${title} was published${source}${date}.`,
    type: "entity_update",
    context_excerpt: firstReadableExcerpt(opts.markdown),
    occurred_at: opts.publishedDate,
    entities: [],
    criteria_match: true,
  }];
}

function isLikelyArticleDocument(
  markdown: string,
  title: string | null,
): boolean {
  const clean = markdown
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_>`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = clean ? clean.split(/\s+/).length : 0;
  const linkCount = (markdown.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  if (words >= 120) return true;
  if (cleanTitle(title) && words >= 50 && linkCount <= 12) return true;
  return false;
}

function looksLikeNavigationDocument(markdown: string): boolean {
  const linkCount = (markdown.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length;
  const wordCount = markdown.replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return linkCount >= 10 && wordCount < 160;
}

function chooseSubpageSourceUrl(
  scrapeSourceUrl: string | null | undefined,
  requestedSubUrl: string,
  monitoredRootUrl: string,
): string {
  const source = scrapeSourceUrl?.trim();
  if (!source) return requestedSubUrl;
  const normalizedSource = normalizeComparableUrl(source);
  const normalizedRoot = normalizeComparableUrl(monitoredRootUrl);
  const normalizedRequested = normalizeComparableUrl(requestedSubUrl);
  if (
    normalizedSource && normalizedRoot && normalizedRequested &&
    normalizedSource === normalizedRoot &&
    normalizedRequested !== normalizedRoot
  ) {
    return requestedSubUrl;
  }
  return source;
}

function normalizeComparableUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function cleanTitle(title: string | null): string {
  return (title ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+[-|]\s+[^-|]+$/, "")
    .trim()
    .slice(0, 180);
}

function firstReadableExcerpt(markdown: string): string | undefined {
  const line = markdown
    .split(/\n+/)
    .map((l) =>
      l.replace(/\[[^\]]+\]\([^)]+\)/g, "").replace(/[#*_>`~-]/g, "").trim()
    )
    .find((l) => l.length >= 60);
  return line?.slice(0, 500);
}

async function runPhaseB(
  svc: SupabaseClient,
  scout: ScoutRow,
  runId: string,
  links: [string, string][],
  candidateUrls: string[],
  deadlineMs: number,
): Promise<{
  linksFound: number;
  candidates: number;
  fresh: number;
  processed: number;
  nestedListings: number;
  failed: number;
  totalInserted: number;
  totalMergedExisting: number;
  insertedStatements: string[];
  firstMatchedUrl: string | null;
  firstMatchedTitle: string | null;
  firstMatchedSummary: string | null;
}> {
  // 3. Dedup against already-seen subpage URLs from stored units
  const { data: seenRows } = await svc
    .from("unit_occurrences")
    .select("normalized_source_url")
    .eq("scout_id", scout.id)
    .not("normalized_source_url", "is", null);
  const seen = new Set<string>(
    (seenRows ?? []).map((r) => r.normalized_source_url as string),
  );

  const fresh = candidateUrls.filter((url) => {
    const normalized = normalizeSourceUrl(url);
    return normalized ? !seen.has(normalized) : true;
  });
  const previouslySeen = candidateUrls.filter((url) => {
    const normalized = normalizeSourceUrl(url);
    return normalized ? seen.has(normalized) : false;
  });
  const processable = [...fresh, ...previouslySeen].slice(0, SUBPAGE_FETCH_CAP);

  let totalInserted = 0;
  let totalMergedExisting = 0;
  let processed = 0;
  let nestedListings = 0;
  let failed = 0;
  const insertedStatements: string[] = [];
  let firstMatchedUrl: string | null = null;
  let firstMatchedTitle: string | null = null;
  let firstMatchedSummary: string | null = null;

  for (let i = 0; i < processable.length; i++) {
    if (Date.now() >= deadlineMs) {
      logEvent({
        level: "info",
        fn: "scout-web-execute",
        event: "phase_b_budget_exhausted",
        scout_id: scout.id,
        processed,
        remaining: processable.length - i,
      });
      break;
    }
    const subUrl = processable[i];
    if (i > 0) await new Promise((r) => setTimeout(r, FIRECRAWL_STAGGER_MS));

    try {
      const subScrape = await firecrawlScrape(subUrl, {
        timeoutMs: SUBPAGE_SCRAPE_TIMEOUT_MS,
        abortAfterMs: SUBPAGE_SCRAPE_ABORT_AFTER_MS,
        ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
      });

      if (!subScrape.markdown?.trim()) {
        failed++;
        continue;
      }
      const subSourceUrl = chooseSubpageSourceUrl(
        subScrape.source_url,
        subUrl,
        scout.url,
      );
      const subSourceDomain = deriveSourceDomain(subSourceUrl);
      const subPublishedDate = sourcePublishedDate({ scrape: subScrape });
      const deterministicArticle = isLikelyArticleUrl(subSourceUrl) ||
        isLikelyArticleUrl(subUrl);
      const articleDocument = isLikelyArticleDocument(
        subScrape.markdown,
        subScrape.title ?? null,
      );
      if (
        !deterministicArticle && looksLikeNavigationDocument(subScrape.markdown)
      ) {
        nestedListings++;
        logEvent({
          level: "info",
          fn: "scout-web-execute",
          event: "phase_b_document_shape_skipped",
          scout_id: scout.id,
          url: subUrl,
          reason: "navigation_shape",
        });
        continue;
      }

      const subExtracted = await extractAtomicUnits({
        title: subScrape.title ?? null,
        content: subScrape.markdown,
        sourceUrl: subSourceUrl,
        publishedDate: subPublishedDate,
        language: scout.preferred_language ?? "en",
        criteria: scout.criteria ?? null,
        maxUnits: 8,
        contentLimit: PROMPT_CONTENT_MAX,
        timeoutMs: SUBPAGE_EXTRACTION_TIMEOUT_MS,
        usage: {
          db: svc,
          userId: scout.user_id,
          scoutId: scout.id,
          runId,
          functionName: "scout-web-execute",
          operation: "web_extract_subpage",
        },
      });

      if (subExtracted.isListingPage) {
        if (deterministicArticle && articleDocument) {
          logEvent({
            level: "info",
            fn: "scout-web-execute",
            event: "phase_b_article_marked_listing",
            scout_id: scout.id,
            url: subUrl,
          });
        } else {
          nestedListings++;
          logEvent({
            level: "info",
            fn: "scout-web-execute",
            event: "phase_b_nested_listing_skipped",
            scout_id: scout.id,
            url: subUrl,
          });
          continue;
        }
      }

      const subUnits = withHeadlineFallback(subExtracted.units, {
        title: subScrape.title ?? null,
        markdown: subScrape.markdown,
        sourceDomain: subSourceDomain,
        publishedDate: subPublishedDate,
        hasCriteria: Boolean(scout.criteria?.trim()),
      });

      if (subUnits.length === 0 && !articleDocument) {
        nestedListings++;
        logEvent({
          level: "info",
          fn: "scout-web-execute",
          event: "phase_b_document_shape_skipped",
          scout_id: scout.id,
          url: subUrl,
          reason: "no_article_body",
        });
        continue;
      }

      const subContentHash = await sha256Hex(subScrape.markdown);
      const subRawCaptureId = await insertRawCapture(svc, {
        scout,
        runId,
        sourceUrl: subSourceUrl,
        sourceDomain: subSourceDomain,
        markdown: subScrape.markdown,
        contentHash: subContentHash,
      });
      const result = await insertExtractedUnits(
        svc,
        subUnits,
        scout,
        runId,
        subRawCaptureId,
        subSourceUrl,
        subScrape.title ?? null,
        subSourceDomain,
        subContentHash,
        subPublishedDate,
        {
          phase: "subpage",
          parent_source_url: scout.url,
          requested_url: subUrl,
        },
      );
      totalInserted += result.insertedCount;
      totalMergedExisting += result.mergedExistingCount;
      if (!firstMatchedUrl && result.firstMatchedUrl) {
        firstMatchedUrl = result.firstMatchedUrl;
        firstMatchedTitle = result.firstMatchedTitle ?? null;
        firstMatchedSummary = result.firstMatchedSummary ?? null;
      }
      for (const statement of result.insertedStatements) {
        if (insertedStatements.length >= 3) break;
        insertedStatements.push(statement);
      }
      processed++;
    } catch (error) {
      failed++;
      logEvent({
        level: "warn",
        fn: "scout-web-execute",
        event: "phase_b_subpage_failed",
        scout_id: scout.id,
        url: subUrl,
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    linksFound: links.length,
    candidates: candidateUrls.length,
    fresh: fresh.length,
    processed,
    nestedListings,
    failed,
    totalInserted,
    totalMergedExisting,
    insertedStatements,
    firstMatchedUrl,
    firstMatchedTitle,
    firstMatchedSummary,
  };
}

async function insertRawCapture(
  svc: SupabaseClient,
  input: {
    scout: ScoutRow;
    runId: string;
    sourceUrl: string;
    sourceDomain: string | null;
    markdown: string;
    contentHash: string;
  },
): Promise<string> {
  const { data: capture, error } = await svc
    .from("raw_captures")
    .insert({
      user_id: input.scout.user_id,
      scout_id: input.scout.id,
      scout_run_id: input.runId,
      source_url: input.sourceUrl,
      source_domain: input.sourceDomain,
      content_md: input.markdown,
      content_sha256: input.contentHash,
      canonical_content_sha256: await webCanonicalHash(input.markdown),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
      token_count: Math.ceil(input.markdown.length / 4),
      captured_at: new Date().toISOString(),
      expires_at: rawCaptureExpiresAt(),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return capture.id as string;
}

async function markScoutCanonicalProvider(
  svc: SupabaseClient,
  scoutId: string,
): Promise<void> {
  const { error } = await svc
    .from("scouts")
    .update({ provider: "firecrawl_plain" })
    .eq("id", scoutId);
  if (error) throw new Error(error.message);
}

/**
 * Extract units into information_units with dedup. Returns count inserted.
 */
function firstMatchedSummaryForUnit(
  unit: { statement: string; context_excerpt?: string },
): string {
  const excerpt = unit.context_excerpt?.trim();
  return excerpt || unit.statement.trim();
}

async function insertExtractedUnits(
  svc: SupabaseClient,
  units: Array<
    {
      statement: string;
      type: string;
      context_excerpt?: string;
      occurred_at?: string | null;
      entities?: string[];
    }
  >,
  scout: ScoutRow,
  runId: string,
  rawCaptureId: string,
  sourceUrl: string,
  sourceTitle: string | null,
  sourceDomain: string | null,
  contentSha256: string | null,
  sourcePublishedDateFallback: string | null = null,
  metadata: Record<string, unknown> | null = null,
): Promise<{
  insertedCount: number;
  mergedExistingCount: number;
  insertedStatements: string[];
  firstMatchedUrl: string | null;
  firstMatchedTitle: string | null;
  firstMatchedSummary: string | null;
}> {
  if (units.length === 0) {
    return {
      insertedCount: 0,
      mergedExistingCount: 0,
      insertedStatements: [],
      firstMatchedUrl: null,
      firstMatchedTitle: null,
      firstMatchedSummary: null,
    };
  }

  const eligibleUnits = units.filter((unit) =>
    unit && typeof unit.statement === "string" && unit.statement.trim() &&
    ["fact", "event", "entity_update"].includes(unit.type)
  );
  let embeddings: Array<number[] | null>;
  try {
    embeddings = await embedBatch(eligibleUnits.map((unit) => ({
      text: unit.statement,
      taskType: "RETRIEVAL_DOCUMENT",
      title: sourceTitle,
    })));
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "scout-web-execute",
      event: "embed_batch_failed",
      scout_id: scout.id,
      run_id: runId,
      msg: e instanceof Error ? e.message : String(e),
    });
    embeddings = eligibleUnits.map(() => null);
  }

  const runUnits: Array<{ statement: string; embedding: number[] }> = [];
  let inserted = 0;
  let mergedExisting = 0;
  const insertedStatements: string[] = [];
  const factCheckConfig = loadFactCheckConfig();
  let firstMatchedUrl: string | null = null;
  let firstMatchedTitle: string | null = null;
  let firstMatchedSummary: string | null = null;

  for (const [index, u] of eligibleUnits.entries()) {
    const embedding = embeddings[index];
    const unitType = u.type as CanonicalUnitType;

    // Within-run paraphrase guard: drop units that are near-duplicates of an
    // already-kept unit in *this* extraction batch.
    if (embedding) {
      const candidate = { statement: u.statement, embedding };
      if (isWithinRunDuplicateWithGuards(candidate, runUnits)) continue;
      runUnits.push(candidate);
    }

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
          sourceDomain,
          occurredAt: normalizeDate(u.occurred_at) ??
            sourcePublishedDateFallback,
        });
      } catch {
        // Fact-check failure is non-fatal — unit proceeds unchecked.
      }
    }

    const result = await upsertCanonicalUnit(svc, {
      userId: scout.user_id,
      statement: u.statement,
      unitType,
      entities: u.entities ?? [],
      embedding,
      embeddingModel: embedding ? EMBEDDING_MODEL_TAG : null,
      sourceUrl,
      sourceDomain,
      sourceTitle,
      contextExcerpt: u.context_excerpt ?? null,
      occurredAt: normalizeDate(u.occurred_at) ?? sourcePublishedDateFallback,
      extractedAt: new Date().toISOString(),
      sourceType: "scout",
      contentSha256,
      scoutId: scout.id,
      scoutType: "web",
      scoutRunId: runId,
      projectId: scout.project_id ?? null,
      rawCaptureId,
      metadata,
      factChecked: fcResult.fact_checked,
      confidenceScore: fcResult.confidence_score,
      abstained: fcResult.abstained,
      abstainReason: fcResult.abstain_reason,
    });

    if (result.createdCanonical) {
      inserted += 1;
      if (insertedStatements.length < 3) insertedStatements.push(u.statement);
      if (!firstMatchedUrl) {
        firstMatchedUrl = sourceUrl;
        firstMatchedTitle = sourceTitle;
        firstMatchedSummary = firstMatchedSummaryForUnit(u);
      }
    } else if (result.mergedExisting && result.occurrenceCreated) {
      mergedExisting += 1;
    }
  }
  return {
    insertedCount: inserted,
    mergedExistingCount: mergedExisting,
    insertedStatements,
    firstMatchedUrl,
    firstMatchedTitle,
    firstMatchedSummary,
  };
}

// normalizeDate moved to ../_shared/date_utils.ts (imported at the top).
