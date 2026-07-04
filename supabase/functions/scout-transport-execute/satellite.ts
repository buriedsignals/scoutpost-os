/**
 * Satellite mode — SGP4 overflight prediction from cached CelesTrak GP (OMM)
 * elements. A "pass" is a contiguous interval where the satellite's
 * sub-satellite (ground) point is inside the scout's geofence over the next
 * 24h. Passes are PREDICTED (labelled as such in copy), not observed.
 *
 * Uses satellite.js@7.0.1 (verified under Deno in the U4 spike): json2satrec
 * for OMM input, sgp4/propagate for position, eciToGeodetic + gstime for the
 * ground track.
 */

import {
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  type SatRec,
} from "npm:satellite.js@7.0.1";
import type { SupabaseClient } from "../_shared/supabase.ts";
import {
  geofenceToBBox,
  pointInGeofence,
  type ResolvedGeofence,
} from "./geofence.ts";

const RAD2DEG = 180 / Math.PI;
/** Coarse scan step for bracketing approaches. */
const COARSE_STEP_SECONDS = 30;
/** Fine step used to refine an approach into an exact in-geofence window.
 * At ~7.5 km/s ground speed a 2s step is ~15 km — finer than the smallest
 * sensible geofence, so a real transit is never skipped between samples. */
const FINE_STEP_SECONDS = 2;
/** Coarse "near" margin: a sub-point within this many km of the geofence bbox
 * marks an approach bracket. Must exceed the coarse-step ground distance
 * (~225 km at 30s) so no approach can be jumped over. */
const APPROACH_MARGIN_KM = 400;
/** Look back before `now` so a pass already in progress at a daily run
 * boundary is captured from its TRUE start (stable pass keys across the
 * ~24h-apart runs whose horizons abut). */
const LOOKBACK_MINUTES = 15;
export const PASS_HORIZON_HOURS = 24;
/** GP cache is refreshed daily; treat elements older than this as too stale
 * to propagate reliably (skip the run rather than alert on bad orbits). */
export const GP_STALENESS_HOURS = 48;

export interface GpElement {
  noradId: number;
  name: string | null;
  omm: Record<string, unknown>;
  fetchedAt: string;
}

export interface PassWindow {
  noradId: number;
  name: string | null;
  /** Predicted start of the in-geofence interval (ISO). */
  startIso: string;
  /** Predicted end of the interval (ISO). */
  endIso: string;
}

/** Load cached GP elements for the watched NORAD ids. */
export async function fetchWatchedElements(
  svc: SupabaseClient,
  noradIds: number[],
): Promise<GpElement[]> {
  if (noradIds.length === 0) return [];
  const { data, error } = await svc
    .from("transport_gp_cache")
    .select("norad_id, name, omm, fetched_at")
    .in("norad_id", noradIds);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    noradId: r.norad_id as number,
    name: (r.name as string | null) ?? null,
    omm: (r.omm ?? {}) as Record<string, unknown>,
    fetchedAt: r.fetched_at as string,
  }));
}

/**
 * GP-cache LIVENESS — global, not per-watched-id. Mirrors the vessel sampler
 * check: the daily GP refresh updates the WHOLE cache, so a globally-fresh
 * cache means elements were refreshed this cycle. A watched NORAD id that is
 * simply absent from GROUP=active (decommissioned/debris) is best-effort — it
 * yields no passes but must NOT make the whole cache read as stale (that would
 * wrongly skip the run over one untracked id). Returns freshest-across-cache.
 */
export async function isGpCacheFresh(
  svc: SupabaseClient,
  now: Date = new Date(),
): Promise<{ fresh: boolean; freshestFetchedAt: string | null }> {
  const { data, error } = await svc
    .from("transport_gp_cache")
    .select("fetched_at")
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const freshestFetchedAt = (data?.fetched_at as string | undefined) ?? null;
  if (freshestFetchedAt == null) {
    return { fresh: false, freshestFetchedAt: null };
  }
  const cutoffMs = GP_STALENESS_HOURS * 3600 * 1000;
  const fresh =
    now.getTime() - new Date(freshestFetchedAt).getTime() <= cutoffMs;
  return { fresh, freshestFetchedAt };
}

/** Build the SGP4 satrec once for an element; null for malformed OMM. */
function buildSatrec(omm: Record<string, unknown>): SatRec | null {
  try {
    // CelesTrak GP JSON is OMM; satellite.js types it as OMMJsonObjectV3.
    return json2satrec(omm as unknown as Parameters<typeof json2satrec>[0]);
  } catch {
    return null;
  }
}

/** Sub-satellite (ground) point from a prebuilt satrec, or null when this one
 * sample fails to propagate (a decayed epoch far from `when`). */
