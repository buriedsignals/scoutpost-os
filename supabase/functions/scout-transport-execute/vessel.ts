/**
 * Vessel mode — reads the shared transport_positions cache (written by the
 * transport-sampler EF) instead of fetching per-run, because free AIS is a
 * streaming feed. A run is only meaningful if the sampler has recent data;
 * stale positions mean the run SKIPS (unbilled) rather than reporting a false
 * "no traffic".
 */

import type { SupabaseClient } from "../_shared/supabase.ts";
import {
  classifyByAisType,
  isMilitaryAisType,
  type VesselClass,
} from "../_shared/vessel_classify.ts";
import {
  geofenceToBBox,
  pointInGeofence,
  type ResolvedGeofence,
} from "./geofence.ts";
import type { TransportConfig } from "../_shared/transport_config.ts";

/** Sampler cadence (min). Must match the cron in migration 00073. */
export const SAMPLER_PERIOD_MINUTES = 30;
/** Extra AIS-anchor headroom on top of the sampler period. */
const STALENESS_HEADROOM_MINUTES = 5;

const CADENCE_HOURS: Record<string, number> = {
  "3h": 3,
  "6h": 6,
  "12h": 12,
  daily: 24,
};

/**
 * Freshness cutoff: a position older than this is stale. max(2× the scout's
 * cadence, sampler period + headroom) so a slow scout doesn't skip just
 * because the sampler runs less often than it does.
 */
export function stalenessCutoffMinutes(regularity: string | null): number {
  const cadenceH = CADENCE_HOURS[regularity ?? "3h"] ?? 3;
  return Math.max(
    2 * cadenceH * 60,
    SAMPLER_PERIOD_MINUTES + STALENESS_HEADROOM_MINUTES,
  );
}

export interface VesselObject {
  id: string; // MMSI — the stable state identity
  lat: number;
  lon: number;
  name: string | null;
  flag: string | null;
  classification: VesselClass;
  military: boolean;
  shipType: number | null;
  speedKnots: number | null;
  courseDeg: number | null;
}

interface PositionRow {
  mmsi: string;
  lat: number;
  lon: number;
  name: string | null;
  flag: string | null;
  classification: string | null;
  ship_type: number | null;
  speed_knots: number | null;
  course: number | null;
  seen_at: string;
}

/**
 * Sampler-liveness check. Returns true when the sampler has written ANY
 * position (anywhere) within the staleness cutoff — the sampler samples every
 * active vessel area in one window, so a globally-fresh table means this
 * scout's area WAS covered this cycle. Deliberately GLOBAL, not in-fence: a
 * quiet geofence with zero vessels is a healthy "no traffic" result, not a
 * staleness failure (this distinction is the fix for the auto-deactivation
 * bug where empty areas escalated to scout deactivation).
 */
export async function isSamplerFresh(
  svc: SupabaseClient,
  regularity: string | null,
  now: Date = new Date(),
): Promise<{ fresh: boolean; freshestSeenAt: string | null }> {
  const { data, error } = await svc
    .from("transport_positions")
    .select("seen_at")
    .order("seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const freshestSeenAt = (data?.seen_at as string | undefined) ?? null;
  if (freshestSeenAt == null) return { fresh: false, freshestSeenAt: null };
  const cutoffMs = stalenessCutoffMinutes(regularity) * 60 * 1000;
  const fresh = now.getTime() - new Date(freshestSeenAt).getTime() <= cutoffMs;
  return { fresh, freshestSeenAt };
}

/**
 * Load in-geofence vessels from transport_positions. Assumes the sampler
 * liveness gate (isSamplerFresh) already passed; an empty result here is a
 * legitimate "no vessels in the area right now", not an error.
 */
export async function fetchVesselsInGeofence(
  svc: SupabaseClient,
  geofence: ResolvedGeofence,
): Promise<VesselObject[]> {
  // cos(lat)-correct circumscribed bbox as the coarse DB prefilter, then
  // pointInGeofence for the exact shape. A naive lat-only longitude
  // half-width under-covers at non-equatorial latitudes and drops vessels.
  const bbox = geofenceToBBox(geofence);
  const { data, error } = await svc
    .from("transport_positions")
    .select(
      "mmsi, lat, lon, name, flag, classification, ship_type, speed_knots, course, seen_at",
    )
    .gte("lat", bbox.minLat)
    .lte("lat", bbox.maxLat)
    .gte("lon", bbox.minLon)
    .lte("lon", bbox.maxLon);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as PositionRow[];

  return rows
    .filter((r) => pointInGeofence(geofence, r.lat, r.lon))
    .map((r) => ({
      id: r.mmsi,
      lat: r.lat,
      lon: r.lon,
      name: r.name,
      flag: r.flag,
      classification: (r.classification as VesselClass) ??
        classifyByAisType(r.ship_type),
      military: isMilitaryAisType(r.ship_type),
      shipType: r.ship_type,
      speedKnots: r.speed_knots,
      courseDeg: r.course,
    }));
}

/** Apply watch-id (MMSI) and category filters to the in-geofence set. */
export function filterVessels(
  config: TransportConfig,
  vessels: VesselObject[],
): VesselObject[] {
  let out = vessels;
  const watch = new Set(config.watch_ids ?? []);
  if (watch.size > 0) out = out.filter((v) => watch.has(v.id));
  const cats = config.categories ?? [];
  if (cats.length > 0) {
    out = out.filter((v) =>
      cats.some((c) => c === "military" ? v.military : v.classification === c)
    );
  }
  return out;
}
