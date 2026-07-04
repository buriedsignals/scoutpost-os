/**
 * Per-scout positional alert state — the enter-only "alert exactly once"
 * machinery (PRD R6/KTD3).
 *
 * Presence is position-age-based, never run-count-based; eviction happens
 * only on successful runs (skipped/error runs never reach this module, so
 * outage clocks are frozen by construction). The alert itself is a
 * transactional claim: `UPDATE … WHERE alerted_at IS NULL` — concurrent runs
 * can each upsert the row, but exactly one wins the claim.
 *
 * First-run behavior (OQ3, Tom 2026-07-03): while the scout has no
 * `baseline_established_at`, observed objects are recorded silently and no
 * alerts fire; the caller stamps the baseline after the run succeeds.
 */

import type { SupabaseClient } from "../_shared/supabase.ts";

/** Pure decision core — computed from regularity so tests need no DB. */
export function evictionHorizonHours(regularity: string | null): number {
  const cadenceHours: Record<string, number> = {
    "3h": 3,
    "6h": 6,
    "12h": 12,
    daily: 24,
    weekly: 168,
    monthly: 720,
  };
  const cadence = cadenceHours[regularity ?? "daily"] ?? 24;
  return Math.max(2 * cadence, 6);
}

export interface StateSyncResult {
  /** Objects that won the alert claim this run — the ONLY ones to notify. */
  entrants: string[];
  baselineRun: boolean;
  evicted: number;
}

export async function syncStateAndClaimEntrants(
  svc: SupabaseClient,
  args: {
    scoutId: string;
    userId: string;
    objectIds: string[];
    regularity: string | null;
    baselineEstablished: boolean;
    now?: Date;
  },
): Promise<StateSyncResult> {
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const baselineRun = !args.baselineEstablished;

  if (args.objectIds.length > 0) {
    // Upsert presence. On a baseline run rows are born pre-claimed
    // (alerted_at set) so they can never alert later without a genuine
    // eviction + re-entry.
    const rows = args.objectIds.map((objectId) => ({
      scout_id: args.scoutId,
      user_id: args.userId,
      object_id: objectId,
      last_seen: nowIso,
      ...(baselineRun ? { alerted_at: nowIso } : {}),
    }));
    const { error: upsertErr } = await svc
      .from("transport_scout_state")
      .upsert(rows, {
        onConflict: "scout_id,object_id",
        ignoreDuplicates: false,
      });
    if (upsertErr) throw new Error(upsertErr.message);
  }

  let entrants: string[] = [];
  if (!baselineRun && args.objectIds.length > 0) {
    // Transactional claim: only rows never alerted flip, and each row flips
    // for exactly one caller.
    const { data: claimed, error: claimErr } = await svc
      .from("transport_scout_state")
      .update({ alerted_at: nowIso })
      .eq("scout_id", args.scoutId)
      .in("object_id", args.objectIds)
      .is("alerted_at", null)
      .select("object_id");
    if (claimErr) throw new Error(claimErr.message);
    entrants = (claimed ?? []).map((r) => r.object_id as string);
  }

  // Time-based eviction: objects unseen past the horizon are forgotten, so a
  // genuine re-entry re-alerts. Successful runs only (we are in one).
  const horizonMs = evictionHorizonHours(args.regularity) * 3600 * 1000;
  const cutoffIso = new Date(now.getTime() - horizonMs).toISOString();
  const { data: evictedRows, error: evictErr } = await svc
    .from("transport_scout_state")
    .delete()
    .eq("scout_id", args.scoutId)
    .lt("last_seen", cutoffIso)
    .select("object_id");
  if (evictErr) throw new Error(evictErr.message);

  return {
    entrants,
    baselineRun,
    evicted: (evictedRows ?? []).length,
  };
}

/**
 * Roll back alert claims for entrants whose feed events never landed. The
 * claim-then-deliver order means a post-claim failure would otherwise
 * permanently swallow the alert; unclaiming lets the next run re-claim and
 * deliver it. Safe because the overlap election prevents concurrent runs of
 * one scout.
 */
export async function unclaimEntrants(
  svc: SupabaseClient,
  scoutId: string,
  objectIds: string[],
): Promise<void> {
  if (objectIds.length === 0) return;
  const { error } = await svc
    .from("transport_scout_state")
    .update({ alerted_at: null })
    .eq("scout_id", scoutId)
    .in("object_id", objectIds);
  if (error) throw new Error(error.message);
}
