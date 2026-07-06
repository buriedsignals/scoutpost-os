/**
 * In-house canonical-hash change detection (SCRAPING-MIGRATION-PRD U4).
 *
 * Replaces Firecrawl remote changeTracking. A page's canonical hash is stored
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

export const RAW_CAPTURE_TTL_DAYS = 30;

export function rawCaptureExpiresAt(nowIso: string): string {
  const start = Date.parse(nowIso);
  const base = Number.isNaN(start) ? Date.now() : start;
  return new Date(base + RAW_CAPTURE_TTL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString();
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
  opts: { sourceUrl?: string; fn?: string } = {},
): Promise<CanonicalChangeStatus> {
  if (!markdown.trim()) return "new";
  const rawHash = await sha256Hex(markdown);
  const canonicalHash = await webCanonicalHash(markdown);

  let query = svc
    .from("raw_captures")
    .select(
      "id, scout_run_id, content_sha256, content_md, canonical_content_sha256, canonicalizer_version",
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
  if (error || !data?.length) return "new";

  const captures = data as Array<{
    id: string;
    scout_run_id: string | null;
    content_sha256: string | null;
    content_md: string | null;
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
    }
  }

  const latestBaseline = captures.find((capture) =>
    !capture.scout_run_id || successfulRunIds.has(capture.scout_run_id)
  );
  if (!latestBaseline) return "new";

  if (
    latestBaseline.canonicalizer_version === WEB_CANONICALIZER_VERSION &&
    latestBaseline.canonical_content_sha256
  ) {
    return latestBaseline.canonical_content_sha256 === canonicalHash
      ? "same"
      : "changed";
  }

  if (
    typeof latestBaseline.content_md === "string" &&
    latestBaseline.content_md.trim()
  ) {
    const priorCanonicalHash = await webCanonicalHash(latestBaseline.content_md);
    await svc
      .from("raw_captures")
      .update({
        canonical_content_sha256: priorCanonicalHash,
        canonicalizer_version: WEB_CANONICALIZER_VERSION,
      })
      .eq("id", latestBaseline.id);
    return priorCanonicalHash === canonicalHash ? "same" : "changed";
  }

  // Legacy fallback for old captures that have only the raw hash.
  if (latestBaseline.content_sha256 === rawHash) return "same";
  return "changed";
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
    scoutRunId?: string | null;
    now?: string;
  },
): Promise<void> {
  const nowIso = args.now ?? new Date().toISOString();
  const { error } = await svc.from("raw_captures").insert({
    user_id: args.userId,
    scout_id: args.scoutId,
    scout_run_id: args.scoutRunId ?? null,
    source_url: args.sourceUrl,
    source_domain: deriveSourceDomain(args.sourceUrl),
    content_md: args.markdown,
    content_sha256: await sha256Hex(args.markdown),
    canonical_content_sha256: await webCanonicalHash(args.markdown),
    canonicalizer_version: WEB_CANONICALIZER_VERSION,
    token_count: Math.ceil(args.markdown.length / 4),
    captured_at: nowIso,
    expires_at: rawCaptureExpiresAt(nowIso),
  });
  if (error) throw new Error(error.message);
}
