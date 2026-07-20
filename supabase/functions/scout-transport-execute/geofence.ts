/**
 * Geofence resolution + containment + ADS-B query tiling for transport
 * scouts. Pure math except resolveGeofence (one preset lookup).
 */

import type { SupabaseClient } from "../_shared/supabase.ts";
import { ValidationError } from "../_shared/errors.ts";
import type { TransportConfig } from "../_shared/transport_config.ts";

const EARTH_RADIUS_KM = 6371;
export const ADSB_MAX_QUERY_RADIUS_NM = 250;
const KM_PER_NM = 1.852;
/** Grid spacing so a square cell is inscribed in a 250 nm query circle. */
const TILE_SPACING_KM = ADSB_MAX_QUERY_RADIUS_NM * KM_PER_NM * Math.SQRT2;

export type ResolvedGeofence =
  | {
    kind: "bbox";
    name: string;
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  }
  | {
    kind: "circle";
    name: string;
    lat: number;
    lon: number;
    radiusKm: number;
  };

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** Resolve config.geofence to a concrete shape. Preset ids hit the presets
 * table; a vanished preset is a validation error (run marked, unbilled). */
export async function resolveGeofence(
  svc: SupabaseClient,
  config: TransportConfig,
): Promise<ResolvedGeofence | null> {
  const geofence = config.geofence;
  if (!geofence) return null;
  if (geofence.preset_id) {
    const { data, error } = await svc
      .from("transport_geofence_presets")
      .select("id, name, min_lat, min_lon, max_lat, max_lon")
      .eq("id", geofence.preset_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new ValidationError(
        `geofence preset no longer exists: ${geofence.preset_id}`,
      );
    }
    return {
      kind: "bbox",
      name: data.name as string,
      minLat: data.min_lat as number,
      minLon: data.min_lon as number,
      maxLat: data.max_lat as number,
      maxLon: data.max_lon as number,
    };
  }
  if (geofence.center && typeof geofence.radius_km === "number") {
    return {
      kind: "circle",
      name: geofence.display_name ||
        `${geofence.radius_km} km around ${geofence.center.lat.toFixed(2)}, ${
          geofence.center.lon.toFixed(2)
        }`,
      lat: geofence.center.lat,
      lon: geofence.center.lon,
      radiusKm: geofence.radius_km,
    };
  }
  return null;
}

/** Circumscribed bbox of any resolved geofence — used by the sampler to build
 * provider query boxes. Longitude scaling clamps latitude to 85°. */
export function geofenceToBBox(g: ResolvedGeofence): {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
} {
  if (g.kind === "bbox") {
    return {
      minLat: g.minLat,
      minLon: g.minLon,
      maxLat: g.maxLat,
      maxLon: g.maxLon,
    };
  }
  const clampedLatRad = Math.min(Math.abs(g.lat), 85) * Math.PI / 180;
  const dLat = g.radiusKm / 111;
  const dLon = g.radiusKm / (111 * Math.cos(clampedLatRad));
  return {
    minLat: Math.max(-90, g.lat - dLat),
    minLon: Math.max(-180, g.lon - dLon),
    maxLat: Math.min(90, g.lat + dLat),
    maxLon: Math.min(180, g.lon + dLon),
  };
}

/** Resolve a scout's raw config geofence directly to a bbox (sampler path). */
export async function resolveGeofenceBBox(
  svc: SupabaseClient,
  rawConfig: Record<string, unknown>,
): Promise<
  { minLat: number; minLon: number; maxLat: number; maxLon: number } | null
> {
  const geofence = await resolveGeofence(svc, rawConfig as TransportConfig);
  return geofence ? geofenceToBBox(geofence) : null;
}

export function pointInGeofence(
  g: ResolvedGeofence,
  lat: number,
  lon: number,
): boolean {
  if (g.kind === "circle") {
    return haversineKm(g.lat, g.lon, lat, lon) <= g.radiusKm;
  }
  if (lat < g.minLat || lat > g.maxLat) return false;
  // A bbox with minLon > maxLon wraps the antimeridian (e.g. 170 → -170):
  // longitude is inside if it is >= minLon OR <= maxLon.
  if (g.minLon > g.maxLon) return lon >= g.minLon || lon <= g.maxLon;
  return lon >= g.minLon && lon <= g.maxLon;
}

export interface QueryTile {
  lat: number;
  lon: number;
  radiusNm: number;
}

/**
 * Cover the geofence with ≤250 nm ADS-B query circles. Circles within the
 * cap are a single tile; larger circles and bboxes get a grid whose square
 * cells are inscribed in the query circle, so coverage has no gaps. Results
 * are post-filtered by pointInGeofence, so over-fetch at the edges is fine.
 */
export function tileGeofence(g: ResolvedGeofence): QueryTile[] {
  if (g.kind === "circle") {
    if (g.radiusKm <= ADSB_MAX_QUERY_RADIUS_NM * KM_PER_NM) {
      return [{
        lat: g.lat,
        lon: g.lon,
        radiusNm: Math.min(
          ADSB_MAX_QUERY_RADIUS_NM,
          Math.ceil(g.radiusKm / KM_PER_NM),
        ),
      }];
    }
    // Oversized circles are rejected at creation for aircraft mode; treat a
    // runtime encounter as its circumscribed bbox. Longitude scaling uses
    // the center latitude clamped to 85° (above that a degree of longitude
    // is effectively meaningless for coverage math), and the resulting box
    // is clamped to valid coordinate ranges — near the antimeridian this
    // trims coverage to the ±180 edge, which is safe because results are
    // post-filtered by pointInGeofence against the ORIGINAL circle.
    const clampedLatRad = Math.min(Math.abs(g.lat), 85) * Math.PI / 180;
    const dLat = g.radiusKm / 111;
    const dLon = g.radiusKm / (111 * Math.cos(clampedLatRad));
    return tileGeofence({
      kind: "bbox",
      name: g.name,
      minLat: Math.max(-90, g.lat - dLat),
      maxLat: Math.min(90, g.lat + dLat),
      minLon: Math.max(-180, g.lon - dLon),
      maxLon: Math.min(180, g.lon + dLon),
    });
  }

  const midLat = (g.minLat + g.maxLat) / 2;
  const heightKm = (g.maxLat - g.minLat) * 111;
  const widthKm = Math.abs(
    (g.maxLon - g.minLon) * 111 * Math.cos((midLat * Math.PI) / 180),
  );
  const rows = Math.max(1, Math.ceil(heightKm / TILE_SPACING_KM));
  const cols = Math.max(1, Math.ceil(widthKm / TILE_SPACING_KM));
  const tiles: QueryTile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({
        lat: g.minLat + ((r + 0.5) / rows) * (g.maxLat - g.minLat),
        lon: g.minLon + ((c + 0.5) / cols) * (g.maxLon - g.minLon),
        radiusNm: ADSB_MAX_QUERY_RADIUS_NM,
      });
    }
  }
  return tiles;
}
