/**
 * Transport scout config — schema + validation shared by the scouts Edge
 * Function (create/update) and scout-transport-execute (run time).
 *
 * The config lives in scouts.config JSONB:
 *   { mode, geofence?, watch_ids?, categories?, criteria? }
 *
 * Every transport scout must list the SPECIFIC objects it tracks —
 * watch_ids (MMSIs / ICAO hexes / NORAD ids, up to 20 per scout). An
 * area-only or category-only scout would alert on all matching traffic
 * entering the area — a firehose, not monitoring (product decision
 * 2026-07-04). Categories only narrow a watch list further. Geofences are
 * a named preset (transport_geofence_presets row) or center + radius_km.
 */

import { z } from "https://esm.sh/zod@3";

export const TRANSPORT_MODES = ["vessel", "aircraft", "satellite"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** Categories a scout may scope on, per mode. Must stay in sync with the
 * run-time filters: vessel classifications from _shared/vessel_classify.ts
 * (plus the dedicated `military` flag) and aircraft watchlist categories
 * from _shared/plane_alert.ts. A typo'd category would otherwise satisfy
 * the scoping requirement while matching nothing — silent dead scout. */
export const TRANSPORT_CATEGORIES: Record<TransportMode, readonly string[]> = {
  vessel: [
    "military",
    "tanker",
    "cargo",
    "passenger",
    "fishing",
    "hsc",
    "tug_special",
    "pleasure",
  ],
  aircraft: ["military", "government", "police", "civil"],
  satellite: [], // satellites are scoped by NORAD watch_ids only
};

/** Max watch_ids per scout (product decision 2026-07-06). Keeps alert emails
 * readable (cards cap at the same number) and one batched /v2/hex URL short.
 * Mirrored in frontend/src/lib/utils/transport.ts and the CLI guard. */
export const MAX_WATCH_IDS = 20;

/** adsb.lol /v2/point caps radius at 250 nm (~463 km). Aircraft geofences are
 * creation-capped so one run needs at most a few tile queries. */
export const AIRCRAFT_MAX_RADIUS_KM = 463;
/** Generous but bounded cap for vessel/satellite circles. */
export const MAX_RADIUS_KM = 1500;

// Ship-station MMSIs start with an MID whose first digit is 2-7. This also
// rejects placeholder junk like 000000000 / 111111111 up front.
const VESSEL_MMSI_RE = /^[2-7]\d{8}$/;
// 24-bit ICAO hex. TIS-B pseudo-addresses arrive with a "~" prefix and are
// not stable airframe identity — rejected here.
const ICAO_HEX_RE = /^[0-9a-f]{6}$/;
const NORAD_ID_RE = /^[1-9]\d{0,8}$/;
const DISPLAY_METADATA_RE = /^[^\u0000-\u001f\u007f]*$/;
const MAX_DISPLAY_METADATA_LENGTH = 256;

const GeofenceSchema = z.object({
  preset_id: z.string().min(1).max(100).optional(),
  center: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    })
    .optional(),
  radius_km: z.number().positive().max(MAX_RADIUS_KM).optional(),
  // MapTiler metadata is display-only. Keep it bounded and single-line so it
  // is safe in feed statements and notification titles supplied by any client.
  display_name: z.string().max(MAX_DISPLAY_METADATA_LENGTH)
    .regex(DISPLAY_METADATA_RE, "must not contain control characters")
    .optional(),
  maptiler_id: z.string().max(MAX_DISPLAY_METADATA_LENGTH)
    .regex(DISPLAY_METADATA_RE, "must not contain control characters")
    .optional(),
});

export const TransportConfigSchema = z.object({
  mode: z.enum(TRANSPORT_MODES),
  geofence: GeofenceSchema.optional(),
  watch_ids: z.array(z.string().min(1).max(20)).max(MAX_WATCH_IDS).optional(),
  categories: z.array(z.string().min(1).max(50)).max(10).optional(),
  criteria: z.string().max(4000).optional(),
});

export type TransportConfig = z.infer<typeof TransportConfigSchema>;

