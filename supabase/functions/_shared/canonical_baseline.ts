/**
 * In-house canonical-hash change detection (SCRAPING-MIGRATION-PRD U4).
 *
 * Replaces Firecrawl remote change tracking. A page's canonical hash is stored
 * in raw_captures; a later scrape is "same"/"changed"/"new" by comparing
 * against the latest baseline from a SUCCESSFUL run (or a schedule-time
 * insert). Generalized to filter by source_url so one scout can track many
 * URLs independently (civic), while web scouts (one URL) pass no sourceUrl and
 * get the exact prior behavior.
 */

import type { SupabaseClient } from "./supabase.ts";
import { logEvent } from "./log.ts";
import { deriveSourceDomain, sha256Hex } from "./unit_dedup.ts";
import {
  WEB_CANONICALIZER_VERSION,
  webCanonicalHash,
} from "./web_content_canonical.ts";
import { ValidationError } from "./errors.ts";
import {
  PAGE_RESPONSE_VALIDATION_VERSION,
  type PageResponseInput,
  type PageResponseOutcome,
  validatePageResponse,
} from "./page_scout_change.ts";

export interface CanonicalComparisonOptions {
  sourceUrl?: string;
  fn?: string;
  comparisonStrategy?: string;
  /** Explicit opt-in: Civic retains its existing baseline contract. */
  validityMode?: "page";
  /** Full response when markdown is a focused comparison projection. */
  pageResponse?: PageResponseInput;
}

interface CanonicalCapture {
  id: string;
  scout_run_id: string | null;
  content_sha256: string | null;
  content_md: string | null;
  comparison_md?: string | null;
  comparison_strategy?: string | null;
  canonical_content_sha256: string | null;
  canonicalizer_version: string | null;
  source_url?: string;
  page_response_status?: number | null;
  page_validation_version?: string | null;
  page_validation_outcome?: PageResponseOutcome | null;
}

const CANONICAL_CAPTURE_COLUMNS =
  "id, scout_run_id, content_sha256, content_md, comparison_md, comparison_strategy, canonical_content_sha256, canonicalizer_version";

/**
 * Page readiness and comparison share eligibility and scan beyond invalid
 * candidates. Legacy rows are inspected lazily; classification never deletes
 * their evidence or changes their hashes.
 */
async function loadSuccessfulPageCaptures(
  svc: SupabaseClient,
  scoutId: string,
  sourceUrl?: string,
  stopAfterFirst = false,
): Promise<CanonicalCapture[]> {
  const eligible: CanonicalCapture[] = [];
  const pageSize = 50;
  for (let offset = 0;; offset += pageSize) {
    let query = svc.from("raw_captures")
      .select(
        `${CANONICAL_CAPTURE_COLUMNS}, source_url, page_response_status, page_validation_version, page_validation_outcome`,
      )
      .eq("scout_id", scoutId);
    if (sourceUrl) {
      // Exclude non-baseline extraction captures in the shared URL namespace.
      query = query.eq("source_url", sourceUrl)
        .not("canonical_content_sha256", "is", null);
    }
    const { data, error } = await query
      .order("captured_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) {
      throw new Error(`canonical baseline lookup failed: ${error.message}`);
    }
    const captures = (data ?? []) as CanonicalCapture[];
    const runIds = [
      ...new Set(
        captures.flatMap((capture) =>
          capture.scout_run_id ? [capture.scout_run_id] : []
        ),
      ),
    ];
    const successfulRunIds = new Set<string>();
    if (runIds.length) {
      const { data: runs, error: runsError } = await svc.from("scout_runs")
        .select("id, status").in("id", runIds);
      if (runsError) {
        throw new Error(
          `canonical baseline run-status lookup failed: ${runsError.message}`,
        );
      }
      for (const run of runs ?? []) {
        if (run.status === "success") successfulRunIds.add(run.id);
      }
    }
    for (const capture of captures) {
      if (
        capture.scout_run_id &&
        !successfulRunIds.has(capture.scout_run_id)
      ) continue;
      let outcome = capture.page_validation_outcome;
      if (
        capture.page_validation_version !== PAGE_RESPONSE_VALIDATION_VERSION ||
        !outcome
      ) {
        const validation = validatePageResponse({
          markdown: capture.content_md,
          status_code: capture.page_response_status,
          source_url: capture.source_url,
        }, sourceUrl);
        outcome = validation.outcome;
        const { error: updateError } = await svc.from("raw_captures")
          .update({
            page_validation_version: validation.version,
            page_validation_outcome: outcome,
          }).eq("id", capture.id);
        if (updateError) {
          throw new Error(
            `page baseline validation update failed: ${updateError.message}`,
          );
        }
      }
      if (outcome === "valid") eligible.push(capture);
    }
    if (captures.length < pageSize || (stopAfterFirst && eligible.length)) {
      return eligible;
    }
  }
}

