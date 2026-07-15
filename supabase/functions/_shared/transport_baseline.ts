import type { TransportConfig, TransportMode } from "./transport_config.ts";

/** A 24-hour satellite preview can contain several passes for each of the
 * twenty watched objects. Keep the hand-off bounded without truncating a
 * realistic Fleet baseline. */
export const MAX_TRANSPORT_BASELINE_IDS = 500;

const SATELLITE_PASS_ID_RE =
  /^pass:([1-9]\d{0,8}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

export interface TransportBaselineRow {
  scout_id: string;
  user_id: string;
  object_id: string;
  first_seen: string;
  last_seen: string;
  alerted_at: string;
}

/** Normalize the preview hand-off exactly as transport state does. */
export function normalizeTransportBaselineIds(ids: string[]): string[] {
  return [
    ...new Set(ids.map((id) => {
      const trimmed = id.trim();
      const pass = /^pass:([1-9]\d{0,8}):(.+)$/i.exec(trimmed);
      if (pass && !Number.isNaN(Date.parse(pass[2]))) {
        return `pass:${pass[1]}:${new Date(pass[2]).toISOString()}`;
      }
      return trimmed.toLowerCase();
    })),
  ];
}

/** Reject client-tampered baseline ids that could not have been returned for
 * the normalized config. Satellite state uses pass keys rather than NORAD ids. */
export function transportBaselineIdError(
  mode: TransportMode,
  watchIds: string[],
  id: string,
): string | null {
  const normalized = normalizeTransportBaselineIds([id])[0] ?? "";
  if (!normalized) return "baseline id must not be empty";
  if (normalized.length > 128) {
    return "baseline id must be 128 characters or less";
  }
  if (/\p{Cc}/u.test(normalized)) {
    return "baseline id must not contain control characters";
  }

  const watched = new Set(watchIds);
  if (mode === "satellite") {
    const match = SATELLITE_PASS_ID_RE.exec(normalized);
    if (!match || Number.isNaN(Date.parse(match[2]))) {
      return `invalid satellite pass id: ${id}`;
    }
    if (!watched.has(match[1])) {
      return `satellite pass id is not in config.watch_ids: ${id}`;
    }
    return null;
  }

  if (!watched.has(normalized)) {
    return `${mode} baseline id is not in config.watch_ids: ${id}`;
  }
  return null;
}

export function validateTransportBaselineIds(
  config: TransportConfig,
  ids: string[],
): string | null {
  if (ids.length > MAX_TRANSPORT_BASELINE_IDS) {
    return `transport_baseline_ids must contain at most ${MAX_TRANSPORT_BASELINE_IDS} ids`;
  }
  for (const id of ids) {
    const error = transportBaselineIdError(
      config.mode,
      config.watch_ids ?? [],
      id,
    );
    if (error) return error;
  }
  return null;
}

export function buildTransportBaselineRows(
  scoutId: string,
  userId: string,
  ids: string[],
  observedAt: string,
): TransportBaselineRow[] {
  return normalizeTransportBaselineIds(ids).map((objectId) => ({
    scout_id: scoutId,
    user_id: userId,
    object_id: objectId,
    first_seen: observedAt,
    last_seen: observedAt,
    alerted_at: observedAt,
  }));
}