/** Lowercase/trim identifiers so state keys and watch lookups are stable. */
export function normalizeTransportWatchId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function watchIdError(
  mode: TransportMode,
  id: string,
): string | null {
  const normalized = normalizeTransportWatchId(id);
  switch (mode) {
    case "vessel":
      return VESSEL_MMSI_RE.test(normalized)
        ? null
        : `invalid vessel MMSI: ${id} (expect 9 digits starting 2-7)`;
    case "aircraft":
      return ICAO_HEX_RE.test(normalized)
        ? null
        : `invalid aircraft ICAO hex: ${id} (expect 6 hex chars; TIS-B "~" addresses not supported)`;
    case "satellite":
      return NORAD_ID_RE.test(normalized)
        ? null
        : `invalid satellite NORAD id: ${id}`;
  }
}

export interface ValidatedTransportConfig {
  config: TransportConfig;
  error: null;
}
export interface InvalidTransportConfig {
  config: null;
  error: string;
}

/**
 * Full cross-field validation. Returns a normalized config (watch_ids
 * lowercased) or a human-readable error for a 400.
 */
export function validateTransportConfig(
  raw: unknown,
): ValidatedTransportConfig | InvalidTransportConfig {
  const parsed = TransportConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      config: null,
      error: parsed.error.issues
        .map((i) => `config.${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  const config = parsed.data;

  const geofence = config.geofence;
  if (geofence) {
    const hasPreset = Boolean(geofence.preset_id?.trim());
    const hasCircle = Boolean(geofence.center) &&
      typeof geofence.radius_km === "number";
    if (!hasPreset && !hasCircle) {
      return {
        config: null,
        error: "config.geofence: requires preset_id or center + radius_km",
      };
    }
    if (hasPreset && (geofence.center || geofence.radius_km !== undefined)) {
      return {
        config: null,
        error: "config.geofence: use preset_id or center + radius_km, not both",
      };
    }
    if (
      config.mode === "aircraft" &&
      typeof geofence.radius_km === "number" &&
      geofence.radius_km > AIRCRAFT_MAX_RADIUS_KM
    ) {
      return {
        config: null,
        error:
          `config.geofence.radius_km: aircraft geofences are capped at ${AIRCRAFT_MAX_RADIUS_KM} km (250 nm ADS-B query limit)`,
      };
    }
  }

  const watchIds = (config.watch_ids ?? []).map(normalizeTransportWatchId);
  const categories = config.categories ?? [];

  // Categories must be real filter values for the mode — an unknown category
  // would "scope" the scout while matching nothing.
  const allowed = TRANSPORT_CATEGORIES[config.mode];
  for (const cat of categories) {
    if (!allowed.includes(cat)) {
      return {
        config: null,
        error: allowed.length === 0
          ? `config.categories: ${config.mode} scouts do not support categories (scope with watch_ids)`
          : `config.categories: unknown ${config.mode} category "${cat}" (valid: ${
            allowed.join(", ")
          })`,
      };
    }
  }

  // Every scout must list the specific objects it tracks. Area-only and
  // categories-only scouts would alert on all matching traffic entering the
  // area — rejected (product decision 2026-07-04).
  if (watchIds.length === 0) {
    const idKind = config.mode === "vessel"
      ? "MMSIs"
      : config.mode === "aircraft"
      ? "ICAO hex codes"
      : "NORAD ids";
    return {
      config: null,
      error:
        `config: ${config.mode} scouts require watch_ids — the specific ${idKind} to track (categories only narrow a watch list, they cannot replace one)`,
    };
  }
  // Vessel mode reads the shared AIS sampler, which only covers active
  // geofences — a watch-list-only vessel scout would have no data source.
  if (config.mode === "vessel" && !geofence) {
    return {
      config: null,
      error:
        "config: vessel scouts require a geofence (the shared AIS feed is sampled per area; watch the tracked MMSIs within a fixed area)",
    };
  }
  // Satellite mode predicts overflights: besides the NORAD watch_ids
  // (required above for every mode) it needs the area to predict passes over.
  if (config.mode === "satellite" && !geofence) {
    return {
      config: null,
      error:
        "config: satellite scouts require a geofence (the area to predict overflights of)",
    };
  }
  for (const id of watchIds) {
    const err = watchIdError(config.mode, id);
    if (err) return { config: null, error: `config.watch_ids: ${err}` };
  }

  return {
    config: {
      ...config,
      geofence: config.geofence
        ? {
          ...config.geofence,
          display_name: config.geofence.display_name?.trim() || undefined,
          maptiler_id: config.geofence.maptiler_id?.trim() || undefined,
        }
        : undefined,
      watch_ids: watchIds.length > 0 ? watchIds : undefined,
      criteria: config.criteria?.trim() || undefined,
    },
    error: null,
  };
}