function subPointFromRec(
  rec: SatRec,
  when: Date,
): { lat: number; lon: number } | null {
  const pv = propagate(rec, when);
  if (!pv || typeof pv !== "object" || !("position" in pv) || !pv.position) {
    return null;
  }
  const geo = eciToGeodetic(pv.position as never, gstime(when));
  let lonDeg = (geo.longitude as number) * RAD2DEG;
  lonDeg = ((lonDeg + 540) % 360) - 180; // normalize to [-180, 180]
  return { lat: (geo.latitude as number) * RAD2DEG, lon: lonDeg };
}

/** Sub-satellite point of an OMM element (builds a satrec each call — used by
 * tests; the hot path uses buildSatrec + subPointFromRec once per element). */
export function subSatellitePoint(
  omm: Record<string, unknown>,
  when: Date,
): { lat: number; lon: number } | null {
  const rec = buildSatrec(omm);
  return rec ? subPointFromRec(rec, when) : null;
}

/** Inflate a geofence's bbox by a km margin (for coarse approach bracketing). */
function inflatedBBox(geofence: ResolvedGeofence, marginKm: number) {
  const b = geofenceToBBox(geofence);
  const midLat = (b.minLat + b.maxLat) / 2;
  const dLat = marginKm / 111;
  const dLon = marginKm /
    (111 * Math.max(0.05, Math.cos(midLat * Math.PI / 180)));
  return {
    minLat: b.minLat - dLat,
    maxLat: b.maxLat + dLat,
    minLon: b.minLon - dLon,
    maxLon: b.maxLon + dLon,
  };
}

function inInflated(
  box: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  lat: number,
  lon: number,
): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon &&
    lon <= box.maxLon;
}

/**
 * Predict in-geofence pass windows for one element over
 * [now - LOOKBACK, now + horizon]. Two-phase for accuracy AND bounded CPU:
 *   1. Coarse scan (30s) with a wide margin brackets each approach — no
 *      approach can be jumped over between samples.
 *   2. Each bracket is refined at 2s for the exact in-fence interval, so a
 *      fast LEO transit of a small geofence is never missed between samples.
 * The satrec is built once (not per sample). A per-sample propagation failure
 * skips that sample rather than discarding the element's windows; only a
 * malformed OMM (no satrec) yields [].
 */
export function predictPasses(
  element: GpElement,
  geofence: ResolvedGeofence,
  now: Date = new Date(),
  horizonHours: number = PASS_HORIZON_HOURS,
): PassWindow[] {
  const rec = buildSatrec(element.omm);
  if (!rec) return [];
  const start = now.getTime() - LOOKBACK_MINUTES * 60 * 1000;
  const end = now.getTime() + horizonHours * 3600 * 1000;
  const approachBox = inflatedBBox(geofence, APPROACH_MARGIN_KM);

  // Phase 1: coarse brackets where the sub-point is near the geofence.
  const brackets: Array<{ from: number; to: number }> = [];
  let bracketFrom: number | null = null;
  let lastNear = 0;
  for (let t = start; t <= end; t += COARSE_STEP_SECONDS * 1000) {
    const sub = subPointFromRec(rec, new Date(t));
    if (sub && inInflated(approachBox, sub.lat, sub.lon)) {
      if (bracketFrom === null) bracketFrom = t;
      lastNear = t;
    } else if (bracketFrom !== null) {
      brackets.push({ from: bracketFrom, to: lastNear });
      bracketFrom = null;
    }
  }
  if (bracketFrom !== null) brackets.push({ from: bracketFrom, to: lastNear });

  // Phase 2: refine each bracket (padded by one coarse step) at fine step.
  const windows: PassWindow[] = [];
  const pad = COARSE_STEP_SECONDS * 1000;
  for (const b of brackets) {
    let inPass = false;
    let winStart = 0;
    let lastInside = 0;
    for (let t = b.from - pad; t <= b.to + pad; t += FINE_STEP_SECONDS * 1000) {
      if (t < start || t > end) continue;
      const sub = subPointFromRec(rec, new Date(t));
      const inside = sub !== null &&
        pointInGeofence(geofence, sub.lat, sub.lon);
      if (inside && !inPass) {
        inPass = true;
        winStart = t;
        lastInside = t;
      } else if (inside) {
        lastInside = t;
      } else if (!inside && inPass) {
        windows.push({
          noradId: element.noradId,
          name: element.name,
          startIso: new Date(winStart).toISOString(),
          endIso: new Date(lastInside).toISOString(),
        });
        inPass = false;
      }
    }
    if (inPass) {
      windows.push({
        noradId: element.noradId,
        name: element.name,
        startIso: new Date(winStart).toISOString(),
        endIso: new Date(lastInside).toISOString(),
      });
    }
  }
  return windows;
}

/**
 * Stable state key for a pass window: norad + start rounded to 10 min. Two
 * daily runs predicting the same pass produce the same key (so it never
 * re-alerts), while distinct passes of the same satellite get distinct keys.
 */
export function passStateKey(pass: PassWindow): string {
  const start = new Date(pass.startIso);
  const rounded = Math.floor(start.getTime() / (10 * 60 * 1000)) *
    (10 * 60 * 1000);
  return `pass:${pass.noradId}:${new Date(rounded).toISOString()}`;
}
