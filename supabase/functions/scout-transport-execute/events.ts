/**
 * Entry-event composition + feed persistence for transport scouts.
 *
 * Each entrant becomes one `information_units` row (type 'event') plus a
 * `unit_occurrences` provenance row (source_kind 'scout'). Deliberately NO
 * semantic/embedding dedup (PRD KTD3): positional identity is exact, and the
 * state machine already guarantees one event per entry.
 */

import type { SupabaseClient } from "../_shared/supabase.ts";
import { sha256Hex } from "../_shared/unit_dedup.ts";
import { logEvent } from "../_shared/log.ts";
import type { AircraftObject } from "./aircraft.ts";
import type { VesselObject } from "./vessel.ts";
import type { TransportMode } from "../_shared/transport_config.ts";

/** Data source per mode — used for feed provenance AND email attribution. */
export const MODE_SOURCE: Record<
  TransportMode,
  { domain: string; label: string }
> = {
  aircraft: { domain: "adsb.lol", label: "adsb.lol (ODbL)" },
  vessel: { domain: "vesselapi.com", label: "VesselAPI (AIS)" },
  satellite: { domain: "celestrak.org", label: "CelesTrak (public domain)" },
};

function formatUtc(ts: Date): string {
  return `${String(ts.getUTCHours()).padStart(2, "0")}:${
    String(ts.getUTCMinutes()).padStart(2, "0")
  } UTC`;
}

function aircraftLabel(a: AircraftObject): string {
  const name = a.callsign ?? a.registration ?? a.id.toUpperCase();
  const detail = [
    a.registration && a.registration !== name ? a.registration : null,
    a.aircraftType,
  ]
    .filter(Boolean).join(", ");
  return detail ? `${name} (${detail})` : name;
}

export interface AlertScope {
  /** Preset/circle name, or "watch list" for geofence-less scouts. */
  name: string;
  isWatchlist: boolean;
}

export function composeAircraftStatement(
  a: AircraftObject,
  scope: AlertScope,
  ts: Date,
): string {
  const kind = a.military ? "Military aircraft" : "Aircraft";
  const track = a.trackDeg !== null
    ? `, heading ${Math.round(a.trackDeg).toString().padStart(3, "0")}°`
    : "";
  const alt = a.altitudeFt !== null
    ? ` at ${Math.round(a.altitudeFt).toLocaleString("en-US")} ft`
    : "";
  if (scope.isWatchlist) {
    return `Watched ${
      kind === "Military aircraft" ? "military aircraft" : "aircraft"
    } ${aircraftLabel(a)} appeared at ${a.lat.toFixed(2)}, ${
      a.lon.toFixed(2)
    } (${formatUtc(ts)})${track}${alt}.`;
  }
  return `${kind} ${aircraftLabel(a)} entered ${scope.name} at ${
    formatUtc(ts)
  }${track}${alt}.`;
}

const VESSEL_CLASS_LABEL: Record<string, string> = {
  tanker: "Tanker",
  cargo: "Cargo vessel",
  passenger: "Passenger vessel",
  fishing: "Fishing vessel",
  hsc: "High-speed craft",
  tug_special: "Special-purpose vessel",
  pleasure: "Pleasure craft",
  other: "Vessel",
  unknown: "Vessel",
};

function vesselLabel(v: VesselObject): string {
  const cls = v.military
    ? "Military vessel"
    : VESSEL_CLASS_LABEL[v.classification] ?? "Vessel";
  const name = v.name ?? `MMSI ${v.id}`;
  const flag = v.flag ? `, ${v.flag}` : "";
  const named = v.name ? `${name} (MMSI ${v.id}${flag})` : `${name}${flag}`;
  return `${cls} ${named}`;
}

export function composeVesselStatement(
  v: VesselObject,
  scope: AlertScope,
  ts: Date,
): string {
  const course = v.courseDeg !== null
    ? `, course ${Math.round(v.courseDeg).toString().padStart(3, "0")}°`
    : "";
  const speed = v.speedKnots !== null
    ? ` at ${v.speedKnots.toFixed(1)} kn`
    : "";
  if (scope.isWatchlist) {
    return `Watched ${vesselLabel(v)} appeared at ${v.lat.toFixed(2)}, ${
      v.lon.toFixed(2)
    } (${formatUtc(ts)})${course}${speed}.`;
  }
  return `${vesselLabel(v)} entered ${scope.name} at ${
    formatUtc(ts)
  }${course}${speed}.`;
}

/** Composes a predicted-pass statement for a satellite overflight window. */
export function composeSatelliteStatement(
  pass: {
    noradId: number;
    name: string | null;
    startIso: string;
    endIso: string;
  },
  areaName: string,
): string {
  const label = pass.name
    ? `${pass.name} (NORAD ${pass.noradId})`
    : `NORAD ${pass.noradId}`;
  const start = new Date(pass.startIso);
  const day = start.toISOString().slice(0, 10);
  return `Satellite ${label} predicted to pass over ${areaName} on ${day} from ${
    formatUtc(start)
  } to ${formatUtc(new Date(pass.endIso))} (TLE/OMM prediction).`;
}

export interface EntrantEvent {
  objectId: string;
  statement: string;
}

/** Thrown when feed persistence fails partway: `written` carries the object
 * ids whose units DID land, so the caller can unclaim only the undelivered
 * entrants (their alert must fire on a later run). */
export class UnitWriteError extends Error {
  written: string[];
  constructor(message: string, written: string[]) {
    super(message);
    this.name = "UnitWriteError";
    this.written = written;
  }
}

/** Persist one feed event per entrant. Failures here must fail the run
 * (units are the product's durable record); partial progress is reported
 * via UnitWriteError so claims can be rolled back precisely. */
export async function writeEntrantUnits(
  svc: SupabaseClient,
  args: {
    scoutId: string;
    userId: string;
    runId: string;
    events: EntrantEvent[];
    areaName: string;
    sourceDomain: string;
    now?: Date;
  },
): Promise<void> {
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const written: string[] = [];
  for (const event of args.events) {
    const statementHash = await sha256Hex(
      `transport|${args.scoutId}|${event.objectId}|${event.statement}`,
    );
    const { data: unit, error: unitErr } = await svc
      .from("information_units")
      .insert({
        user_id: args.userId,
        scout_id: args.scoutId,
        scout_type: "transport",
        statement: event.statement,
        type: "event",
        entities: [event.objectId],
        source_domain: args.sourceDomain,
        source_title: args.areaName,
        event_date: nowIso.slice(0, 10),
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        occurrence_count: 1,
        source_count: 1,
      })
      .select("id")
      .single();
    if (unitErr) throw new UnitWriteError(unitErr.message, written);

    const { error: occErr } = await svc
      .from("unit_occurrences")
      .insert({
        unit_id: unit.id,
        user_id: args.userId,
        scout_id: args.scoutId,
        scout_run_id: args.runId,
        scout_type: "transport",
        source_kind: "scout",
        source_domain: args.sourceDomain,
        source_title: args.areaName,
        statement_hash: statementHash,
        content_sha256: statementHash,
        occurred_at: nowIso,
        extracted_at: nowIso,
      });
    // The unit row itself landed, so the entrant's feed record exists even
    // if the provenance row failed — count it delivered either way.
    written.push(event.objectId);
    if (occErr) throw new UnitWriteError(occErr.message, written);
  }
  logEvent({
    level: "info",
    fn: "scout-transport-execute",
    event: "units_written",
    scout_id: args.scoutId,
    run_id: args.runId,
    msg: `${args.events.length} entry event(s)`,
  });
}
