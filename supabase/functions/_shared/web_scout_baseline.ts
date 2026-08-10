import type { SupabaseClient } from "./supabase.ts";
import type { ScrapeResult } from "./scrape_types.ts";
import { ValidationError } from "./errors.ts";
import { scrape as portScrape } from "./scrape.ts";
import { logEvent } from "./log.ts";
import { sha256Hex } from "./unit_dedup.ts";
import {
  hasCurrentCanonicalBaselineForUrl,
  writeCanonicalBaseline,
} from "./canonical_baseline.ts";
import {
  WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
  webCanonicalHash,
} from "./web_content_canonical.ts";
import {
  type CaptureOutcome,
  performArchiveCapture,
  resolveArchiveGate,
} from "./snapshot_capture.ts";
import { applyTrustLayer, scoutWaybackEnabled } from "./trust.ts";
import {
  extractSubpageLinksFromHtml,
  extractSubpageLinksFromMarkdown,
  filterSubpageUrls,
  isConfiguredPageUrl,
  primaryContentHtml,
  selectPrimarySubpageLinks,
} from "./subpage-filter.ts";
import { capPageScoutCandidates } from "./page_scout_schedule.ts";

export interface WebBaselineScout {
  id: string;
  user_id: string;
  url?: string | null;
  baseline_established_at?: string | null;
  name?: string | null;
  /** Archive gate (KTD6). Present so baseline snapshot capture can be
   * gated without a second scout read. */
  archive_enabled?: boolean | null;
  /** Per-scout Wayback opt-out (KTD5), threaded to the baseline trust layer. */
  wayback_enabled?: boolean | null;
}

interface WebBaselineDeps {
  /** The provider-agnostic scrape port — the live canonical-hash baseline
   * routes through this (crawl4ai in prod, Firecrawl anti-bot fallback). */
  scrape: typeof portScrape;
  hasCurrentCanonicalBaseline?: typeof hasCurrentCanonicalBaselineForUrl;
  now: () => string;
  resolveArchiveGate?: typeof resolveArchiveGate;
  performArchiveCapture?: typeof performArchiveCapture;
  applyTrustLayer?: typeof applyTrustLayer;
}

const DEFAULT_DEPS: WebBaselineDeps = {
  scrape: portScrape,
  hasCurrentCanonicalBaseline: hasCurrentCanonicalBaselineForUrl,
  now: () => new Date().toISOString(),
  resolveArchiveGate,
  performArchiveCapture,
  applyTrustLayer,
};

function baselineChildCandidates(
  scrape: ScrapeResult,
  rootUrl: string,
): string[] {
  const rawHtml = scrape.rawHtml?.trim() ?? "";
  const htmlLinks = rawHtml
    ? extractSubpageLinksFromHtml(primaryContentHtml(rawHtml), rootUrl)
    : [];
  const markdownLinks = scrape.markdown?.trim()
    ? extractSubpageLinksFromMarkdown(scrape.markdown, rootUrl)
    : [];
  return capPageScoutCandidates(filterSubpageUrls(
    selectPrimarySubpageLinks(htmlLinks, markdownLinks, {
      hasRenderedHtml: Boolean(rawHtml),
    }).map(([url]) => url),
    rootUrl,
  ));
}

async function persistBaselineMembership(
  svc: SupabaseClient,
  scoutId: string,
  candidates: string[],
): Promise<void> {
  const { error } = await svc.rpc(
    "set_page_scout_initial_candidates_if_absent",
    { p_scout_id: scoutId, p_candidates: candidates },
  );
  if (error) throw new Error(error.message);
}

async function stampBaseline(
  svc: SupabaseClient,
  scoutId: string,
  deps: WebBaselineDeps,
): Promise<void> {
  const { error } = await svc
    .from("scouts")
    .update({ baseline_established_at: deps.now() })
    .eq("id", scoutId);
  if (error) throw new Error(error.message);
}

