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

/** Sampler cadence (min). Must match the current vessel sampler cron. */
export const SAMPLER_PERIOD_MINUTES = 60;
/** Latest successful heartbeat may drift beyond the exact cron boundary. */
export const SAMPLER_HEARTBEAT_MAX_AGE_MINUTES = 90;
/** VesselAPI returns up to two hours of position history by default. */
export const POSITION_MAX_AGE_MINUTES = 125;

/**
 * Position freshness is tied to shared ingestion cadence, never the consumer
 * scout's cadence. Keeping the parameter preserves the existing call contract.
 */
export function stalenessCutoffMinutes(_regularity: string | null): number {
  return POSITION_MAX_AGE_MINUTES;
}

export function samplerHeartbeatIsFresh(
  completedAt: string | null,
  now: Date = new Date(),
): boolean {
  if (!completedAt) return false;
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(completedMs)) return false;
  return now.getTime() - completedMs <=
    SAMPLER_HEARTBEAT_MAX_AGE_MINUTES * 60_000;
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
 * Sampler-liveness check. A recent successful heartbeat is healthy even when
 * every requested MMSI is absent, while a failed heartbeat cannot be hidden by
 * an old cached position. Deliberately global: provider health is shared.
 */
export async function isSamplerFresh(
  svc: SupabaseClient,
  _regularity: string | null,
  now: Date = new Date(),
): Promise<{ fresh: boolean; freshestSeenAt: string | null }> {
  const { data, error } = await svc
    .from("transport_sampler_runs")
    .select("completed_at")
    .eq("task", "ais")
    .eq("status", "succeeded")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const freshestSeenAt = (data?.completed_at as string | undefined) ?? null;
  const fresh = samplerHeartbeatIsFresh(freshestSeenAt, now);
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
  const freshAfter = new Date(
    Date.now() - POSITION_MAX_AGE_MINUTES * 60_000,
  ).toISOString();
  const { data, error } = await svc
    .from("transport_positions")
    .select(
      "mmsi, lat, lon, name, flag, classification, ship_type, speed_knots, course, seen_at",
    )
    .gte("lat", bbox.minLat)
    .lte("lat", bbox.maxLat)
    .gte("lon", bbox.minLon)
    .lte("lon", bbox.maxLon)
    .gte("seen_at", freshAfter);
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
