/**
 * Transport scout config — schema + validation shared by the scouts Edge
 * Function (create/update) and scout-transport-execute (run time).
 *
 * The config lives in scouts.config JSONB:
 *   { mode, geofence?, watch_ids?, categories?, criteria? }
 *
 * A transport scout needs a geofence, watch_ids, or both. Geofences are a
 * named preset (transport_geofence_presets row) or center + radius_km.
 */

import { z } from "https://esm.sh/zod@3";

export const TRANSPORT_MODES = ["vessel", "aircraft", "satellite"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

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

const GeofenceSchema = z.object({
  preset_id: z.string().min(1).max(100).optional(),
  center: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    })
    .optional(),
  radius_km: z.number().positive().max(MAX_RADIUS_KM).optional(),
});

export const TransportConfigSchema = z.object({
  mode: z.enum(TRANSPORT_MODES),
  geofence: GeofenceSchema.optional(),
  watch_ids: z.array(z.string().min(1).max(20)).max(50).optional(),
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
  if (!geofence && watchIds.length === 0) {
    return {
      config: null,
      error: "config: transport scouts require a geofence, watch_ids, or both",
    };
  }
  // Vessel mode reads the shared AIS sampler, which only covers active
  // geofences — a watch-list-only vessel scout would have no data source.
  if (config.mode === "vessel" && !geofence) {
    return {
      config: null,
      error:
        "config: vessel scouts require a geofence (the shared AIS feed is sampled per area; watch a fixed area and optionally add watch_ids/categories within it)",
    };
  }
  // Satellite mode predicts overflights: it needs BOTH which satellites
  // (watch_ids = NORAD ids) and the area to predict passes over (geofence).
  if (config.mode === "satellite") {
    if (!geofence) {
      return {
        config: null,
        error:
          "config: satellite scouts require a geofence (the area to predict overflights of)",
      };
    }
    if (watchIds.length === 0) {
      return {
        config: null,
        error:
          "config: satellite scouts require watch_ids (the NORAD catalog ids to track)",
      };
    }
  }
  for (const id of watchIds) {
    const err = watchIdError(config.mode, id);
    if (err) return { config: null, error: `config.watch_ids: ${err}` };
  }

  return {
    config: {
      ...config,
      watch_ids: watchIds.length > 0 ? watchIds : undefined,
      criteria: config.criteria?.trim() || undefined,
    },
    error: null,
  };
}