export type CanonicalChangeStatus = "new" | "same" | "changed";

export interface CanonicalContentComparison {
  status: CanonicalChangeStatus;
  /** Previous quality-gated comparison document. */
  previousMarkdown: string | null;
  /** Previous complete document, retained for discovery and evidence. */
  previousFullMarkdown: string | null;
  previousCaptureId: string | null;
  comparisonStrategyChanged: boolean;
  /** Successful baselines in newest-first order. Used to distinguish children
   * present at index establishment from links added after activation. */
  successfulMarkdownHistory: string[];
}

export const RAW_CAPTURE_TTL_DAYS = 30;

interface CanonicalBaselineInput {
  userId: string;
  scoutId: string;
  sourceUrl: string;
  markdown: string;
  comparisonMarkdown?: string | null;
  comparisonStrategy?: string;
  scoutRunId?: string | null;
  validityMode?: "page";
  pageResponse?: PageResponseInput;
}

interface CanonicalBaselineWriteArgs extends CanonicalBaselineInput {
  now?: string;
}

interface CanonicalBaselineRowArgs extends CanonicalBaselineInput {
  now: string;
}

export function rawCaptureExpiresAt(nowIso: string): string {
  const start = Date.parse(nowIso);
  const base = Number.isNaN(start) ? Date.now() : start;
  return new Date(base + RAW_CAPTURE_TTL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString();
}

/**
 * Build the canonical raw_captures row shared by production writers and
 * benchmarks. Requiring the capture time keeps benchmark fixtures
 * deterministic while writeCanonicalBaseline retains its clock default.
 */
export async function buildCanonicalBaselineRow(
  args: CanonicalBaselineRowArgs,
): Promise<Record<string, unknown>> {
  const validation = args.validityMode === "page"
    ? validatePageResponse(
      { ...args.pageResponse, markdown: args.markdown },
      args.sourceUrl,
    )
    : null;
  if (validation && !validation.valid) {
    throw new ValidationError(validation.message!);
  }
  const comparisonMarkdown = args.comparisonMarkdown?.trim()
    ? args.comparisonMarkdown
    : args.markdown;
  const comparisonStrategy = args.comparisonStrategy ?? "full";
  return {
    user_id: args.userId,
    scout_id: args.scoutId,
    scout_run_id: args.scoutRunId ?? null,
    source_url: args.sourceUrl,
    source_domain: deriveSourceDomain(args.sourceUrl),
    content_md: args.markdown,
    content_sha256: await sha256Hex(args.markdown),
    comparison_md: comparisonStrategy === "full" ? null : comparisonMarkdown,
    comparison_strategy: comparisonStrategy,
    canonical_content_sha256: await webCanonicalHash(comparisonMarkdown),
    canonicalizer_version: WEB_CANONICALIZER_VERSION,
    token_count: Math.ceil(args.markdown.length / 4),
    captured_at: args.now,
    expires_at: rawCaptureExpiresAt(args.now),
    ...(validation
      ? {
        page_validation_version: validation.version,
        page_validation_outcome: validation.outcome,
        page_response_status: typeof args.pageResponse?.status_code === "number"
          ? args.pageResponse.status_code
          : null,
      }
      : {}),
  };
}

/**
 * Return whether a Page Scout has a usable baseline for its configured URL.
 * A canonical capture must pass Page validity and belong to a successful run
 * (or schedule-time repair). Older canonicalizers migrate during comparison;
 * version metadata alone must not force a new network baseline.
 */
export async function hasCurrentCanonicalBaselineForUrl(
  svc: SupabaseClient,
  scoutId: string,
  sourceUrl: string,
): Promise<boolean> {
  return (await loadSuccessfulPageCaptures(svc, scoutId, sourceUrl, true))
    .length > 0;
}

/**
 * Classify a fresh scrape against the scout's stored baseline. When
 * `sourceUrl` is given, only baselines for that URL are considered (civic:
 * per-tracked-URL). Mirrors the former web-only hashChangeStatus exactly for
 * the no-sourceUrl case.
 */
export async function hashChangeStatusForUrl(
  svc: SupabaseClient,
  scoutId: string,
  markdown: string,
  opts: CanonicalComparisonOptions = {},
): Promise<CanonicalChangeStatus> {
  return (await compareCanonicalContentForUrl(svc, scoutId, markdown, opts))
    .status;
}

/**
 * The comparison seam used by Page Scout when it also needs the prior
 * successful content to construct the normalized delta. Failed-run captures
 * are excluded exactly as in hashChangeStatusForUrl.
 */
export async function compareCanonicalContentForUrl(
  svc: SupabaseClient,
  scoutId: string,
  markdown: string,
  opts: CanonicalComparisonOptions = {},
): Promise<CanonicalContentComparison> {
  if (opts.validityMode === "page") {
    const validation = validatePageResponse(
      opts.pageResponse ?? { markdown },
      opts.sourceUrl,
    );
    if (!validation.valid) throw new ValidationError(validation.message!);
  }
  const fresh = (): CanonicalContentComparison => ({
    status: "new",
    previousMarkdown: null,
    previousFullMarkdown: null,
    previousCaptureId: null,
    comparisonStrategyChanged: false,
    successfulMarkdownHistory: [],
  });
  if (!markdown.trim()) return fresh();
  const rawHash = await sha256Hex(markdown);
  const canonicalHash = await webCanonicalHash(markdown);

  let successfulCaptures: CanonicalCapture[];
  if (opts.validityMode === "page") {
    successfulCaptures = await loadSuccessfulPageCaptures(
      svc,
      scoutId,
      opts.sourceUrl,
    );
  } else {
    let query = svc
      .from("raw_captures")
      .select(
        CANONICAL_CAPTURE_COLUMNS,
      )
      .eq("scout_id", scoutId);
    if (opts.sourceUrl) {
      // Per-URL (civic) baselines are always written by writeCanonicalBaseline
      // with a canonical hash. Other writers share this (scout_id, source_url)
      // namespace — notably civic-extract-worker, which inserts truncated
      // document captures (RAW_CONTENT_MAX) with NO canonical hash. Without this
      // filter such a capture can sort to the top by captured_at and shadow the
      // real baseline, forcing a spurious "changed" (or a backfill off truncated
      // content). Restricting to canonical rows both fixes that and lets the
      // partial index idx_raw_scout_url_canonical_time serve this query. The
      // no-sourceUrl (web) path keeps its legacy content_md / raw-hash fallbacks.
      query = query
        .eq("source_url", opts.sourceUrl)
        .not("canonical_content_sha256", "is", null);
    }
    const { data, error } = await query
      .order("captured_at", { ascending: false })
      .limit(50);
    if (error) {
      throw new Error(`canonical baseline lookup failed: ${error.message}`);
    }
    if (!data?.length) return fresh();

    const captures = data as CanonicalCapture[];
    const runIds = captures
      .map((capture) => capture.scout_run_id)
      .filter((runId): runId is string => typeof runId === "string" && !!runId);
    let successfulRunIds = new Set<string>();
    if (runIds.length > 0) {
      const { data: runs, error: runsError } = await svc
        .from("scout_runs")
        .select("id, status")
        .in("id", [...new Set(runIds)]);
      if (!runsError && runs) {
        successfulRunIds = new Set(
          (runs as Array<{ id: string; status: string | null }>)
            .filter((run) => run.status === "success")
            .map((run) => run.id),
        );
      } else if (runsError) {
        logEvent({
          level: "warn",
          fn: opts.fn ?? "canonical-baseline",
          event: "baseline_run_status_lookup_failed",
          scout_id: scoutId,
          msg: runsError.message,
        });
        throw new Error(
          `canonical baseline run-status lookup failed: ${runsError.message}`,
        );
      }
    }

    successfulCaptures = captures.filter((capture) =>
      !capture.scout_run_id || successfulRunIds.has(capture.scout_run_id)
    );
  }
  const currentStrategy = opts.comparisonStrategy ?? "full";
  // A provider can legitimately alternate between equivalent extraction
  // strategies. Prefer the newest comparable v2 baseline so alternating
  // main/provider_main captures do not silently rebaseline on every run.
  // If this is the first capture for a strategy, retain the existing silent
  // cutover against the newest successful baseline.
  const latestBaseline =
    successfulCaptures.find((capture) =>
      capture.canonicalizer_version === WEB_CANONICALIZER_VERSION &&
      (capture.comparison_strategy ?? "full") === currentStrategy
    ) ?? successfulCaptures[0];
  if (!latestBaseline) return fresh();
  const successfulMarkdownHistory = successfulCaptures
    .filter((capture) => {
      const capturedMarkdown = capture.comparison_md ?? capture.content_md;
      return typeof capturedMarkdown === "string" &&
        capturedMarkdown.trim().length > 0;
    })
    .map((capture) => (capture.comparison_md ?? capture.content_md) as string);

  const previousMarkdown = latestBaseline.comparison_md?.trim()
    ? latestBaseline.comparison_md
    : latestBaseline.content_md;
  const previousStrategy = latestBaseline.comparison_strategy ?? "full";
  const strategyChanged = latestBaseline.canonicalizer_version ===
      WEB_CANONICALIZER_VERSION && previousStrategy !== currentStrategy;

  const result = (
    status: CanonicalChangeStatus,
    comparisonStrategyChanged = false,
  ): CanonicalContentComparison => ({
    status,
    previousMarkdown,
    previousFullMarkdown: latestBaseline.content_md,
    previousCaptureId: latestBaseline.id,
    comparisonStrategyChanged,
    successfulMarkdownHistory,
  });

  // Full and focused documents are intentionally incomparable. Rebaseline
  // silently when the quality-gated strategy changes instead of producing a
  // synthetic whole-page alert.
  if (strategyChanged) return result("same", true);

  if (
    latestBaseline.canonicalizer_version === WEB_CANONICALIZER_VERSION &&
    latestBaseline.canonical_content_sha256
  ) {
    return result(
      latestBaseline.canonical_content_sha256 === canonicalHash
        ? "same"
        : "changed",
    );
  }

  // v1 Page captures have no stored semantic projection. A focused v2 render
  // therefore becomes a silent cutover baseline; reconstructing old <main>
  // content from Markdown would fabricate structure that no longer exists.
  if (currentStrategy !== "full" && !latestBaseline.comparison_md?.trim()) {
    return result("same", true);
  }

  if (
    typeof previousMarkdown === "string" &&
    previousMarkdown.trim()
  ) {
    const priorCanonicalHash = await webCanonicalHash(
      previousMarkdown,
    );
    await svc
      .from("raw_captures")
      .update({
        canonical_content_sha256: priorCanonicalHash,
        canonicalizer_version: WEB_CANONICALIZER_VERSION,
        comparison_strategy: currentStrategy,
      })
      .eq("id", latestBaseline.id);
    return result(priorCanonicalHash === canonicalHash ? "same" : "changed");
  }

  // Legacy fallback for old captures that have only the raw hash.
  if (latestBaseline.content_sha256 === rawHash) return result("same");
  return result("changed");
}

/**
 * Persist a canonical baseline capture for (scout, sourceUrl). Advances the
 * baseline the next run compares against. Shared by web-scout establishment,
 * civic creation, and civic runs.
 */
export async function writeCanonicalBaseline(
  svc: SupabaseClient,
  args: CanonicalBaselineWriteArgs,
): Promise<void> {
  const nowIso = args.now ?? new Date().toISOString();
  const row = await buildCanonicalBaselineRow({ ...args, now: nowIso });
  const { error } = await svc.from("raw_captures").insert(row);
  if (error) throw new Error(error.message);
}
