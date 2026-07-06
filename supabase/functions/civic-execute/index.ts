/**
 * civic-execute Edge Function — Civic Scout fast entry point.
 *
 * Scrapes each tracked URL through the scrape port and detects change with
 * in-house canonical-hash baselines per (scout, source_url) — see
 * _shared/canonical_baseline.ts (SCRAPING-MIGRATION-PRD U4; replaced Firecrawl
 * changeTracking). When a tracked listing page changes, it parses the raw
 * HTML, extracts downstream meeting document links, classifies them with the
 * migrated civic keyword/LLM flow, and enqueues them in civic_extraction_queue
 * for downstream processing by a PDF worker. Per-scout `processed_pdf_urls` is
 * maintained to suppress repeat enqueues (cap 100 most recent).
 *
 * Route:
 *   POST /civic-execute
 *     body: { scout_id: uuid, run_id?: uuid }
 *     -> 200 { status: "ok", queued: N, tracked_urls_checked: M, run_id }
 *
 * Auth: shared service auth (X-Service-Key, with service-role fallback for
 * operator tooling). Cron/dispatcher only.
 *
 * Errors:
 *   - 404 if scout missing
 *   - 400 if scout.tracked_urls is empty
 *   - 500/502 on firecrawl failures; failed runs mark scout_runs status='error'
 *     and increment_scout_failures (auto-pause at 3).
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient, SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { NotFoundError, ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { scrape } from "../_shared/scrape.ts";
import {
  hashChangeStatusForUrl,
  writeCanonicalBaseline,
} from "../_shared/canonical_baseline.ts";
import {
  allTrackedUrlsGone,
  CivicTrackedUrlStatus,
  firecrawlUpstreamStatus,
} from "../_shared/civic_diagnostics.ts";
import {
  classifyCivicMeetingUrls,
  extractCivicLinksFromPages,
  isCivicDirectDocumentUrl,
  isCivicScrapableUrl,
} from "../_shared/civic_links.ts";
import { incrementAndMaybeNotify } from "../_shared/scout_failures.ts";
import {
  classifyRunError,
  markRunError,
  markRunStage,
  markRunSuccess,
  shouldIncrementScoutFailure,
} from "../_shared/run_lifecycle.ts";
import {
  CREDIT_COSTS,
  decrementOrThrow,
  InsufficientCreditsError,
  insufficientCreditsResponse,
  refundCredits,
} from "../_shared/credits.ts";
import { normalizeSourceUrl } from "../_shared/unit_dedup.ts";

const InputSchema = z.object({
  scout_id: z.string().uuid(),
  run_id: z.string().uuid().optional(),
});

const MAX_TRACKED = 20;
// Cap docs enqueued per scheduled run. Mirrors legacy civic_orchestrator's
// MAX_DOCS_PER_RUN=2 — limits Firecrawl PDF-parse + Gemini extraction cost
// to a predictable ceiling so the per-run credit charge stays sustainable.
const MAX_DOCS_PER_RUN = 2;
// Civic scouts are weekly-or-slower only; block misconfigured daily crons.
const ALLOWED_REGULARITIES = new Set(["weekly", "monthly"]);

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
  const { scout_id, run_id } = parsed.data;

  try {
    return await execute(scout_id, run_id);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "civic-execute",
      event: "unhandled",
      scout_id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

async function execute(scoutId: string, runIdIn?: string): Promise<Response> {
  const db = getServiceClient();

  // 1. Load scout.
  const { data: scout, error: scoutErr } = await db
    .from("scouts")
    .select("*")
    .eq("id", scoutId)
    .maybeSingle();
  if (scoutErr) throw new Error(scoutErr.message);
  if (!scout) throw new NotFoundError("scout");

  const trackedRaw: string[] = Array.isArray(scout.tracked_urls)
    ? scout.tracked_urls
    : [];
  const tracked = trackedRaw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .slice(0, MAX_TRACKED);
  if (tracked.length === 0) {
    throw new ValidationError("scout has no tracked_urls");
  }

  // Civic scouts are weekly-max by design (PDF parse + Gemini cost too high
  // for daily). Reject misconfigured schedules defensively — UI enforces the
  // same rule but a direct-API or legacy record could slip through.
  const regularity = (scout.regularity as string | null) ?? "weekly";
  if (!ALLOWED_REGULARITIES.has(regularity)) {
    throw new ValidationError(
      `civic scouts support regularity ∈ {weekly, monthly} only; got "${regularity}"`,
    );
  }

  // 2. Resolve / create scout_runs row before any charge so a missing baseline
  //    can be recorded as an error without spending user credits.
  const runId = await resolveRun(db, scout, runIdIn);
  await markRunStage(db, runId, "dispatch");

  if (!scout.baseline_established_at) {
    const msg =
      "civic scout has no baseline; recreate or reschedule the scout so creation can establish one before Run Now";
    await markRunError(db, runId, {
      stage: "dispatch",
      errorClass: "no_baseline",
      message: msg,
    });
    throw new ValidationError(msg);
  }

  // 3. Decrement credits before the Firecrawl/Gemini work. Matches the
  //    legacy civic_discover price (10) and offsets a capped cost envelope
  //    (≤20 tracked_urls Firecrawl scrapes + ≤2 PDF parses + ≤2 Gemini
  //    extractions per run). Refunded on error paths via refundCredits.
  try {
    await markRunStage(db, runId, "credits");
    await decrementOrThrow(db, {
      userId: scout.user_id,
      cost: CREDIT_COSTS.civic,
      scoutId: scout.id,
      scoutType: "civic",
      operation: "civic",
    });
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

  try {
    await markRunStage(db, runId, "scrape");

    // URLs already considered "seen" for this scout: (a) already successfully
    // extracted (worker has appended them to scouts.processed_pdf_urls after
    // a successful Firecrawl + insert), OR (b) currently in the queue
    // (pending / processing / done). We intentionally do NOT block URLs with
    // status='failed' past 3 attempts — claim_civic_queue_item caps retries
    // at 3 and we trust that terminal state; re-enqueueing such a URL on the
    // next run is an operator-initiated recovery path.
    const scoutSeen = new Set<string>(
      (Array.isArray(scout.processed_pdf_urls) ? scout.processed_pdf_urls : [])
        .map((url: unknown) =>
          typeof url === "string" ? normalizeCivicUrl(url) : null
        )
        .filter((url: string | null): url is string => Boolean(url)),
    );
    const queueSeen = await loadQueuedSourceUrls(db, scoutId);
    const skipSet = new Set<string>([...scoutSeen, ...queueSeen]);

    let queuedCount = 0;
    let scrapeFailureCount = 0;
    let queueFailureCount = 0;
    const trackedUrlStatus: CivicTrackedUrlStatus[] = [];

    for (const url of tracked) {
      if (queuedCount >= MAX_DOCS_PER_RUN) break;
      if (!isCivicScrapableUrl(url)) {
        trackedUrlStatus.push({ url, status: "unsupported" });
        logEvent({
          level: "warn",
          fn: "civic-execute",
          event: "tracked_url_skipped_unsupported_asset",
          scout_id: scoutId,
          url,
        });
        continue;
      }
      let result;
      try {
        // Fresh scrape via the port (dark: firecrawl; U7: crawl4ai).
        result = await scrape(url, {
          formats: ["markdown", "rawHtml"],
          onlyMainContent: true,
        });
      } catch (e) {
        // The provider's OWN API failed (timeout, 5xx). Transient/provider.
        scrapeFailureCount += 1;
        trackedUrlStatus.push({
          url,
          status: "scrape_failed",
          upstream_status: firecrawlUpstreamStatus(e),
          error: e instanceof Error ? e.message.slice(0, 500) : String(e),
        });
        logEvent({
          level: "warn",
          fn: "civic-execute",
          event: "scrape_failed",
          scout_id: scoutId,
          url,
          msg: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      // Removed / dead page detection (U4 fix): a deleted council page does
      // NOT make the scrape throw — both providers return HTTP 200 with the
      // 404 error page's content and the target's real status in status_code
      // (verified against firecrawl metadata.statusCode and the crawl4ai
      // scrape-service). An error-status target must never be hashed or
      // baselined (an error page's body would poison the baseline), so both
      // branches below `continue` before the change-detection step.
      const targetStatus = result.status_code;
      if (typeof targetStatus === "number" && targetStatus >= 400) {
        if (targetStatus < 500) {
          // 4xx → GONE. A permanent condition (removed / forbidden). Record it
          // but do NOT increment scrapeFailureCount: a single dead page among
          // healthy tracked URLs must not trip the queuedCount===0 throw and
          // auto-pause a working scout. The all-gone case is caught by
          // allTrackedUrlsGone below (skip + refund, surfaces a dead scout).
          trackedUrlStatus.push({
            url,
            status: "gone",
            upstream_status: targetStatus,
            queued_documents: 0,
            error: `tracked page returned HTTP ${targetStatus}`,
          });
          logEvent({
            level: "warn",
            fn: "civic-execute",
            event: "tracked_url_gone",
            scout_id: scoutId,
            url,
            upstream_status: targetStatus,
          });
          continue;
        }
        // 5xx → transient upstream error. Count it as a scrape failure so a run
        // that queued nothing throws and retries (matching a provider API 5xx),
        // rather than skipping the URL as permanently dead.
        scrapeFailureCount += 1;
        trackedUrlStatus.push({
          url,
          status: "scrape_failed",
          upstream_status: targetStatus,
          queued_documents: 0,
          error: `tracked page returned HTTP ${targetStatus}`,
        });
        logEvent({
          level: "warn",
          fn: "civic-execute",
          event: "scrape_failed",
          scout_id: scoutId,
          url,
          upstream_status: targetStatus,
        });
        continue;
      }

      // In-house canonical-hash change detection, per tracked URL (U4). Maps
      // to the same control flow as the retired Firecrawl changeTracking:
      // "same" → skip, "new"/"changed" → process (document-level
      // processed_pdf_urls dedup prevents re-processing, so a first-run "new"
      // is safe to process rather than silently baseline).
      const changeStatus = await hashChangeStatusForUrl(
        db,
        scoutId,
        result.markdown,
        { sourceUrl: url, fn: "civic-execute" },
      );
      // Write the per-URL baseline on EVERY successful scrape (not only on
      // change): raw_captures rows carry a 30-day TTL and are purged by
      // cleanup_raw_captures, so a page that stays unchanged for >30 days
      // would otherwise lose its only baseline and re-classify as "new",
      // re-storming the queue. Writing each run refreshes the TTL and keeps a
      // usable baseline. Written with this run's id → only usable once the run
      // succeeds.
      await writeCanonicalBaseline(db, {
        userId: scout.user_id as string,
        scoutId,
        scoutRunId: runId,
        sourceUrl: url,
        markdown: result.markdown,
      });

      const directDocumentUrl = isCivicDirectDocumentUrl(url)
        ? normalizeCivicUrl(url)
        : null;
      if (directDocumentUrl) {
        // Skip an already-processed direct document unless the page genuinely
        // CHANGED against a known baseline (a new version worth re-extracting).
        // Gate on `!== "changed"` so a first-run "new" (no baseline exists yet
        // for the 19 live scouts on migration) still honors processed_pdf_urls
        // and does not re-enqueue months-old documents.
        if (
          queueSeen.has(directDocumentUrl) ||
          (changeStatus !== "changed" && scoutSeen.has(directDocumentUrl))
        ) {
          trackedUrlStatus.push({
            url,
            status: "already_seen",
            change_status: changeStatus,
            queued_documents: 0,
          });
          continue;
        }
        if (
          await enqueueCivicDocument(db, {
            userId: scout.user_id as string,
            scoutId: scout.id as string,
            runId,
            url: directDocumentUrl,
            docKind: "pdf",
          })
        ) {
          skipSet.add(directDocumentUrl);
          queueSeen.add(directDocumentUrl);
          queuedCount += 1;
          trackedUrlStatus.push({
            url,
            status: "queued",
            change_status: changeStatus,
            queued_documents: 1,
          });
        } else {
          queueFailureCount += 1;
          trackedUrlStatus.push({
            url,
            status: "scraped",
            change_status: changeStatus,
            queued_documents: 0,
            error: "queue insert failed",
          });
        }
        continue;
      }

      if (changeStatus === "same") {
        trackedUrlStatus.push({
          url,
          status: "unchanged",
          change_status: changeStatus,
          queued_documents: 0,
        });
        continue;
      }

      const docs = (await classifyCivicMeetingUrls(extractCivicLinksFromPages([{
        pageUrl: url,
        rawHtml: result.rawHtml ?? "",
      }]))).map((docUrl) => normalizeCivicUrl(docUrl)).filter(
        (docUrl): docUrl is string => Boolean(docUrl),
      );
      let queuedForTrackedUrl = 0;
      for (const docUrl of docs) {
        if (queuedCount >= MAX_DOCS_PER_RUN) break;
        if (skipSet.has(docUrl)) continue;

        const docKind = docUrl.toLowerCase().endsWith(".pdf") ? "pdf" : "html";
        if (
          !(await enqueueCivicDocument(db, {
            userId: scout.user_id as string,
            scoutId: scout.id as string,
            runId,
            url: docUrl,
            docKind,
          }))
        ) {
          queueFailureCount += 1;
          continue;
        }

        // Guard against double-enqueue within the same run (two tracked
        // pages linking the same PDF). scouts.processed_pdf_urls is now
        // only touched by the worker — on successful extraction.
        skipSet.add(docUrl);
        queuedCount += 1;
        queuedForTrackedUrl += 1;
      }
      trackedUrlStatus.push({
        url,
        status: queuedForTrackedUrl > 0 ? "queued" : "no_new_documents",
        change_status: changeStatus,
        queued_documents: queuedForTrackedUrl,
      });
    }

    await persistCivicRunMetadata(db, runId, trackedUrlStatus);

    if (allTrackedUrlsGone(trackedUrlStatus, tracked.length)) {
      await refundCredits(db, {
        userId: scout.user_id,
        cost: CREDIT_COSTS.civic,
        scoutId: scout.id,
        scoutType: "civic",
        operation: "civic",
      });
      const message = "all civic tracked URLs are gone (upstream 4xx)";
      await markRunError(db, runId, {
        stage: "scrape",
        errorClass: "validation",
        message,
        status: "skipped",
      });
      await persistCivicRunMetadata(db, runId, trackedUrlStatus, {
        criteria_status: false,
        notification_status: "skipped",
      });
      return jsonOk({
        status: "skipped",
        run_id: runId,
        queued: 0,
        tracked_urls_checked: tracked.length,
        reason: "all_tracked_urls_gone",
      });
    }

    if (
      queuedCount === 0 && (scrapeFailureCount > 0 || queueFailureCount > 0)
    ) {
      throw new Error(
        `civic pipeline failed before queueing documents; scrape failed=${scrapeFailureCount}; queue insert failed=${queueFailureCount}`,
      );
    }

    // Refund the pre-charge when no billable work was queued. Legacy civic
    // pipeline's MAX_DOCS_PER_RUN=2 meant scouts that hit only "same" pages
    // or already-seen PDFs still cost Firecrawl the change-tracking scrape,
    // but source didn't charge users — match that fairness on scheduled runs.
    if (queuedCount === 0) {
      await refundCredits(db, {
        userId: scout.user_id,
        cost: CREDIT_COSTS.civic,
        scoutId: scout.id,
        scoutType: "civic",
        operation: "civic",
      });
    }

    // 4. Refresh baseline timestamp only. scouts.processed_pdf_urls is
    // mutated by the worker after a successful extraction; dead-on-arrival
    // URLs (Firecrawl failure, LLM failure) stay out of the set so the
    // queue retry path (3 attempts + failsafe) can actually retry them.
    const { error: updErr } = await db
      .from("scouts")
      .update({
        baseline_established_at: new Date().toISOString(),
      })
      .eq("id", scoutId);
    if (updErr) {
      logEvent({
        level: "warn",
        fn: "civic-execute",
        event: "scout_update_failed",
        scout_id: scoutId,
        msg: updErr.message,
      });
    }

    const { error: resetErr } = await db.rpc("reset_scout_failures", {
      p_scout_id: scoutId,
    });
    if (resetErr) {
      logEvent({
        level: "warn",
        fn: "civic-execute",
        event: "reset_failures_failed",
        scout_id: scoutId,
        msg: resetErr.message,
      });
    }

    await markRunSuccess(db, runId, {
      unitsCreated: queuedCount,
      unitsMerged: 0,
      criteriaStatus: queuedCount > 0,
      notificationStatus: queuedCount > 0 ? "pending" : "not_applicable",
      sourcesScraped: tracked.length - scrapeFailureCount,
      sourcesFailed: scrapeFailureCount + queueFailureCount,
    });
    await persistCivicRunMetadata(db, runId, trackedUrlStatus);

    logEvent({
      level: "info",
      fn: "civic-execute",
      event: "success",
      scout_id: scoutId,
      run_id: runId,
      queued: queuedCount,
      tracked_urls_checked: tracked.length,
    });

    return jsonOk({
      status: "ok",
      run_id: runId,
      queued: queuedCount,
      tracked_urls_checked: tracked.length,
    });
  } catch (e) {
    const classified = classifyRunError(e, "scrape");
    await markRunError(db, runId, {
      stage: classified.stage,
      errorClass: classified.errorClass,
      message: classified.message,
    });

    if (shouldIncrementScoutFailure(classified.errorClass)) {
      await incrementAndMaybeNotify(db, {
        scoutId,
        userId: scout.user_id as string,
        scoutName: (scout.name as string | null) ?? "Civic Scout",
        scoutType: "civic",
        language: scout.preferred_language as string | null,
      });
    }
    // Refund the pre-charge on error — the run never got to enqueue work.
    await refundCredits(db, {
      userId: scout.user_id as string,
      cost: CREDIT_COSTS.civic,
      scoutId,
      scoutType: "civic",
      operation: "civic",
    });
    throw e;
  }
}

// ---------------------------------------------------------------------------

async function enqueueCivicDocument(
  db: SupabaseClient,
  input: {
    userId: string;
    scoutId: string;
    runId: string;
    url: string;
    docKind: "pdf" | "html";
  },
): Promise<boolean> {
  const { error } = await db
    .from("civic_extraction_queue")
    .insert({
      user_id: input.userId,
      scout_id: input.scoutId,
      scout_run_id: input.runId,
      source_url: input.url,
      doc_kind: input.docKind,
      status: "pending",
    });
  if (!error) return true;
  logEvent({
    level: "warn",
    fn: "civic-execute",
    event: "queue_insert_failed",
    scout_id: input.scoutId,
    url: input.url,
    msg: error.message,
  });
  return false;
}

/**
 * Return the set of source_urls already present in civic_extraction_queue
 * for this scout in any non-terminal-retry state (pending/processing/done).
 * URLs with status='failed' after 3 attempts are NOT returned — they remain
 * eligible for re-enqueue on a later run.
 */
