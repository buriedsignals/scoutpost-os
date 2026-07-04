/**
 * CelesTrak GP (General Perturbations) refresh for satellite mode.
 *
 * Fetches the "active" satellite catalog in JSON/OMM format and caches it in
 * transport_gp_cache. JSON (OMM) not TLE, because 5-digit catalog numbers
 * exhausted ~2026-07 and new objects have no TLE representation.
 *
 * CelesTrak fair use (https://celestrak.org): data updates ~every 2h; since
 * 2026-03 there is a one-download-per-update policy (HTTP 403 on repeats).
 * A daily fetch with If-Modified-Since sits comfortably inside the policy;
 * 304/403 are handled as "keep the cache".
 */

import type { SupabaseClient } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";

const CELESTRAK_ACTIVE =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json";
const UPSERT_BATCH = 500;
const FETCH_TIMEOUT_MS = 30_000;

interface OmmRecord {
  NORAD_CAT_ID?: number | string;
  OBJECT_NAME?: string;
  EPOCH?: string;
  [k: string]: unknown;
}

export interface GpRefreshResult {
  status: "updated" | "not_modified" | "blocked" | "empty";
  cached: number;
}

/** Most recent fetched_at across the GP cache, for the If-Modified-Since hint. */
async function lastFetchedAt(svc: SupabaseClient): Promise<string | null> {
  const { data } = await svc
    .from("transport_gp_cache")
    .select("fetched_at")
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.fetched_at as string | undefined) ?? null;
}

export async function refreshGpCache(
  svc: SupabaseClient,
): Promise<GpRefreshResult> {
  const since = await lastFetchedAt(svc);
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (since) headers["If-Modified-Since"] = new Date(since).toUTCString();

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(CELESTRAK_ACTIVE, { headers, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    await res.body?.cancel();
    return { status: "not_modified", cached: 0 };
  }
  if (res.status === 403) {
    // One-download-per-update policy tripped — keep the existing cache.
    await res.body?.cancel();
    logEvent({
      level: "warn",
      fn: "transport-sampler",
      event: "gp_403",
      msg: "CelesTrak 403 (one-download-per-update); serving cached elements",
    });
    return { status: "blocked", cached: 0 };
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`CelesTrak responded ${res.status}`);
  }

  const records = (await res.json()) as OmmRecord[];
  if (!Array.isArray(records) || records.length === 0) {
    return { status: "empty", cached: 0 };
  }

  const nowIso = new Date().toISOString();
  const rows = records
    .map((rec) => {
      const norad = Number(rec.NORAD_CAT_ID);
      if (!Number.isInteger(norad) || norad <= 0) return null;
      return {
        norad_id: norad,
        name: typeof rec.OBJECT_NAME === "string"
          ? rec.OBJECT_NAME.trim()
          : null,
        omm: rec,
        epoch: typeof rec.EPOCH === "string" ? rec.EPOCH : null,
        fetched_at: nowIso,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await svc
      .from("transport_gp_cache")
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "norad_id" });
    if (error) throw new Error(error.message);
  }
  logEvent({
    level: "info",
    fn: "transport-sampler",
    event: "gp_refresh",
    msg: `cached ${rows.length} GP elements`,
  });
  return { status: "updated", cached: rows.length };
}
