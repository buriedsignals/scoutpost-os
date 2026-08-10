/**
 * scout-web-execute Edge Function — synchronous Page Scout pipeline.
 *
 * Called internally by execute-scout. Must complete within ~50s. Flow:
 *   1. Load scout.
 *   2. Create (or reuse) a scout_runs row with status='running'.
 *   3. Scrape the page and compare its local canonical hash baseline.
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
import {
  scrape as scrapePage,
  scrapePrimaryPageResilient,
  scrapeProvider,
} from "../_shared/scrape.ts";
import {
  type CanonicalChangeStatus,
  type CanonicalContentComparison,
  compareCanonicalContentForUrl,
} from "../_shared/canonical_baseline.ts";
import type {
  PrimaryPageScrapeOptions,
  PrimaryPageScrapeResult,
} from "../_shared/scrape_types.ts";
import { maybeInitializeMissingWebBaselineRun } from "../_shared/web_scout_baseline.ts";
import {
  type CaptureOutcome,
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
import {
  planPageScoutNotification,
  resolvePageScoutNotificationMode,
} from "../_shared/page_scout_notifications.ts";
import {
  buildPageContentDiff,
  type PageContentDiff,
  pageTargetErrorMessage,
} from "../_shared/page_scout_change.ts";
import type { PageScoutCriteriaFinding } from "../_shared/page_scout_criteria.ts";
import { analyzePageScoutAlert } from "../_shared/page_scout_alert_pipeline.ts";
import {
  applyEffectiveCandidateUrls,
  candidateUrlValuesDiffer,
  capPageScoutCandidates,
  isInitialChildBaseline,
  pageScoutCandidateKey,
  selectActiveChildCandidates,
  shouldCheckIndexChildren,
  sortCandidatesByLastCheck,
  summarizePageScoutCoverage,
} from "../_shared/page_scout_schedule.ts";
import {
  buildPageScoutSnapshotMetadata,
  pageScoutChildCaptureKind,
  pageScoutTrustDiagnostics,
  runPageScoutArchiveBatch,
  shouldShowPageScoutArchiveCta,
} from "../_shared/page_scout_archive.ts";
import {
  extractSubpageLinksFromHtml,
  extractSubpageLinksFromMarkdown,
  filterSubpageUrls,
  hasDeterministicListingSignal,
  isConfiguredPageUrl,
  isLikelyArticleUrl,
  isStrictChildUrl,
  primaryContentHtml,
  primaryContentText,
  renderIndexClassificationContent,
  selectPrimarySubpageLinks,
} from "../_shared/subpage-filter.ts";
import {
  type CanonicalUnitType,
  deriveSourceDomain,
  sha256Hex,
  upsertCanonicalUnit,
} from "../_shared/unit_dedup.ts";
import {
  WEB_CANONICALIZER_VERSION,
  WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
  webCanonicalHash,
} from "../_shared/web_content_canonical.ts";
import {
  CREDIT_COSTS,
  decrementOnceOrThrow,
  decrementOrThrow,
  InsufficientCreditsError,
  insufficientCreditsResponse,
  refundCredits,
  refundCreditsOnce,
} from "../_shared/credits.ts";
import {
  childStage,
  PageWorkflowPending,
  PageWorkflowTransport,
} from "../_shared/page_workflow_transport.ts";
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
  notification_mode: z.enum(["deliver", "disabled"]).optional().default(
    "deliver",
  ),
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
  const { scout_id, notification_mode } = parsed.data;
  let { run_id } = parsed.data;

  // 1. Load scout.
  const { data: scout, error: scoutErr } = await svc
    .from("scouts")
    .select(
      "id, user_id, type, name, url, criteria, project_id, is_active, preferred_language, baseline_established_at, archive_enabled, wayback_enabled, metadata",
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

  const { data: runState, error: runStateError } = await svc
    .from("scout_runs")
    .select("status,crawler_backend")
    .eq("id", runId)
    .single();
  if (runStateError) return jsonFromError(new Error(runStateError.message));
  if ((runState as { status: string }).status !== "running") {
    await svc.rpc("finish_waiting_scout_dispatch", { p_run_id: runId });
    return jsonOk({ status: "already_terminal", run_id: runId });
  }
  const workflowEnabled = (runState as { crawler_backend?: string })
    .crawler_backend === "workflow";
  let workflowLeaseToken: string | null = null;
  let workflowTransport: PageWorkflowTransport | null = null;
  if (workflowEnabled) {
    const { data: claim, error: claimError } = await svc.rpc(
      "claim_page_workflow_run",
      { p_run_id: runId, p_lease_seconds: 300 },
    );
    if (claimError) return jsonFromError(new Error(claimError.message));
    const row = Array.isArray(claim) ? claim[0] : claim;
    workflowLeaseToken =
      (row as { lease_token?: string } | null)?.lease_token ??
        null;
    if (!workflowLeaseToken) {
      return jsonOk({ status: "workflow_busy", run_id: runId }, 202);
    }
    workflowTransport = new PageWorkflowTransport(svc, {
      id: runId,
      scoutId: scout.id as string,
      userId: scout.user_id as string,
      tenantKey: scout.user_id as string,
    });
  }

  let chargedCredits = false;

  try {
    const baselineDeps = {
      scrape: workflowTransport
        ? async (url: string) =>
          await workflowTransport.scrape({
            url,
            workloadClass: "utility",
            timeoutMs: PRIMARY_SCRAPE_TIMEOUT_MS,
            abortAfterMs: PRIMARY_SCRAPE_ABORT_AFTER_MS,
            ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
          }, "root")
        : async (url: string, opts = {}) =>
          await scrapePage(url, {
            ...opts,
            timeoutMs: PRIMARY_SCRAPE_TIMEOUT_MS,
            abortAfterMs: PRIMARY_SCRAPE_ABORT_AFTER_MS,
          }),
      now: () => new Date().toISOString(),
    };
    const initialized = await maybeInitializeMissingWebBaselineRun(
      svc,
      scout,
      runId,
      baselineDeps,
    );
    if (initialized) {
      await mergeRunMetadata(svc, runId, {
        scrape_provider: scrapeProvider(),
        scrape_provider_served: initialized.served_by ?? scrapeProvider(),
        baseline_initialized: true,
      });
      await markRunSuccess(svc, runId, {
        unitsCreated: 0,
        unitsMerged: 0,
        criteriaStatus: false,
        notificationStatus: "not_applicable",
        sourcesScraped: 1,
        sourcesFailed: 0,
      });
      logEvent({
        level: "info",
        fn: "scout-web-execute",
        event: "baseline_initialized_on_run",
        scout_id: scout.id,
        run_id: runId,
        served_by: initialized.served_by ?? scrapeProvider(),
      });
      if (workflowEnabled && workflowLeaseToken) {
        const completed = await svc.rpc("set_page_workflow_stage", {
          p_run_id: runId,
          p_lease_token: workflowLeaseToken,
          p_stage: "done",
          p_release: true,
        });
        if (completed.error || completed.data !== true) {
          logEvent({
            level: "warn",
            fn: "scout-web-execute",
            event: "workflow_stage_completion_failed",
            scout_id: scout.id,
            run_id: runId,
          });
        }
        const finished = await svc.rpc("finish_waiting_scout_dispatch", {
          p_run_id: runId,
        });
        if (finished.error) {
          logEvent({
            level: "warn",
            fn: "scout-web-execute",
            event: "workflow_dispatch_finish_failed",
            scout_id: scout.id,
            run_id: runId,
          });
        }
        await workflowTransport?.cleanup().catch((cleanupError) =>
          logEvent({
            level: "warn",
            fn: "scout-web-execute",
            event: "workflow_result_cleanup_failed",
            scout_id: scout.id,
            run_id: runId,
            msg: cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          })
        );
      }
      return jsonOk({
        status: "ok",
        change: initialized.change_status,
        articles_count: 0,
        merged_existing_count: 0,
        sources_scraped: 1,
        sources_failed: 0,
        child_candidates: 0,
        children_checked: 0,
        coverage_complete: true,
        baseline_initialized: true,
      });
    }

    // 3. Decrement credits before any billable work.
    try {
      await markRunStage(svc, runId, "credits");
      await (workflowEnabled
        ? decrementOnceOrThrow(svc, {
          idempotencyKey: `page:${runId}:charge`,
          userId: scout.user_id,
          cost: CREDIT_COSTS.website_extraction,
          scoutId: scout.id,
          scoutType: "web",
          operation: "website_extraction",
        })
        : decrementOrThrow(svc, {
          userId: scout.user_id,
          cost: CREDIT_COSTS.website_extraction,
          scoutId: scout.id,
          scoutType: "web",
          operation: "website_extraction",
        }));
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

    const result = await runPipeline(
      svc,
      scout,
      runId,
      workflowTransport,
    );
    const effectiveNotificationMode = resolvePageScoutNotificationMode(
      notification_mode,
      scout.metadata,
    );
    const notificationPlan = planPageScoutNotification(
      result,
      effectiveNotificationMode,
    );
    const willNotify = notificationPlan.shouldSend;

    await markRunSuccess(svc, runId, {
      unitsCreated: result.articles_count,
      unitsMerged: result.merged_existing_count,
      criteriaStatus: result.criteria_ran,
      notificationStatus: notificationPlan.notificationStatus,
      sourcesScraped: result.sources_scraped,
      sourcesFailed: result.sources_failed,
    });
    await mergeRunMetadata(svc, runId, {
      page_scout_alert: {
        eligible: notificationPlan.alertEligible,
        notification_mode: effectiveNotificationMode,
        suppression_reason: notificationPlan.suppressionReason,
      },
    });
    if (result.initial_candidates_to_persist) {
      const { error } = await svc.rpc(
        "set_page_scout_initial_candidates_if_absent",
        {
          p_scout_id: scout.id,
          p_candidates: result.initial_candidates_to_persist,
        },
      );
      if (error) {
        throw new Error(
          `initial page membership persistence failed: ${error.message}`,
        );
      }
    }
    if (result.active_candidates_to_persist) {
      const { error } = await svc.rpc("set_page_scout_active_candidates", {
        p_scout_id: scout.id,
        p_candidates: result.active_candidates_to_persist,
      });
      if (error) {
        throw new Error(
          `active page membership persistence failed: ${error.message}`,
        );
      }
    }

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
      sources_scraped: result.sources_scraped,
      sources_failed: result.sources_failed,
      coverage_complete: result.coverage_complete,
      alert_eligible: notificationPlan.alertEligible,
      notification_suppressed:
        notificationPlan.suppressionReason === "test_delivery_disabled",
    });

    // Notify user when the run produced new, non-duplicate units. Criteria
    // scouts only produce units when criteria match; Any Change scouts skip
    // criteria analysis but should still alert on changed content.
    // Never throws — a mail failure must not flip the run into error.
    if (willNotify) {
      const summary = result.summary?.trim() ||
        "The monitored page content changed.";
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
          // The current CTA is scout-global, not source-specific. Preserve it
          // for root-only alerts; omit it whenever child evidence is involved.
          archiveEnabled: shouldShowPageScoutArchiveCta(
            result.alert_has_child,
            result.archiveContexts.some((context) => context.isRoot),
          ),
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

    if (workflowEnabled) {
      if (workflowLeaseToken) {
        const completed = await svc.rpc("set_page_workflow_stage", {
          p_run_id: runId,
          p_lease_token: workflowLeaseToken,
          p_stage: "done",
          p_release: true,
        });
        if (completed.error || completed.data !== true) {
          logEvent({
            level: "warn",
            fn: "scout-web-execute",
            event: "workflow_stage_completion_failed",
            scout_id: scout.id,
            run_id: runId,
          });
        }
      }
      await svc.rpc("finish_waiting_scout_dispatch", { p_run_id: runId });
      await workflowTransport?.cleanup().catch((cleanupError) =>
        logEvent({
          level: "warn",
          fn: "scout-web-execute",
          event: "workflow_result_cleanup_failed",
          scout_id: scout.id,
          run_id: runId,
          msg: cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        })
      );
    }

    // Archive capture (PAGE-ARCHIVE-PRD U3) — scheduled AFTER the run is
    // marked success and the notification is sent, so a capture fetch that
    // takes tens of seconds never delays or endangers either (R11). The row
    // and its scout_runs.metadata diagnostics land asynchronously. Dark unless
    // the scout's archive gate resolved on (KTD6).
    if (result.archiveContexts.length > 0) {
      const waybackEnabled = scoutWaybackEnabled(scout.wayback_enabled);
      runSnapshotInBackground((async () => {
        const results = await runPageScoutArchiveBatch<
          PipelineResult["archiveContexts"][number],
          CaptureOutcome
        >(result.archiveContexts, {
          capture: (context) =>
            performArchiveCapture(svc, context.ctx, context.detection),
          failureOutcome: () => ({ status: "failed:unexpected" }),
          persistDiagnostics: (items) =>
            mergeRunMetadata(
              svc,
              runId,
              buildPageScoutSnapshotMetadata(
                items.map((
                  { context, outcome, trustError, trustDiagnostics },
                ) => ({
                  sourceUrl: context.sourceUrl,
                  isRoot: context.isRoot,
                  diagnostics: {
                    ...snapshotDiagnostics(outcome),
                    ...pageScoutTrustDiagnostics(
                      trustError,
                      Boolean(outcome.stored),
                      Object.keys(trustDiagnostics).length > 0,
                    ),
                    ...trustDiagnostics,
                  },
                })),
                normalizeUrlKey,
              ),
            ),
          trust: async (_context, outcome) => {
            if (outcome.stored) {
              const trust = await applyTrustLayer(
                svc,
                outcome.stored,
                waybackEnabled,
              );
              return {
                snapshot_manifest_path: trust.manifestPath,
                snapshot_tsa_status: trust.tsaStatus,
                snapshot_tsa_path: trust.tsaPath,
                snapshot_wayback_status: trust.waybackStatus,
                snapshot_wayback_url: trust.waybackUrl,
              };
            }
            return {};
          },
        });
        for (const item of results) {
          const error = item.captureError ?? item.trustError;
          if (!error) continue;
          logEvent({
            level: "warn",
            fn: "scout-web-execute",
            event: item.captureError
              ? "archive_source_failed"
              : "trust_layer_failed",
            scout_id: scout.id,
            run_id: runId,
            source_url: item.context.sourceUrl,
            msg: error instanceof Error ? error.message : String(error),
          });
        }
        const diagnosticsError = results.find((item) =>
          item.diagnosticsError !== null
        )?.diagnosticsError;
        if (diagnosticsError) {
          logEvent({
            level: "warn",
            fn: "scout-web-execute",
            event: "archive_diagnostics_failed",
            scout_id: scout.id,
            run_id: runId,
            msg: diagnosticsError instanceof Error
              ? diagnosticsError.message
              : String(diagnosticsError),
          });
        }
      })());
    }

    return jsonOk({
      status: "ok",
      change: result.change_status,
      articles_count: result.articles_count,
      merged_existing_count: result.merged_existing_count,
      sources_scraped: result.sources_scraped,
      sources_failed: result.sources_failed,
      child_candidates: result.child_candidates,
      children_checked: result.children_checked,
      coverage_complete: result.coverage_complete,
    });
  } catch (e) {
    if (e instanceof PageWorkflowPending && workflowLeaseToken) {
      const released = await svc.rpc("set_page_workflow_stage", {
        p_run_id: runId,
        p_lease_token: workflowLeaseToken,
        p_stage: e.stage,
        p_release: true,
      });
      if (released.error || released.data !== true) {
        return jsonFromError(new Error("page workflow lease release failed"));
      }
      return jsonOk({ status: "waiting", stage: e.stage, run_id: runId }, 202);
    }
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
        await (workflowEnabled
          ? refundCreditsOnce(svc, {
            idempotencyKey: `page:${runId}:refund`,
            userId: scout.user_id as string,
            cost: CREDIT_COSTS.website_extraction,
            scoutId: scout.id as string,
            scoutType: "web",
            operation: "website_extraction",
          })
          : refundCredits(svc, {
            userId: scout.user_id as string,
            cost: CREDIT_COSTS.website_extraction,
            scoutId: scout.id as string,
            scoutType: "web",
            operation: "website_extraction",
          }));
      }
      if (workflowEnabled) {
        await svc.rpc("finish_waiting_scout_dispatch", { p_run_id: runId });
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
  preferred_language: string | null;
  baseline_established_at?: string | null;
  archive_enabled?: boolean | null;
  wayback_enabled?: boolean | null;
  metadata?: Record<string, unknown> | null;
}

interface PipelineResult {
  change_status: "new" | "same" | "changed" | "removed";
  alert_eligible: boolean;
  articles_count: number;
  merged_existing_count: number;
  criteria_ran: boolean;
  sources_scraped: number;
  sources_failed: number;
  coverage_complete: boolean;
  child_candidates: number;
  children_checked: number;
  summary?: string;
  matchedUrl?: string | null;
  matchedTitle?: string | null;
  matchedSummary?: string | null;
  rawHtml?: string | null;
  alert_has_child: boolean;
  initial_candidates_to_persist?: string[];
  active_candidates_to_persist?: string[];
  /** One independently bound context per changed source. Handed to background
   * capture only after run + notification finalization. */
  archiveContexts: Array<{
    sourceUrl: string;
    isRoot: boolean;
    detection: PrimaryPageScrapeResult;
    ctx: CaptureStoreContext;
  }>;
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
  workflowTransport: PageWorkflowTransport | null = null,
): Promise<PipelineResult> {
  await markRunStage(svc, runId, "scrape");
  // Stamp which scrape backend serves this run (firecrawl | crawl4ai) so the
  // weekly scoreboard can attribute primary and compatibility-mode results.
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
  let markdown: string;
  let changeStatus: CanonicalChangeStatus;
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

  const primaryOptions = {
    url: scout.url,
    workloadClass: "scout",
    timeoutMs: PRIMARY_SCRAPE_TIMEOUT_MS,
    abortAfterMs: PRIMARY_SCRAPE_ABORT_AFTER_MS,
    snapshot: snapshotHint,
    ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
  } satisfies PrimaryPageScrapeOptions;
  const fresh = workflowTransport
    ? await workflowTransport.scrape(primaryOptions, "root")
    : await scrapePrimaryPageResilient(primaryOptions);
  detectionResult = fresh;
  markdown = fresh.markdown ?? "";
  rawHtml = fresh.rawHtml ?? null;
  scrapeTitle = fresh.title ?? null;
  scrapeMetadata = fresh.metadata;
  scrapeStrategy = fresh.scrape_strategy;
  scrapeWarning = fresh.scrape_warning;
  servedBy = fresh.served_by;
  changeStatus = "new";

  const rootStatusError = pageTargetErrorMessage(
    detectionResult?.status_code,
  );
  if (rootStatusError) {
    throw new ApiError(rootStatusError, 502);
  }

  const effectiveRootUrl = chooseSubpageSourceUrl(
    detectionResult?.source_url,
    scout.url,
  );
  if (!isConfiguredPageUrl(effectiveRootUrl, scout.url)) {
    throw new ApiError(
      "page scrape resolved outside the configured URL",
      502,
    );
  }

  // The local per-source canonical baseline is the sole alert authority.
  const rootComparison: CanonicalContentComparison =
    await compareCanonicalContentForUrl(svc, scout.id, markdown, {
      sourceUrl: scout.url,
      fn: "scout-web-execute",
    });
  changeStatus = rootComparison.status;
  const rootDiff: PageContentDiff = rootComparison.previousMarkdown === null
    ? buildPageContentDiff("", markdown)
    : buildPageContentDiff(rootComparison.previousMarkdown, markdown);

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

  const htmlLinks = rawHtml?.trim()
    ? extractSubpageLinksFromHtml(primaryContentHtml(rawHtml), scout.url)
    : [];
  const markdownLinks = markdown.trim()
    ? extractSubpageLinksFromMarkdown(markdown, scout.url)
    : [];
  const phaseBLinks = selectPrimarySubpageLinks(htmlLinks, markdownLinks, {
    hasRenderedHtml: Boolean(rawHtml?.trim()),
  });
  const classificationContent = renderIndexClassificationContent(
    rawHtml?.trim() ? primaryContentText(rawHtml) : markdown,
    phaseBLinks,
  );
  if (htmlLinks.length > 0 || markdownLinks.length > 0) {
    logEvent({
      level: "info",
      fn: "scout-web-execute",
      event: "phase_b_primary_candidate_surface",
      scout_id: scout.id,
      run_id: runId,
      html_links: htmlLinks.length,
      markdown_links: markdownLinks.length,
      selected_source: htmlLinks.length > 0 && markdownLinks.length > 0
        ? "primary_html_plus_markdown"
        : htmlLinks.length > 0
        ? "primary_html"
        : "markdown",
      candidates: phaseBLinks.length,
    });
  }
  const discoveredPhaseBCandidates = phaseBLinks.length > 0
    ? filterSubpageUrls(phaseBLinks.map(([url]) => url), scout.url)
    : [];
  const legacyKnownChildUrls = await loadKnownChildUrls(
    svc,
    scout.id,
    scout.url,
  );
  const persistedActiveCandidates = pageScoutCandidatesFromMetadata(
    scout.metadata,
    "page_scout_active_candidates",
    scout.url,
  );
  const activeCandidates = persistedActiveCandidates ?? legacyKnownChildUrls;
  const phaseBCandidates = capPageScoutCandidates(
    dedupeUrls(selectActiveChildCandidates({
      discovered: discoveredPhaseBCandidates,
      knownSuccessful: activeCandidates,
      rootChanged: changeStatus !== "same",
    })),
  );
  const persistedInitialCandidates = pageScoutCandidatesFromMetadata(
    scout.metadata,
    "page_scout_initial_candidates",
    scout.url,
  );
  const priorRootCandidates = rootComparison.previousMarkdown
    ? capPageScoutCandidates(filterSubpageUrls(
      extractSubpageLinksFromMarkdown(
        rootComparison.previousMarkdown,
        scout.url,
      ).map(([url]) => url),
      scout.url,
    ))
    : [];
  // Cutover safety for pre-migration scouts: their old raw capture retained
  // markdown but not rendered HTML. Seed the first durable membership from the
  // conservative union so an HTML-only child that was already present before
  // rollout cannot be fabricated as a post-activation addition.
  const legacyInitialCandidates = capPageScoutCandidates(dedupeUrls([
    ...phaseBCandidates,
    ...priorRootCandidates,
  ]));
  const initialCandidatesToPersist = persistedInitialCandidates === null
    ? legacyInitialCandidates
    : undefined;
  const initialRootCandidates = new Set(
    (persistedInitialCandidates ?? legacyInitialCandidates).map(
      normalizeUrlKey,
    ),
  );
  await mergeRunMetadata(svc, runId, {
    page_scout_candidates: phaseBCandidates,
    page_scout_candidates_truncated:
      discoveredPhaseBCandidates.length > phaseBCandidates.length,
  });
  const deterministicListingPage = hasDeterministicListingSignal(
    scout.url,
    discoveredPhaseBCandidates,
  );
  const knownIndexPage = changeStatus === "same" && activeCandidates.length > 0;
  const shouldCheckChildren = shouldCheckIndexChildren({
    deterministicListing: deterministicListingPage,
    knownChildCount: activeCandidates.length,
    discoveredChildCount: discoveredPhaseBCandidates.length,
  });

  if (changeStatus === "same" && !shouldCheckChildren) {
    if (markdown.trim()) {
      const contentHash = await sha256Hex(markdown);
      await insertRawCapture(svc, {
        scout,
        runId,
        sourceUrl: scout.url,
        sourceDomain: deriveSourceDomain(scout.url),
        markdown,
        contentHash,
        workflowEffectKey: workflowTransport
          ? `page:${runId}:root:${normalizeUrlKey(scout.url)}`
          : null,
      });
    }
    await mergeRunMetadata(svc, runId, {
      page_scout_coverage: {
        child_candidates: 0,
        children_checked: 0,
        sources_scraped: 1,
        sources_failed: 0,
        coverage_complete: true,
      },
    });
    return {
      change_status: "same",
      alert_eligible: false,
      articles_count: 0,
      merged_existing_count: 0,
      criteria_ran: false,
      sources_scraped: 1,
      sources_failed: 0,
      coverage_complete: true,
      child_candidates: 0,
      children_checked: 0,
      alert_has_child: false,
      initial_candidates_to_persist: initialCandidatesToPersist,
      archiveContexts: [],
    };
  }

  if (!markdown.trim()) {
    throw new ApiError("page scrape returned empty markdown", 502);
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
    workflowEffectKey: workflowTransport
      ? `page:${runId}:root:${normalizeUrlKey(scout.url)}`
      : null,
  });

  // Archive capture context (R4): built only for gated changed/new runs.
  // 'same' returned earlier; 'removed' (page gone) has nothing to capture.
  // The capture itself runs in the background after the run finalizes (below),
  // binding to the exact detection markdown that fired (KTD4/Decision 10).
  const rootArchiveContext = (archiveGateOn && detectionResult &&
      (changeStatus === "changed" || changeStatus === "new"))
    ? {
      sourceUrl: scout.url,
      isRoot: true,
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
        allowedExactUrl: scout.url,
      } satisfies CaptureStoreContext,
    }
    : undefined;

  // 5. Classify/enrich the page. Criteria matching is a separate pass over the
  // normalized delta below; unchanged matching text on the full page must not
  // turn an unrelated edit into an alert.
  await markRunStage(svc, runId, "extract");
  const hasCriteria = !!scout.criteria?.trim();

  const extracted = deterministicListingPage || knownIndexPage
    ? {
      units: [],
      isListingPage: true,
      diagnostics: {
        outcome: "empty" as const,
        raw_units: 0,
        valid_units: 0,
        returned_units: 0,
        error_code: null,
      },
    }
    : await extractAtomicUnits({
      title: scrape.title ?? null,
      content: classificationContent,
      sourceUrl: scout.url,
      publishedDate: primaryPublishedDate,
      language:
        (scout as { preferred_language?: string | null }).preferred_language ??
          "en",
      criteria: null,
      maxUnits: 8,
      contentLimit: PROMPT_CONTENT_MAX,
      timeoutMs: PRIMARY_EXTRACTION_TIMEOUT_MS,
      usage: {
        db: svc,
        userId: scout.user_id,
        scoutId: scout.id,
        runId,
        functionName: "scout-web-execute",
        operation: "web_classify_primary",
      },
    });
  await mergeRunMetadata(svc, runId, {
    extraction_primary: extracted.diagnostics,
  });
  const indexIsListingPage = deterministicListingPage || knownIndexPage ||
    (extracted.diagnostics.outcome !== "failed" && extracted.isListingPage);
  if (workflowTransport && indexIsListingPage && phaseBCandidates.length > 0) {
    const orderedChildren = await orderCandidatesByOldestCheck(
      svc,
      scout.id,
      phaseBCandidates,
    );
    await workflowTransport.prepareChildren(
      orderedChildren.slice(0, SUBPAGE_FETCH_CAP),
      SUBPAGE_SCRAPE_TIMEOUT_MS,
    );
  }
  const activeMembershipChanged = persistedActiveCandidates === null ||
    dedupeUrls(persistedActiveCandidates).map(normalizeUrlKey).join("\n") !==
      phaseBCandidates.map(normalizeUrlKey).join("\n");
  let activeCandidatesToPersist = indexIsListingPage &&
      (changeStatus !== "same" || activeMembershipChanged)
    ? phaseBCandidates
    : undefined;
  if (
    changeStatus !== "same" &&
    !indexIsListingPage &&
    extracted.diagnostics.outcome !== "failed"
  ) {
    activeCandidatesToPersist = [];
  }

  const rootAnalysis = await analyzePageScoutAlert({
    criteria: scout.criteria,
    diff: rootDiff,
    changeStatus,
    initialBaseline: changeStatus === "new",
    timeoutMs: PRIMARY_EXTRACTION_TIMEOUT_MS,
    usage: {
      db: svc,
      userId: scout.user_id,
      scoutId: scout.id,
      runId,
      functionName: "scout-web-execute",
      operation: "web_match_primary_delta",
    },
  }, {
    enrichMatchingDelta: ({ delta }) =>
      extractAtomicUnits({
        title: scrape.title ?? null,
        content: delta,
        sourceUrl: scout.url,
        publishedDate: primaryPublishedDate,
        language: scout.preferred_language ?? "en",
        criteria: scout.criteria,
        maxUnits: 8,
        contentLimit: PROMPT_CONTENT_MAX,
        timeoutMs: PRIMARY_EXTRACTION_TIMEOUT_MS,
        usage: {
          db: svc,
          userId: scout.user_id,
          scoutId: scout.id,
          runId,
          functionName: "scout-web-execute",
          operation: "web_enrich_primary_delta",
        },
      }),
  });
  const rootCriteriaDecision = rootAnalysis.criteriaDecision;
  const rootCriteriaEnrichment = rootAnalysis.enrichment;
  await mergeRunMetadata(svc, runId, {
    criteria_primary_delta: rootCriteriaDecision ?? null,
    extraction_primary_delta: rootCriteriaEnrichment?.diagnostics ?? null,
  });
  const rootAlertEligible = rootAnalysis.alertEligible;
  let alertEligible = rootAlertEligible;
  let alertHasChild = false;
  const alertDiffSummaries: string[] = rootAlertEligible
    ? [
      hasCriteria
        ? renderCriteriaFindings(
          scout.url,
          rootCriteriaDecision?.acceptedFindings ?? [],
        )
        : `${scout.url}\n${rootDiff.summary || "The page content changed."}`,
    ]
    : [];
  const archiveContexts: PipelineResult["archiveContexts"] = rootArchiveContext
    ? [rootArchiveContext]
    : [];

  if (indexIsListingPage && !rawHtml?.trim()) {
    logEvent({
      level: "info",
      fn: "scout-web-execute",
      event: "phase_b_markdown_discovery_fallback",
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
  const childCandidates = indexIsListingPage ? phaseBCandidates.length : 0;
  let childrenChecked = 0;
  let sourcesScraped = 1;
  let sourcesFailed = 0;
  let coverageComplete = childCandidates === 0;

  // Hard gate: listing pages yield no Phase A units — full articles come via Phase B.
  const primaryUnits = hasCriteria
    ? (rootCriteriaEnrichment?.units ?? [])
    : extracted.units;
  const phaseAUnits = indexIsListingPage ? [] : withHeadlineFallback(
    primaryUnits,
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
        initialRootCandidates,
        archiveGateOn,
        Date.now() + PHASE_B_TOTAL_BUDGET_MS,
        workflowTransport,
      );
      inserted += subpageResult.totalInserted;
      mergedExisting += subpageResult.totalMergedExisting;
      childrenChecked = subpageResult.attempted;
      const coverage = summarizePageScoutCoverage({
        childCandidates: subpageResult.candidates,
        childrenAttempted: subpageResult.attempted,
        childrenScraped: subpageResult.scraped,
        childrenFailed: subpageResult.failed,
      });
      sourcesScraped = coverage.sourcesScraped;
      sourcesFailed = coverage.sourcesFailed;
      coverageComplete = coverage.coverageComplete;
      for (const statement of subpageResult.insertedStatements) {
        if (insertedStatements.length >= 3) break;
        insertedStatements.push(statement);
      }
      if (!matchedUrl && subpageResult.firstMatchedUrl) {
        matchedUrl = subpageResult.firstMatchedUrl;
        matchedTitle = subpageResult.firstMatchedTitle ?? null;
        matchedSummary = subpageResult.firstMatchedSummary ?? null;
      }
      if (subpageResult.alertEligible) {
        alertEligible = true;
        alertHasChild = true;
        alertDiffSummaries.push(...subpageResult.alertSummaries);
      }
      archiveContexts.push(...subpageResult.archiveContexts);
      if (subpageResult.effectiveUrls.length > 0) {
        const canonicalActiveCandidates = applyEffectiveCandidateUrls(
          phaseBCandidates,
          subpageResult.effectiveUrls,
          normalizeUrlKey,
        );
        if (
          candidateUrlValuesDiffer(
            phaseBCandidates,
            canonicalActiveCandidates,
          )
        ) {
          activeCandidatesToPersist = canonicalActiveCandidates;
        }
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
        coverage_complete: coverageComplete,
        units_inserted: subpageResult.totalInserted,
        units_merged_existing: subpageResult.totalMergedExisting,
      });
    } catch (error) {
      sourcesFailed += 1;
      coverageComplete = false;
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

  await mergeRunMetadata(svc, runId, {
    page_scout_coverage: {
      root_url: scout.url,
      child_candidates: childCandidates,
      children_checked: childrenChecked,
      sources_scraped: sourcesScraped,
      sources_failed: sourcesFailed,
      coverage_complete: coverageComplete,
    },
  });

  // Build a short summary for the notification email from the first few
  // statements (bulleted if 2+). Matches legacy summary shape.
  const extractedSummary = insertedStatements.length === 1
    ? insertedStatements[0]
    : insertedStatements.map((s) => `- ${s}`).join("\n");
  const summary = alertDiffSummaries.length > 0
    ? alertDiffSummaries.join("\n\n")
    : extractedSummary;

  return {
    change_status: scrape.change_status,
    alert_eligible: alertEligible,
    articles_count: inserted,
    merged_existing_count: mergedExisting,
    criteria_ran: hasCriteria,
    sources_scraped: sourcesScraped,
    sources_failed: sourcesFailed,
    coverage_complete: coverageComplete,
    child_candidates: childCandidates,
    children_checked: childrenChecked,
    summary: summary || undefined,
    matchedUrl,
    matchedTitle,
    matchedSummary,
    alert_has_child: alertHasChild,
    archiveContexts,
    initial_candidates_to_persist: initialCandidatesToPersist,
    active_candidates_to_persist: activeCandidatesToPersist,
  };
}

// =========================================================================
// Phase B helpers
// =========================================================================

function renderCriteriaFindings(
  sourceUrl: string,
  findings: PageScoutCriteriaFinding[],
): string {
  return [
    sourceUrl,
    ...findings.slice(0, 3).map((finding) =>
      [
        `**What changed:** ${escapeMarkdown(finding.explanation)}`,
        `**Criterion:** ${escapeMarkdown(finding.criterion)}`,
        finding.beforeQuote
          ? `**Before:** ${escapeMarkdown(finding.beforeQuote)}`
          : "",
        finding.afterQuote
          ? `**After:** ${escapeMarkdown(finding.afterQuote)}`
          : "",
      ].filter(Boolean).join("\n")
    ),
  ].join("\n\n");
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>()#+.!|-]/g, "\\$&");
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
): string {
  const source = scrapeSourceUrl?.trim();
  return source || requestedSubUrl;
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

function normalizeUrlKey(url: string): string {
  return pageScoutCandidateKey(url);
}

function dedupeUrls(urls: string[]): string[] {
  return [...new Map(urls.map((url) => [normalizeUrlKey(url), url])).values()];
}

async function loadKnownChildUrls(
  svc: SupabaseClient,
  scoutId: string,
  rootUrl: string,
): Promise<string[]> {
  const { data, error } = await svc
    .from("raw_captures")
    .select("source_url, captured_at, scout_run_id")
    .eq("scout_id", scoutId)
    .not("canonical_content_sha256", "is", null)
    .order("captured_at", { ascending: false })
    .limit(500);
  if (error) {
    throw new Error(`known child baseline lookup failed: ${error.message}`);
  }
  if (!data) return [];
  const rows = data as Array<{
    source_url?: string | null;
    scout_run_id?: string | null;
  }>;
  const runIds = rows
    .map((row) => row.scout_run_id)
    .filter((id): id is string => typeof id === "string" && !!id);
  let successfulRunIds = new Set<string>();
  if (runIds.length > 0) {
    const { data: runs, error: runsError } = await svc
      .from("scout_runs")
      .select("id, status")
      .in("id", [...new Set(runIds)]);
    if (runsError) {
      throw new Error(
        `known child run-status lookup failed: ${runsError.message}`,
      );
    }
    successfulRunIds = new Set(
      ((runs ?? []) as Array<{ id: string; status: string | null }>)
        .filter((run) => run.status === "success")
        .map((run) => run.id),
    );
  }
  return dedupeUrls(
    rows
      .filter((row) =>
        !row.scout_run_id || successfulRunIds.has(row.scout_run_id)
      )
      .map((row) => row.source_url?.trim() ?? "")
      .filter((url) => !!url && isStrictChildUrl(url, rootUrl)),
  );
}

function pageScoutCandidatesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key:
    | "page_scout_initial_candidates"
    | "page_scout_active_candidates",
  rootUrl: string,
): string[] | null {
  const candidates = metadata?.[key];
  if (!Array.isArray(candidates)) return null;
  return dedupeUrls(
    candidates
      .filter((url): url is string => typeof url === "string")
      .filter((url) => isStrictChildUrl(url, rootUrl)),
  );
}

async function orderCandidatesByOldestCheck(
  svc: SupabaseClient,
  scoutId: string,
  candidateUrls: string[],
): Promise<string[]> {
  const { data, error } = await svc
    .from("raw_captures")
    .select("source_url, captured_at")
    .eq("scout_id", scoutId)
    .not("canonical_content_sha256", "is", null)
    .order("captured_at", { ascending: false })
    .limit(1000);
  if (error) {
    throw new Error(`child capture schedule lookup failed: ${error.message}`);
  }
  const latest = new Map<string, number>();
  for (
    const row of (data ?? []) as Array<{
      source_url?: string | null;
      captured_at?: string | null;
    }>
  ) {
    if (!row.source_url) continue;
    const key = normalizeUrlKey(row.source_url);
    const at = Date.parse(row.captured_at ?? "");
    const previous = latest.get(key);
    if (!Number.isNaN(at) && (previous === undefined || at > previous)) {
      latest.set(key, at);
    }
  }
  const { data: runs, error: runsError } = await svc
    .from("scout_runs")
    .select("started_at, metadata")
    .eq("scout_id", scoutId)
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(100);
  if (runsError) {
    throw new Error(
      `child attempt schedule lookup failed: ${runsError.message}`,
    );
  }
  const attempts = new Map<string, number>();
  for (
    const row of (runs ?? []) as Array<{
      started_at?: string | null;
      metadata?: unknown;
    }>
  ) {
    if (!row.metadata || typeof row.metadata !== "object") continue;
    const attempt = (row.metadata as Record<string, unknown>)
      .page_scout_child_attempts;
    if (!attempt || typeof attempt !== "object") continue;
    const urls = (attempt as Record<string, unknown>).urls;
    const explicitAt = (attempt as Record<string, unknown>).attempted_at;
    const at = Date.parse(
      typeof explicitAt === "string" ? explicitAt : row.started_at ?? "",
    );
    if (!Array.isArray(urls) || Number.isNaN(at)) continue;
    for (const url of urls) {
      if (typeof url !== "string") continue;
      const key = normalizeUrlKey(url);
      if (!attempts.has(key)) attempts.set(key, at);
    }
  }
  return sortCandidatesByLastCheck(
    candidateUrls,
    latest,
    attempts,
    normalizeUrlKey,
  );
}

async function loadArchivedChildUrls(
  svc: SupabaseClient,
  scoutId: string,
  rootUrl: string,
): Promise<Set<string>> {
  const { data, error } = await svc
    .from("page_snapshots")
    .select("requested_url")
    .eq("scout_id", scoutId)
    .limit(1000);
  if (error || !data) return new Set();
  return new Set(
    (data as Array<{ requested_url?: string | null }>)
      .map((row) => row.requested_url?.trim() ?? "")
      .filter((url) => !!url && isStrictChildUrl(url, rootUrl))
      .map(normalizeUrlKey),
  );
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
  initialRootCandidates: Set<string>,
  archiveGateOn: boolean,
  deadlineMs: number,
  workflowTransport: PageWorkflowTransport | null = null,
): Promise<{
  linksFound: number;
  candidates: number;
  fresh: number;
  scraped: number;
  attempted: number;
  processed: number;
  nestedListings: number;
  failed: number;
  totalInserted: number;
  totalMergedExisting: number;
  insertedStatements: string[];
  firstMatchedUrl: string | null;
  firstMatchedTitle: string | null;
  firstMatchedSummary: string | null;
  alertEligible: boolean;
  alertSummaries: string[];
  effectiveUrls: Array<{ requested: string; effective: string }>;
  archiveContexts: PipelineResult["archiveContexts"];
}> {
  // Rotate by the oldest per-source capture, not unit occurrences. A child
  // that extracts zero or fully deduplicated units still advances its turn.
  const ordered = await orderCandidatesByOldestCheck(
    svc,
    scout.id,
    candidateUrls,
  );
  const known = new Set((await loadKnownChildUrls(svc, scout.id, scout.url))
    .map(normalizeUrlKey));
  const fresh = ordered.filter((url) => !known.has(normalizeUrlKey(url)));
  const processable = ordered.slice(0, SUBPAGE_FETCH_CAP);

  let totalInserted = 0;
  let totalMergedExisting = 0;
  let scraped = 0;
  let processed = 0;
  let nestedListings = 0;
  let failed = 0;
  const insertedStatements: string[] = [];
  let firstMatchedUrl: string | null = null;
  let firstMatchedTitle: string | null = null;
  let firstMatchedSummary: string | null = null;
  let alertEligible = false;
  const alertSummaries: string[] = [];
  const archiveContexts: PipelineResult["archiveContexts"] = [];
  const processedEffectiveUrls = new Set<string>();
  const effectiveUrls: Array<{ requested: string; effective: string }> = [];
  const attemptedUrls: string[] = [];
  const archivedChildUrls = archiveGateOn
    ? await loadArchivedChildUrls(svc, scout.id, scout.url)
    : new Set<string>();

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
    attemptedUrls.push(subUrl);
    if (i > 0 && !workflowTransport) {
      await new Promise((r) => setTimeout(r, FIRECRAWL_STAGGER_MS));
    }

    try {
      const subpageOptions = {
        url: subUrl,
        workloadClass: "scout",
        timeoutMs: SUBPAGE_SCRAPE_TIMEOUT_MS,
        abortAfterMs: SUBPAGE_SCRAPE_ABORT_AFTER_MS,
        snapshot: archiveGateOn ? "on_fallback" : undefined,
        ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
      } satisfies PrimaryPageScrapeOptions;
      const subScrape = workflowTransport
        ? await workflowTransport.scrape(
          subpageOptions,
          childStage(subUrl),
        )
        : await scrapePrimaryPageResilient(subpageOptions);

      const subpageStatusError = pageTargetErrorMessage(
        subScrape.status_code,
      );
      if (subpageStatusError) {
        failed++;
        logEvent({
          level: "warn",
          fn: "scout-web-execute",
          event: "phase_b_target_error_status",
          scout_id: scout.id,
          requested_url: subUrl,
          upstream_status: subScrape.status_code,
        });
        continue;
      }
      if (!subScrape.markdown?.trim()) {
        failed++;
        continue;
      }
      scraped++;
      const chosenSubpageSourceUrl = chooseSubpageSourceUrl(
        subScrape.source_url,
        subUrl,
      );
      const subSourceUrl = normalizeComparableUrl(chosenSubpageSourceUrl) ??
        chosenSubpageSourceUrl;
      // Provider redirects are untrusted scope changes. Validate the effective
      // URL before comparison, persistence, extraction, archiving, or alerting.
      if (!isStrictChildUrl(subSourceUrl, scout.url)) {
        failed++;
        logEvent({
          level: "warn",
          fn: "scout-web-execute",
          event: "phase_b_effective_url_out_of_scope",
          scout_id: scout.id,
          requested_url: subUrl,
          effective_url: subSourceUrl,
        });
        continue;
      }
      const effectiveKey = normalizeUrlKey(subSourceUrl);
      if (processedEffectiveUrls.has(effectiveKey)) continue;
      processedEffectiveUrls.add(effectiveKey);
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

      if (!articleDocument && !deterministicArticle) {
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
      effectiveUrls.push({ requested: subUrl, effective: subSourceUrl });

      const comparison = await compareCanonicalContentForUrl(
        svc,
        scout.id,
        subScrape.markdown,
        { sourceUrl: subSourceUrl, fn: "scout-web-execute" },
      );
      const subDiff = comparison.previousMarkdown === null
        ? buildPageContentDiff("", subScrape.markdown)
        : buildPageContentDiff(
          comparison.previousMarkdown,
          subScrape.markdown,
        );
      const initialChildBaseline = isInitialChildBaseline({
        status: comparison.status,
        requestedUrl: subUrl,
        effectiveUrl: subSourceUrl,
        initialRootCandidates,
        normalize: normalizeUrlKey,
      });
      const hasCriteria = Boolean(scout.criteria?.trim());

      // Specific Changes cannot advance its successful baseline when the
      // required structured delta decision fails. Unit extraction is optional
      // enrichment and happens only after that decision.
      const subAnalysis = await analyzePageScoutAlert({
        criteria: scout.criteria,
        diff: subDiff,
        changeStatus: comparison.status,
        initialBaseline: initialChildBaseline,
        timeoutMs: SUBPAGE_EXTRACTION_TIMEOUT_MS,
        usage: {
          db: svc,
          userId: scout.user_id,
          scoutId: scout.id,
          runId,
          functionName: "scout-web-execute",
          operation: "web_match_subpage_delta",
        },
      });
      const criteriaDecision = subAnalysis.criteriaDecision;

      const subContentHash = await sha256Hex(subScrape.markdown);
      const subRawCaptureId = await insertRawCapture(svc, {
        scout,
        runId,
        sourceUrl: subSourceUrl,
        sourceDomain: subSourceDomain,
        markdown: subScrape.markdown,
        contentHash: subContentHash,
        workflowEffectKey: workflowTransport
          ? `page:${runId}:child:${normalizeUrlKey(subSourceUrl)}`
          : null,
      });

      const childWasArchived = archivedChildUrls.has(effectiveKey);
      const captureKind = archiveGateOn
        ? pageScoutChildCaptureKind({
          status: comparison.status,
          initialBaseline: initialChildBaseline,
          alreadyArchived: childWasArchived,
        })
        : null;
      if (captureKind) {
        archiveContexts.push({
          sourceUrl: subSourceUrl,
          isRoot: false,
          detection: { ...subScrape, source_url: subSourceUrl },
          ctx: {
            scoutId: scout.id,
            userId: scout.user_id,
            scoutRunId: runId,
            rawCaptureId: subRawCaptureId,
            captureKind,
            requestedUrl: subSourceUrl,
            fallbackMarkdown: subScrape.markdown,
            contentSha256: subContentHash,
            canonicalContentSha256: await webCanonicalHash(subScrape.markdown),
            allowedScopeRootUrl: scout.url,
            allowedExactUrl: subSourceUrl,
          },
        });
        archivedChildUrls.add(effectiveKey);
      }

      if (comparison.status === "same" || initialChildBaseline) {
        processed++;
        continue;
      }

      let subExtracted = hasCriteria
        ? criteriaDecision?.matches
          ? await extractAtomicUnits({
            title: subScrape.title ?? null,
            content: subAnalysis.criteriaDelta,
            sourceUrl: subSourceUrl,
            publishedDate: subPublishedDate,
            language: scout.preferred_language ?? "en",
            criteria: scout.criteria,
            maxUnits: 8,
            contentLimit: PROMPT_CONTENT_MAX,
            timeoutMs: SUBPAGE_EXTRACTION_TIMEOUT_MS,
            usage: {
              db: svc,
              userId: scout.user_id,
              scoutId: scout.id,
              runId,
              functionName: "scout-web-execute",
              operation: "web_extract_subpage_delta",
            },
          })
          : null
        : await extractAtomicUnits({
          title: subScrape.title ?? null,
          content: subAnalysis.criteriaDelta,
          sourceUrl: subSourceUrl,
          publishedDate: subPublishedDate,
          language: scout.preferred_language ?? "en",
          criteria: hasCriteria ? scout.criteria : null,
          maxUnits: 8,
          contentLimit: PROMPT_CONTENT_MAX,
          timeoutMs: SUBPAGE_EXTRACTION_TIMEOUT_MS,
          usage: {
            db: svc,
            userId: scout.user_id,
            scoutId: scout.id,
            runId,
            functionName: "scout-web-execute",
            operation: "web_extract_subpage_delta",
          },
        });
      if (subExtracted?.diagnostics.outcome === "failed") {
        logEvent({
          level: "warn",
          fn: "scout-web-execute",
          event: "phase_b_optional_enrichment_failed",
          scout_id: scout.id,
          url: subSourceUrl,
          error_code: subExtracted.diagnostics.error_code,
        });
        subExtracted = null;
      }

      const childAlertEligible = subAnalysis.alertEligible;
      if (childAlertEligible) {
        alertEligible = true;
        alertSummaries.push(
          hasCriteria
            ? renderCriteriaFindings(
              subSourceUrl,
              criteriaDecision?.acceptedFindings ?? [],
            )
            : `${subSourceUrl}\n${
              subDiff.summary || "The page content changed."
            }`,
        );
        if (!firstMatchedUrl) {
          firstMatchedUrl = subSourceUrl;
          firstMatchedTitle = subScrape.title ?? null;
          firstMatchedSummary = subDiff.summary || null;
        }
      }

      const subUnits = subExtracted?.units ?? [];
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

  if (attemptedUrls.length > 0) {
    await mergeRunMetadata(svc, runId, {
      page_scout_child_attempts: {
        attempted_at: new Date().toISOString(),
        urls: attemptedUrls.map(normalizeUrlKey),
      },
    });
  }

  return {
    linksFound: links.length,
    candidates: candidateUrls.length,
    fresh: fresh.length,
    scraped,
    attempted: attemptedUrls.length,
    processed,
    nestedListings,
    failed,
    totalInserted,
    totalMergedExisting,
    insertedStatements,
    firstMatchedUrl,
    firstMatchedTitle,
    firstMatchedSummary,
    alertEligible,
    alertSummaries,
    effectiveUrls,
    archiveContexts,
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
    workflowEffectKey?: string | null;
  },
): Promise<string> {
  if (input.workflowEffectKey) {
    const existing = await svc.from("raw_captures")
      .select("id")
      .eq("workflow_effect_key", input.workflowEffectKey)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data?.id) return existing.data.id as string;
  }
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
      workflow_effect_key: input.workflowEffectKey ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return capture.id as string;
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
