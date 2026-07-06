/**
 * Aircraft mode — adsb.lol fetch + normalization + filtering.
 *
 * Sources (both free, ODbL, no key today — see DATA-ATTRIBUTION note in
 * docs/features/transport.md, U7):
 *   - military-category scouts: GET /v2/mil (global) intersected with the
 *     geofence — no point queries.
 *   - everything else: GET /v2/lat/{lat}/lon/{lon}/dist/{nm} per query tile
 *     (≤250 nm each), hex-deduped across tiles.
 */

import { logEvent } from "../_shared/log.ts";
import type { SupabaseClient } from "../_shared/supabase.ts";
import type { TransportConfig } from "../_shared/transport_config.ts";
import {
  pointInGeofence,
  type ResolvedGeofence,
  tileGeofence,
} from "./geofence.ts";

const ADSB_BASE = "https://api.adsb.lol/v2";
const FETCH_TIMEOUT_MS = 15_000;

export interface AircraftObject {
  /** Lowercased 24-bit ICAO hex — the stable state identity. */
  id: string;
  lat: number;
  lon: number;
  callsign: string | null;
  registration: string | null;
  aircraftType: string | null;
  altitudeFt: number | null;
  speedKts: number | null;
  trackDeg: number | null;
  military: boolean;
}

interface AdsbAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | string;
  gs?: number;
  track?: number;
  lat?: number;
  lon?: number;
  dbFlags?: number;
}

/** Normalize one adsb.lol record; null for records without usable identity
 * or position (TIS-B "~" pseudo-addresses are not stable airframe ids). */
