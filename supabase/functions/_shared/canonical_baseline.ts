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

export function rawCaptureExpiresAt(nowIso: string): string {
  const start = Date.parse(nowIso);
  const base = Number.isNaN(start) ? Date.now() : start;
  return new Date(base + RAW_CAPTURE_TTL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString();
}

/**
 * Return whether a Page Scout has a usable baseline for its configured URL.
 * A baseline is authoritative only when it uses the current canonicalizer and
 * was written outside a run (schedule-time repair) or by a successful run.
 */
export async function hasCurrentCanonicalBaselineForUrl(
  svc: SupabaseClient,
  scoutId: string,
  sourceUrl: string,
): Promise<boolean> {
  const { data, error } = await svc
    .from("raw_captures")
    .select("scout_run_id")
    .eq("scout_id", scoutId)
    .eq("source_url", sourceUrl)
    .eq("canonicalizer_version", WEB_CANONICALIZER_VERSION)
    .not("canonical_content_sha256", "is", null)
    .order("captured_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(`canonical baseline lookup failed: ${error.message}`);
  }

  const captures = (data ?? []) as Array<{ scout_run_id: string | null }>;
  if (captures.length === 0) return false;
  if (captures.some((capture) => !capture.scout_run_id)) return true;
  const runIds = captures
    .map((capture) => capture.scout_run_id)
    .filter((runId): runId is string => Boolean(runId));
  const { data: runs, error: runsError } = await svc
    .from("scout_runs")
    .select("id, status")
    .in("id", [...new Set(runIds)]);
  if (runsError) {
    throw new Error(
      `canonical baseline run-status lookup failed: ${runsError.message}`,
    );
  }
  return ((runs ?? []) as Array<{ status: string | null }>).some(
    (run) => run.status === "success",
  );
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
  opts: { sourceUrl?: string; fn?: string; comparisonStrategy?: string } = {},
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
  opts: { sourceUrl?: string; fn?: string; comparisonStrategy?: string } = {},
): Promise<CanonicalContentComparison> {
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

  let query = svc
    .from("raw_captures")
    .select(
      "id, scout_run_id, content_sha256, content_md, comparison_md, comparison_strategy, canonical_content_sha256, canonicalizer_version",
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

  const captures = data as Array<{
    id: string;
    scout_run_id: string | null;
    content_sha256: string | null;
    content_md: string | null;
    comparison_md?: string | null;
    comparison_strategy?: string | null;
    canonical_content_sha256: string | null;
    canonicalizer_version: string | null;
  }>;
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

  const successfulCaptures = captures.filter((capture) =>
    !capture.scout_run_id || successfulRunIds.has(capture.scout_run_id)
  );
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
  args: {
    userId: string;
    scoutId: string;
    sourceUrl: string;
    markdown: string;
    comparisonMarkdown?: string | null;
    comparisonStrategy?: string;
    scoutRunId?: string | null;
    now?: string;
  },
): Promise<void> {
  const nowIso = args.now ?? new Date().toISOString();
  const comparisonMarkdown = args.comparisonMarkdown?.trim()
    ? args.comparisonMarkdown
    : args.markdown;
  const comparisonStrategy = args.comparisonStrategy ?? "full";
  const { error } = await svc.from("raw_captures").insert({
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
    captured_at: nowIso,
    expires_at: rawCaptureExpiresAt(nowIso),
  });
  if (error) throw new Error(error.message);
}