async function loadQueuedSourceUrls(
  db: SupabaseClient,
  scoutId: string,
): Promise<Set<string>> {
  const { data, error } = await db
    .from("civic_extraction_queue")
    .select("source_url")
    .eq("scout_id", scoutId)
    .in("status", ["pending", "processing", "done"]);
  if (error) {
    logEvent({
      level: "warn",
      fn: "civic-execute",
      event: "queue_select_failed",
      scout_id: scoutId,
      msg: error.message,
    });
    return new Set<string>();
  }
  const urls = Array.isArray(data)
    ? data
      .map((r) =>
        normalizeCivicUrl(
          String((r as { source_url?: string }).source_url ?? ""),
        )
      )
      .filter((s): s is string => Boolean(s))
    : [];
  return new Set<string>(urls);
}

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

async function persistCivicRunMetadata(
  db: SupabaseClient,
  runId: string,
  trackedUrlStatus: CivicTrackedUrlStatus[],
  patch: Record<string, unknown> = {},
): Promise<void> {
  const { data: run } = await db
    .from("scout_runs")
    .select("metadata")
    .eq("id", runId)
    .maybeSingle();
  const existing = run && typeof run === "object" &&
      (run as { metadata?: unknown }).metadata &&
      typeof (run as { metadata?: unknown }).metadata === "object" &&
      !Array.isArray((run as { metadata?: unknown }).metadata)
    ? (run as { metadata: Record<string, unknown> }).metadata
    : {};
  const { error } = await db
    .from("scout_runs")
    .update({
      ...patch,
      metadata: {
        ...existing,
        tracked_url_status: trackedUrlStatus,
        tracked_url_status_updated_at: new Date().toISOString(),
      },
    })
    .eq("id", runId);
  if (error) {
    logEvent({
      level: "warn",
      fn: "civic-execute",
      event: "run_metadata_update_failed",
      run_id: runId,
      msg: error.message,
    });
  }
}

function normalizeCivicUrl(url: string): string | null {
  const normalized = normalizeSourceUrl(url);
  return normalized && normalized.length > 0 ? normalized : null;
}
