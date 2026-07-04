/**
 * aisstream.io frame parsing + bounding-box union for the transport sampler.
 * Pure functions — no network, no DB — so they unit-test against a recorded
 * fixture. See the U3 volume probe (2026-07-03) for the message shapes:
 * frames arrive as JSON with a MessageType discriminator and a MetaData
 * envelope carrying MMSI / ShipName / lat / lon / time_utc.
 */

import {
  classifyByAisType,
  flagFromMmsi,
  isMilitaryAisType,
  type VesselClass,
} from "../_shared/vessel_classify.ts";

/** Latest known state for one vessel, coalesced across a sampling window. */
export interface VesselPosition {
  mmsi: string;
  lat: number;
  lon: number;
  course: number | null;
  speedKnots: number | null;
  heading: number | null;
  navStatus: number | null;
  shipType: number | null;
  classification: VesselClass;
  military: boolean;
  name: string | null;
  flag: string | null;
  seenAt: string; // ISO
}

type AisFrame = {
  MessageType?: string;
  Message?: Record<string, Record<string, unknown>>;
  MetaData?: Record<string, unknown>;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Drop a value that equals an AIS "not available" sentinel so it renders as
 * "unknown" rather than a nonsense literal (ITU-R M.1371):
 *   Sog 102.3 kn, Cog 360°, TrueHeading 511, NavStatus 15. */
function numUnlessSentinel(v: unknown, sentinel: number): number | null {
  const n = num(v);
  return n === null || n === sentinel ? null : n;
}

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse one aisstream frame into a partial position update, or null if it
 * carries no usable position/identity. Position reports give lat/lon/kinematics;
 * ShipStaticData gives name + ship type (merged in by the caller).
 */
export function parseAisFrame(raw: unknown):
  | Partial<VesselPosition> & {
    mmsi: string;
  }
  | null {
  if (typeof raw !== "object" || raw === null) return null;
  const frame = raw as AisFrame;
  const meta = frame.MetaData ?? {};
  const mmsiRaw = meta.MMSI ?? meta.MMSI_String;
  const mmsi = mmsiRaw != null ? String(mmsiRaw).trim() : "";
  if (!/^\d{7,9}$/.test(mmsi)) return null;

  const type = frame.MessageType;
  const body = frame.Message ?? {};

  if (type === "PositionReport" || type === "StandardClassBPositionReport") {
    const report = body[type] ?? {};
    const lat = num(report.Latitude) ?? num(meta.latitude);
    const lon = num(report.Longitude) ?? num(meta.longitude);
    if (lat == null || lon == null) return null;
    return {
      mmsi,
      lat,
      lon,
      course: numUnlessSentinel(report.Cog, 360),
      speedKnots: numUnlessSentinel(report.Sog, 102.3),
      heading: numUnlessSentinel(report.TrueHeading, 511),
      navStatus: numUnlessSentinel(report.NavigationalStatus, 15),
      name: cleanName(meta.ShipName),
      flag: flagFromMmsi(mmsi),
      seenAt: typeof meta.time_utc === "string"
        ? new Date(meta.time_utc).toISOString()
        : new Date().toISOString(),
    };
  }

  if (type === "ShipStaticData") {
    const stat = body.ShipStaticData ?? {};
    const shipType = num(stat.Type);
    return {
      mmsi,
      shipType,
      classification: classifyByAisType(shipType),
      military: isMilitaryAisType(shipType),
      name: cleanName(stat.Name) ?? cleanName(meta.ShipName),
      flag: flagFromMmsi(mmsi),
    };
  }

  return null;
}

/**
 * Coalesce a window of frames into one latest-state row per MMSI. Position
 * fields come from the newest position report; static fields (type/name)
 * from any ShipStaticData seen for that vessel. This is the in-memory step
 * that turns thousands of frames into a few dozen batched upserts.
 */
export function coalesceFrames(frames: unknown[]): VesselPosition[] {
  const byMmsi = new Map<string, VesselPosition>();
  for (const frame of frames) {
    const update = parseAisFrame(frame);
    if (!update) continue;
    const existing = byMmsi.get(update.mmsi);
    // A position update only wins if it is strictly newer than what we hold —
    // aisstream can deliver frames out of order within a window, so a newer
    // position must not be clobbered by a late-arriving older one.
    const hasNewPosition = update.lat != null && update.lon != null;
    const positionIsNewer = hasNewPosition &&
      (existing == null || update.seenAt == null ||
        update.seenAt >= (existing.seenAt ?? ""));
    const merged: VesselPosition = {
      mmsi: update.mmsi,
      // Position (lat/lon/seenAt/kinematics) only updates from a NEWER frame.
      lat: positionIsNewer ? update.lat! : existing?.lat ?? Number.NaN,
      lon: positionIsNewer ? update.lon! : existing?.lon ?? Number.NaN,
      seenAt: positionIsNewer
        ? update.seenAt ?? new Date().toISOString()
        : existing?.seenAt ?? new Date().toISOString(),
      course: positionIsNewer
        ? update.course ?? null
        : existing?.course ?? null,
      speedKnots: positionIsNewer
        ? update.speedKnots ?? null
        : existing?.speedKnots ?? null,
      heading: positionIsNewer
        ? update.heading ?? null
        : existing?.heading ?? null,
      navStatus: positionIsNewer
        ? update.navStatus ?? null
        : existing?.navStatus ?? null,
      // Static fields (type/name/flag) merge from any frame — order-agnostic.
      shipType: update.shipType ?? existing?.shipType ?? null,
      classification: update.classification ?? existing?.classification ??
        "unknown",
      military: update.military ?? existing?.military ?? false,
      name: update.name ?? existing?.name ?? null,
      flag: update.flag ?? existing?.flag ?? null,
    };
    byMmsi.set(update.mmsi, merged);
  }
  // Drop any vessel we never got a real position for.
  return [...byMmsi.values()].filter((v) =>
    Number.isFinite(v.lat) && Number.isFinite(v.lon)
  );
}

/** Soft cap on subscription boxes per aisstream connection (KTD10). The limit
 * is unpublished; 10 is a conservative bound measured as stable. When more
 * than this many disjoint scout areas exist, `fitToBoxLimit` COARSENS them
 * into ≤ this many super-boxes (a superset — every area stays covered, at the
 * cost of over-fetching between them) rather than dropping any scout's area. */
export const MAX_SUBSCRIPTION_BOXES = 10;

export interface BBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** aisstream subscription format: [[[minLat,minLon],[maxLat,maxLon]], ...]. */
export function toSubscriptionBoxes(boxes: BBox[]): number[][][] {
  return boxes.map((b) => [[b.minLat, b.minLon], [b.maxLat, b.maxLon]]);
}

function boxesOverlap(a: BBox, b: BBox): boolean {
  return !(
    a.maxLat < b.minLat || a.minLat > b.maxLat ||
    a.maxLon < b.minLon || a.minLon > b.maxLon
  );
}

function mergeBox(a: BBox, b: BBox): BBox {
  return {
    minLat: Math.min(a.minLat, b.minLat),
    minLon: Math.min(a.minLon, b.minLon),
    maxLat: Math.max(a.maxLat, b.maxLat),
    maxLon: Math.max(a.maxLon, b.maxLon),
  };
}

/**
 * Merge overlapping scout bboxes so the sampler opens the fewest subscription
 * boxes. Runs to a fixed point (merging two boxes can create a third overlap).
 */
export function unionBoxes(boxes: BBox[]): BBox[] {
  let current = [...boxes];
  let merged = true;
  while (merged) {
    merged = false;
    const next: BBox[] = [];
    for (const box of current) {
      const hit = next.findIndex((n) => boxesOverlap(n, box));
      if (hit >= 0) {
        next[hit] = mergeBox(next[hit], box);
        merged = true;
      } else {
        next.push(box);
      }
    }
    current = next;
  }
  return current;
}

/** Approx km² area of a bbox (for choosing the cheapest coarsening merge). */
function boxArea(b: BBox): number {
  const midLat = (b.minLat + b.maxLat) / 2;
  const h = (b.maxLat - b.minLat) * 111;
  const w = Math.abs(
    (b.maxLon - b.minLon) * 111 * Math.cos((midLat * Math.PI) / 180),
  );
  return Math.max(h, 0.001) * Math.max(w, 0.001);
}

/**
 * Reduce a set of (already unioned, disjoint) boxes to at most `limit` by
 * greedily merging the pair whose combined box adds the least extra area.
 * The result is a SUPERSET of the input — every scout area stays covered,
 * over-fetching between merged areas (post-filtered per scout). Never drops
 * coverage. Returns the input unchanged when already within the limit.
 */
export function fitToBoxLimit(boxes: BBox[], limit: number): BBox[] {
  let current = [...boxes];
  while (current.length > limit) {
    let bestI = 0, bestJ = 1, bestCost = Infinity;
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const combined = mergeBox(current[i], current[j]);
        const cost = boxArea(combined) - boxArea(current[i]) -
          boxArea(current[j]);
        if (cost < bestCost) {
          bestCost = cost;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const combined = mergeBox(current[bestI], current[bestJ]);
    current = current.filter((_, k) => k !== bestI && k !== bestJ);
    current.push(combined);
  }
  return current;
}
