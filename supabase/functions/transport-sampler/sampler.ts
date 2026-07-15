/**
 * DB + WebSocket side of the transport sampler, split from the pure ais.ts so
 * the parsing/coalescing logic stays unit-testable.
 */

import type { SupabaseClient } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";
import { resolveGeofenceBBox } from "../scout-transport-execute/geofence.ts";
import type { BBox, VesselPosition } from "./ais.ts";

const AIS_WS_URL = "wss://stream.aisstream.io/v0/stream";
const UPSERT_BATCH = 500;

/**
 * Bounding boxes of all active vessel scouts. Circle geofences are converted
 * to their circumscribed bbox; preset geofences resolve from the presets
 * table. Scouts with neither (watch-id-only) contribute no box — they still
 * work via per-run fetch, but they don't drive the shared sampler.
 */
export async function activeVesselBoxes(svc: SupabaseClient): Promise<BBox[]> {
  const { data, error } = await svc
    .from("scouts")
    .select("config")
    .eq("type", "transport")
    .eq("is_active", true);
  if (error) throw new Error(error.message);

  const vesselConfigs = (data ?? [])
    .map((row) => (row.config ?? {}) as Record<string, unknown>)
    .filter((config) => config.mode === "vessel");

  // Resolve every scout's geofence in parallel, and NEVER let one bad scout
  // (vanished preset, transient error) abort the shared sampler for everyone —
  // a failed resolve just omits that scout's box this cycle.
  const results = await Promise.allSettled(
    vesselConfigs.map((config) => resolveGeofenceBBox(svc, config)),
  );
  const boxes: BBox[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      boxes.push(r.value);
    } else if (r.status === "rejected") {
      logEvent({
        level: "warn",
        fn: "transport-sampler",
        event: "scout_box_resolve_failed",
        msg: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }
  return boxes;
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

interface SampleArgs {
  apiKey: string;
  boxes: number[][][];
  windowMs: number;
  shipMmsi?: string[];
}

export interface AisSampleResult {
  frames: unknown[];
  connected: boolean;
  errored: boolean;
}

export function aisSubscriptionMessage(
  args: Pick<SampleArgs, "apiKey" | "boxes" | "shipMmsi">,
): Record<string, unknown> {
  return {
    APIKey: args.apiKey,
    BoundingBoxes: args.boxes,
    ...(args.shipMmsi?.length ? { FiltersShipMMSI: args.shipMmsi } : {}),
    FilterMessageTypes: [
      "PositionReport",
      "StandardClassBPositionReport",
      "ShipStaticData",
    ],
  };
}

/**
 * Open one WebSocket to aisstream, collect frames for windowMs, then close.
 * Frames arrive as Blobs in Deno (measured 2026-07-03) — decode before
 * parse. A hard deadline guarantees the socket closes even if the feed goes
 * quiet mid-window.
 */
export function sampleAisWindowWithStatus(
  args: SampleArgs,
): Promise<AisSampleResult> {
  return new Promise((resolve) => {
    const frames: unknown[] = [];
    let settled = false;
    let connected = false;
    let errored = false;
    const ws = new WebSocket(AIS_WS_URL);

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // already closing
      }
      resolve({ frames, connected, errored });
    };

    const deadline = setTimeout(finish, args.windowMs);

    ws.onopen = () => {
      connected = true;
      ws.send(JSON.stringify(aisSubscriptionMessage(args)));
    };
    ws.onmessage = async (ev: MessageEvent) => {
      try {
        const raw = typeof ev.data === "string"
          ? ev.data
          : new TextDecoder().decode(
            new Uint8Array(await (ev.data as Blob).arrayBuffer()),
          );
        frames.push(JSON.parse(raw));
      } catch {
        // Skip unparseable frames; the window keeps going.
      }
    };
    ws.onerror = () => {
      errored = true;
      logEvent({
        level: "warn",
        fn: "transport-sampler",
        event: "ws_error",
        msg: "aisstream socket error; closing window early",
      });
      clearTimeout(deadline);
      finish();
    };
    ws.onclose = () => {
      clearTimeout(deadline);
      finish();
    };
  });
}

export async function sampleAisWindow(args: SampleArgs): Promise<unknown[]> {
  return (await sampleAisWindowWithStatus(args)).frames;
}

/** Batch-upsert coalesced positions by MMSI. Returns the count written. */
export async function upsertPositions(
  svc: SupabaseClient,
  positions: VesselPosition[],
): Promise<number> {
  if (positions.length === 0) return 0;
  const rows = positions.map((p) => ({
    mmsi: p.mmsi,
    lat: p.lat,
    lon: p.lon,
    course: p.course,
    speed_knots: p.speedKnots,
    heading: p.heading,
    nav_status: p.navStatus,
    ship_type: p.shipType,
    classification: p.classification,
    name: p.name,
    flag: p.flag,
    seen_at: p.seenAt,
    updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await svc
      .from("transport_positions")
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "mmsi" });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}