export async function establishWebBaseline(
  svc: SupabaseClient,
  scout: WebBaselineScout,
  deps: WebBaselineDeps = DEFAULT_DEPS,
  scoutRunId: string | null = null,
): Promise<ScrapeResult["served_by"]> {
  if (!scout.url?.trim()) {
    throw new ValidationError("web scouts require a url before scheduling");
  }

  try {
    // Route through the provider port (Crawl4AI in prod; Firecrawl anti-bot
    // fallback for walled hosts). The raw capture is the sole change-detection
    // baseline; archive capture remains a separate background operation.
    const scrape = await deps.scrape(
      scout.url,
      { ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS, workloadClass: "utility" },
    );
    if (!isConfiguredPageUrl(scrape.source_url ?? scout.url, scout.url)) {
      throw new ValidationError(
        "page baseline scrape resolved outside the configured URL",
      );
    }
    const markdown = scrape.markdown?.trim() ?? "";
    if (!markdown) {
      throw new ValidationError(
        "unable to establish page baseline from empty content",
      );
    }
    await writeCanonicalBaseline(svc, {
      userId: scout.user_id,
      scoutId: scout.id,
      sourceUrl: scout.url,
      markdown: scrape.markdown,
      scoutRunId,
      now: deps.now(),
    });
    await persistBaselineMembership(
      svc,
      scout.id,
      baselineChildCandidates(scrape, scout.url),
    );
    await stampBaseline(svc, scout.id, deps);
    logEvent({
      level: "info",
      fn: "web-scout-baseline",
      event: "baseline_established",
      scout_id: scout.id,
      run_id: scoutRunId,
      served_by: scrape.served_by ?? "unknown",
    });
    return scrape.served_by;
  } catch (error) {
    const waitingForWorkflow = error instanceof Error &&
      error.name === "PageWorkflowPending";
    logEvent({
      level: waitingForWorkflow ? "info" : "warn",
      fn: "web-scout-baseline",
      event: waitingForWorkflow
        ? "baseline_waiting_for_workflow"
        : "baseline_establishment_failed",
      scout_id: scout.id,
      run_id: scoutRunId,
      error_class: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  }
}

interface WebBaselineEnsureResult {
  established: boolean;
  servedBy?: ScrapeResult["served_by"];
}

async function ensureWebBaselineDetailed(
  svc: SupabaseClient,
  scout: WebBaselineScout,
  deps: WebBaselineDeps,
  scoutRunId: string | null = null,
): Promise<WebBaselineEnsureResult> {
  if (!scout.url?.trim()) {
    throw new ValidationError("web scouts require a url before scheduling");
  }
  const current = await (deps.hasCurrentCanonicalBaseline ??
    hasCurrentCanonicalBaselineForUrl)(svc, scout.id, scout.url);
  if (current) {
    if (!scout.baseline_established_at) {
      await stampBaseline(svc, scout.id, deps);
    }
    logEvent({
      level: "info",
      fn: "web-scout-baseline",
      event: "baseline_reused",
      scout_id: scout.id,
      run_id: scoutRunId,
      readiness_timestamp_repaired: !scout.baseline_established_at,
    });
    return { established: false };
  }
  return {
    established: true,
    servedBy: await establishWebBaseline(svc, scout, deps, scoutRunId),
  };
}

export async function ensureWebBaseline(
  svc: SupabaseClient,
  scout: WebBaselineScout,
  deps: WebBaselineDeps = DEFAULT_DEPS,
): Promise<boolean> {
  return (await ensureWebBaselineDetailed(svc, scout, deps)).established;
}

/**
 * Baseline snapshot capture (PAGE-ARCHIVE-PRD R4, capture_kind='baseline').
 *
 * Deliberately SEPARATE from establishWebBaseline and meant to run in the
 * background (EdgeRuntime.waitUntil) off the scout-creation critical path: a
 * capture fetch can take tens of seconds and web baselines are established
 * synchronously inside the create request (unlike beat, which already
 * backgrounds baseline work to dodge the same gateway-timeout budget).
 *
 * Best-effort and gated (KTD6): a no-op when the scout is not archive-enabled
 * or the tier check fails. Never throws — captures are evidence enrichment,
 * never a reason a scout fails to come up. Uses its OWN detection scrape (with
 * the KTD9 fallback hint) so a fallback-served host lands a rendered_thirdparty
 * baseline row from that fetch's same-fetch artifacts; a crawl4ai-served host
 * triggers one provider-pinned capture fetch inside performArchiveCapture.
 */
export async function captureWebBaselineSnapshot(
  svc: SupabaseClient,
  scout: WebBaselineScout,
  deps: WebBaselineDeps = DEFAULT_DEPS,
): Promise<CaptureOutcome | null> {
  if (!scout.url?.trim()) return null;
  let gateOn: boolean;
  try {
    gateOn = await (deps.resolveArchiveGate ?? resolveArchiveGate)(svc, scout);
  } catch {
    return null;
  }
  if (!gateOn) return null;

  let detection: ScrapeResult;
  try {
    detection = await deps.scrape(scout.url, {
      ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
      workloadClass: "utility",
      snapshot: "on_fallback",
    });
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "web-scout-baseline",
      event: "baseline_capture_detection_failed",
      scout_id: scout.id,
      user_id: scout.user_id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  const markdown = detection.markdown?.trim() ?? "";
  if (!markdown) return null;
  if (!isConfiguredPageUrl(detection.source_url ?? scout.url, scout.url)) {
    logEvent({
      level: "warn",
      fn: "web-scout-baseline",
      event: "baseline_capture_out_of_scope",
      scout_id: scout.id,
      requested_url: scout.url,
      effective_url: detection.source_url ?? scout.url,
    });
    return null;
  }

  let outcome: CaptureOutcome;
  try {
    outcome = await (deps.performArchiveCapture ?? performArchiveCapture)(svc, {
      scoutId: scout.id,
      userId: scout.user_id,
      scoutRunId: null,
      rawCaptureId: null,
      captureKind: "baseline",
      requestedUrl: scout.url,
      fallbackMarkdown: detection.markdown,
      contentSha256: await sha256Hex(detection.markdown),
      canonicalContentSha256: await webCanonicalHash(detection.markdown),
      allowedExactUrl: scout.url,
    }, detection);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "web-scout-baseline",
      event: "baseline_capture_failed",
      scout_id: scout.id,
      user_id: scout.user_id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  // Trust layer (U4) — applied after the row is stored, non-fatal. Baseline
  // rows have no scout_run, so there is nothing to sequence before it here.
  if (outcome.stored) {
    try {
      await (deps.applyTrustLayer ?? applyTrustLayer)(
        svc,
        outcome.stored,
        scoutWaybackEnabled(scout.wayback_enabled),
      );
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "web-scout-baseline",
        event: "baseline_trust_failed",
        scout_id: scout.id,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logEvent({
    level: "info",
    fn: "web-scout-baseline",
    event: "baseline_capture_done",
    scout_id: scout.id,
    user_id: scout.user_id,
    msg: outcome.status,
  });
  return outcome;
}

export interface MissingBaselineRunResult {
  change_status: "same";
  articles_count: 0;
  merged_existing_count: 0;
  criteria_ran: false;
  baseline_initialized: true;
  served_by?: ScrapeResult["served_by"];
}

export async function maybeInitializeMissingWebBaselineRun(
  svc: SupabaseClient,
  scout: WebBaselineScout,
  runId: string,
  deps: WebBaselineDeps = DEFAULT_DEPS,
): Promise<MissingBaselineRunResult | null> {
  const ensured = await ensureWebBaselineDetailed(
    svc,
    scout,
    deps,
    runId,
  );
  if (!ensured.established) return null;

  const { error: failureErr } = await svc.rpc("reset_scout_failures", {
    p_scout_id: scout.id,
  });
  if (failureErr) throw new Error(failureErr.message);

  return {
    change_status: "same",
    articles_count: 0,
    merged_existing_count: 0,
    criteria_ran: false,
    baseline_initialized: true,
    served_by: ensured.servedBy,
  };
}