export function normalizeAircraft(raw: AdsbAircraft): AircraftObject | null {
  const hex = (raw.hex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  if (typeof raw.lat !== "number" || typeof raw.lon !== "number") return null;
  const altBaro = typeof raw.alt_baro === "number" ? raw.alt_baro : null;
  return {
    id: hex,
    lat: raw.lat,
    lon: raw.lon,
    callsign: raw.flight?.trim() || null,
    registration: raw.r?.trim() || null,
    aircraftType: raw.t?.trim() || null,
    altitudeFt: altBaro,
    speedKts: typeof raw.gs === "number" ? raw.gs : null,
    trackDeg: typeof raw.track === "number" ? raw.track : null,
    // dbFlags bit 0 = military per the adsb.lol/tar1090 database convention.
    military: ((raw.dbFlags ?? 0) & 1) === 1,
  };
}

export function parseAdsbResponse(payload: unknown): AircraftObject[] {
  const list = (payload as { ac?: AdsbAircraft[] })?.ac;
  if (!Array.isArray(list)) return [];
  const out: AircraftObject[] = [];
  for (const raw of list) {
    const normalized = normalizeAircraft(raw);
    if (normalized) out.push(normalized);
  }
  return out;
}

/** Wait before retrying a 429 when the server gives no (sane) Retry-After —
 * live probing (2026-07-06) shows adsb.lol sends 429 with NO Retry-After
 * after a burst of ~5 requests, and Edge Functions share egress IPs with
 * other tenants, so the budget may already be partly consumed. */
const RATE_LIMIT_RETRY_MS = 2000;

async function fetchAdsb(path: string): Promise<AircraftObject[]> {
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${ADSB_BASE}${path}`, {
        headers: { "Accept": "application/json" },
        signal: ac.signal,
      });
      // One polite retry on rate limiting; a second 429 falls through to the
      // generic error and the run's non-billable failure path.
      if (res.status === 429 && attempt === 0) {
        await res.body?.cancel();
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 &&
            retryAfter <= 30
          ? retryAfter * 1000
          : RATE_LIMIT_RETRY_MS;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`adsb.lol ${path} responded ${res.status}`);
      }
      return parseAdsbResponse(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }
}

/** True when the scout's category filter selects military traffic only —
 * that routes to the global /v2/mil list instead of point queries. */
export function isMilitaryOnly(config: TransportConfig): boolean {
  const cats = config.categories ?? [];
  return cats.length > 0 && cats.every((c) => c === "military");
}

/**
 * Fetch the aircraft candidate set for a scout. Watch-ID-only scouts (no
 * geofence) are matched against the military list plus each watched hex via
 * /v2/hex — cheap and global.
 */
export async function fetchAircraftCandidates(
  config: TransportConfig,
  geofence: ResolvedGeofence | null,
): Promise<AircraftObject[]> {
  if (geofence === null) {
    // Watch-ids anywhere: ONE batched /v2/hex/{a},{b},… query for the whole
    // watch list. Verified live 2026-07-06: the route accepts a comma list
    // and returns all matching aircraft. Per-hex loops (even paced at ~1/s)
    // kept tripping adsb.lol's burst limiter (~5 requests, no Retry-After)
    // from Supabase's shared egress IPs — QA runs died on the 4th hex.
    // Watch lists cap at 50 ids (~350 URL chars), well within limits.
    const hexes = config.watch_ids ?? [];
    if (hexes.length === 0) return [];
    return await fetchAdsb(`/hex/${hexes.join(",")}`);
  }

  if (isMilitaryOnly(config)) {
    const all = await fetchAdsb("/mil");
    return all.filter((a) => pointInGeofence(geofence, a.lat, a.lon));
  }

  const tiles = tileGeofence(geofence);
  const byHex = new Map<string, AircraftObject>();
  for (const tile of tiles) {
    const batch = await fetchAdsb(
      `/lat/${tile.lat.toFixed(4)}/lon/${
        tile.lon.toFixed(4)
      }/dist/${tile.radiusNm}`,
    );
    for (const a of batch) byHex.set(a.id, a);
  }
  logEvent({
    level: "info",
    fn: "scout-transport-execute",
    event: "adsb_fetch",
    msg: `${tiles.length} tile(s), ${byHex.size} unique aircraft`,
  });
  return [...byHex.values()].filter((a) =>
    pointInGeofence(geofence, a.lat, a.lon)
  );
}

import { AIRCRAFT_WATCHLIST_CATEGORIES } from "../_shared/plane_alert.ts";

/** Categories resolved via the bundled watchlist (plane-alert-db). */
const WATCHLIST_CATEGORIES = new Set<string>(AIRCRAFT_WATCHLIST_CATEGORIES);

/** Max hexes per PostgREST .in() query — the whole set is url-encoded into
 * the GET query string, so a busy geofence's thousands of hexes must be
 * chunked to stay under the gateway URI limit. */
const WATCHLIST_QUERY_BATCH = 150;

/**
 * Fetch the subset of candidate hexes that appear in transport_watchlists
 * under any requested category. Batched so a large candidate set can't blow
 * the URI length limit (which would throw → auto-deactivate the scout).
 * Keyed on lowercased ICAO hex (ident_type 'icao_hex').
 */
export async function fetchWatchlistHexes(
  svc: SupabaseClient,
  hexes: string[],
  categories: string[],
): Promise<Set<string>> {
  const wanted = categories.filter((c) => WATCHLIST_CATEGORIES.has(c));
  if (wanted.length === 0 || hexes.length === 0) return new Set();
  const found = new Set<string>();
  for (let i = 0; i < hexes.length; i += WATCHLIST_QUERY_BATCH) {
    const batch = hexes.slice(i, i + WATCHLIST_QUERY_BATCH);
    const { data, error } = await svc
      .from("transport_watchlists")
      .select("ident")
      .eq("ident_type", "icao_hex")
      .in("category", wanted)
      .in("ident", batch);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) found.add(r.ident as string);
  }
  return found;
}

/** Categories that REQUIRE the watchlist (no adsb.lol fallback). 'military'
 * is excluded — it falls back to the dbFlags military bit, so it works even
 * with an empty watchlist. */
const WATCHLIST_REQUIRED_CATEGORIES = new Set(["government", "police", "civil"]);

/** True unless a fallback-less watchlist category was requested and the
 * watchlist has no rows for it — used to distinguish "watchlist not loaded"
 * (skip the run) from "loaded but no candidate matched" (a real zero-entrant
 * success). A gov/police/civil scout with an empty table would otherwise
 * silently report no traffic forever. */
export async function watchlistPopulated(
  svc: SupabaseClient,
  categories: string[],
): Promise<boolean> {
  const required = categories.filter((c) =>
    WATCHLIST_REQUIRED_CATEGORIES.has(c)
  );
  if (required.length === 0) return true;
  const { count, error } = await svc
    .from("transport_watchlists")
    .select("ident", { count: "exact", head: true })
    .eq("ident_type", "icao_hex")
    .in("category", required);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

/**
 * Apply watch-id and category filters. `watchlistHexes` is the pre-fetched set
 * of candidate hexes matching the requested watchlist categories. A military
 * scout also keeps aircraft flagged military by adsb.lol's dbFlags, so
 * military aircraft absent from plane-alert-db are still caught.
 */
export function filterAircraft(
  config: TransportConfig,
  candidates: AircraftObject[],
  watchlistHexes: Set<string> = new Set(),
): AircraftObject[] {
  let out = candidates;
  const watch = new Set(config.watch_ids ?? []);
  if (watch.size > 0) {
    out = out.filter((a) =>
      watch.has(a.id) ||
      (a.registration && watch.has(a.registration.toLowerCase()))
    );
  }
  const cats = config.categories ?? [];
  const watchlistCats = cats.filter((c) => WATCHLIST_CATEGORIES.has(c));
  if (watchlistCats.length > 0) {
    out = out.filter((a) =>
      watchlistHexes.has(a.id) ||
      // 'military' also honors the adsb.lol dbFlags bit as a fallback.
      (cats.includes("military") && a.military)
    );
  }
  return out;
}
