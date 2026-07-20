/** Database helpers shared by the VesselAPI and GP sampler tasks. */

import type { SupabaseClient } from "../_shared/supabase.ts";
import type { VesselPosition } from "./position.ts";

const UPSERT_BATCH = 500;

/** Deduplicated exact MMSIs watched by active vessel scouts. The REST provider
 * queries identities directly, so it does not need to over-fetch geofences. */
export async function activeVesselWatchIds(
  svc: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await svc
    .from("scouts")
    .select("config")
    .eq("type", "transport")
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  const ids = (data ?? []).flatMap((row) => {
    const config = (row.config ?? {}) as Record<string, unknown>;
    if (config.mode !== "vessel" || !Array.isArray(config.watch_ids)) return [];
    return config.watch_ids.filter((id): id is string =>
      typeof id === "string" && /^\d{9}$/.test(id)
    );
  });
  return [...new Set(ids)];
}

/** True when at least one active satellite transport scout exists — gates the
 * daily GP refresh so vessel-only / idle deployments never hit CelesTrak. */
export async function hasActiveSatelliteScouts(
  svc: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await svc
    .from("scouts")
    .select("config")
    .eq("type", "transport")
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return (data ?? []).some((row) =>
    (row.config as Record<string, unknown> | null)?.mode === "satellite"
  );
}

/** Batch-upsert coalesced positions by MMSI. Returns the count written. */
export async function upsertPositions(
  svc: SupabaseClient,
  positions: VesselPosition[],
): Promise<number> {
  if (positions.length === 0) return 0;
  // Exact-position responses do not always include ship type. Preserve any
  // static identity/classification already stored instead of overwriting it
  // with null/unknown on every refresh.
  const { data: existing, error: existingError } = await svc
    .from("transport_positions")
    .select("mmsi, name, ship_type, classification")
    .in("mmsi", positions.map((position) => position.mmsi));
  if (existingError) throw new Error(existingError.message);
  const existingByMmsi = new Map(
    (existing ?? []).map((row) => [String(row.mmsi), row]),
  );
  const rows = positions.map((p) => {
    const prior = existingByMmsi.get(p.mmsi) as
      | {
        name?: string | null;
        ship_type?: number | null;
        classification?: string | null;
      }
      | undefined;
    return {
      mmsi: p.mmsi,
      lat: p.lat,
      lon: p.lon,
      course: p.course,
      speed_knots: p.speedKnots,
      heading: p.heading,
      nav_status: p.navStatus,
      ship_type: p.shipType ?? prior?.ship_type ?? null,
      classification: p.classification === "unknown"
        ? prior?.classification ?? p.classification
        : p.classification,
      name: p.name ?? prior?.name ?? null,
      flag: p.flag,
      seen_at: p.seenAt,
      updated_at: new Date().toISOString(),
    };
  });
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await svc
      .from("transport_positions")
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "mmsi" });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}
