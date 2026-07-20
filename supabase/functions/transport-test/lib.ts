import type { SupabaseClient } from "../_shared/supabase.ts";
import { ApiError, ValidationError } from "../_shared/errors.ts";
import {
  type TransportConfig,
  validateTransportConfig,
} from "../_shared/transport_config.ts";
import {
  type AircraftObject,
  fetchAircraftCandidates,
  fetchWatchlistHexes,
  filterAircraft,
  watchlistPopulated,
} from "../scout-transport-execute/aircraft.ts";
import {
  type ResolvedGeofence,
  resolveGeofence,
} from "../scout-transport-execute/geofence.ts";
import {
  fetchWatchedElements,
  type GpElement,
  isGpCacheFresh,
  passStateKey,
  type PassWindow,
  predictPasses,
} from "../scout-transport-execute/satellite.ts";
import {
  fetchVesselsInGeofence,
  filterVessels,
  type VesselObject,
} from "../scout-transport-execute/vessel.ts";
import { refreshGpCache } from "../transport-sampler/gp.ts";
import { upsertPositions } from "../transport-sampler/sampler.ts";
import {
  sampleVesselApiPositions,
  VesselApiRequestError,
} from "../transport-sampler/vesselapi.ts";

const PREVIEW_LIMIT = 20;

export interface TransportTestResult {
  valid: true;
  baseline_ids: string[];
  preview: Array<{ id: string; label: string }>;
}

export interface TransportTestDependencies {
  now(): Date;
  resolveGeofence(config: TransportConfig): Promise<ResolvedGeofence | null>;
  fetchAircraft(
    config: TransportConfig,
    geofence: ResolvedGeofence | null,
  ): Promise<AircraftObject[]>;
  fetchAircraftWatchlist(
    candidateIds: string[],
    categories: string[],
  ): Promise<Set<string>>;
  aircraftWatchlistPopulated(categories: string[]): Promise<boolean>;
  ensureVesselCoverage(
    geofence: ResolvedGeofence,
    watchIds: string[],
  ): Promise<void>;
  ensureGpCoverage(): Promise<void>;
  fetchVessels(geofence: ResolvedGeofence): Promise<VesselObject[]>;
  fetchElements(noradIds: number[]): Promise<GpElement[]>;
  predictPasses(
    element: GpElement,
    geofence: ResolvedGeofence,
    now: Date,
  ): PassWindow[];
}

async function ensureLiveVesselCoverage(
  svc: SupabaseClient,
  _geofence: ResolvedGeofence,
  watchIds: string[],
): Promise<void> {
  const apiKey = Deno.env.get("VESSELAPI_API_KEY")?.trim();
  if (!apiKey) {
    throw new ApiError(
      "VesselAPI live test is unavailable because VESSELAPI_API_KEY is not configured",
      503,
      "transport_data_unavailable",
    );
  }
  let sample;
  try {
    sample = await sampleVesselApiPositions({ apiKey, watchIds });
  } catch (error) {
    const providerCode = error instanceof VesselApiRequestError
      ? error.code
      : "vesselapi_unhandled_error";
    throw new ApiError(
      `VesselAPI live test failed (${providerCode})`,
      503,
      "transport_data_unavailable",
    );
  }
  if (sample.missingIds.length > 0) {
    throw new ApiError(
      `VesselAPI could not confirm a current position for MMSI ${
        sample.missingIds.join(", ")
      }; verify the identifier or try again when the vessel is reporting`,
      503,
      "transport_data_unavailable",
    );
  }
  await upsertPositions(svc, sample.positions);
}

async function ensureLiveGpCoverage(svc: SupabaseClient): Promise<void> {
  let freshness = await isGpCacheFresh(svc);
  if (!freshness.fresh) {
    await refreshGpCache(svc);
    freshness = await isGpCacheFresh(svc);
  }
  if (!freshness.fresh) {
    throw new ApiError(
      freshness.freshestFetchedAt
        ? `orbital-element cache stale (freshest ${freshness.freshestFetchedAt}); GP refresh may be behind`
        : "no orbital elements cached after GP refresh",
      503,
      "transport_data_unavailable",
    );
  }
}

export function transportTestDependencies(
  svc: SupabaseClient,
): TransportTestDependencies {
  return {
    now: () => new Date(),
    resolveGeofence: (config) => resolveGeofence(svc, config),
    fetchAircraft: (config, geofence) =>
      fetchAircraftCandidates(config, geofence),
    fetchAircraftWatchlist: (ids, categories) =>
      fetchWatchlistHexes(svc, ids, categories),
    aircraftWatchlistPopulated: (categories) =>
      watchlistPopulated(svc, categories),
    ensureVesselCoverage: (geofence, watchIds) =>
      ensureLiveVesselCoverage(svc, geofence, watchIds),
    ensureGpCoverage: () => ensureLiveGpCoverage(svc),
    fetchVessels: (geofence) => fetchVesselsInGeofence(svc, geofence),
    fetchElements: (ids) => fetchWatchedElements(svc, ids),
    predictPasses: (element, geofence, now) =>
      predictPasses(element, geofence, now),
  };
}

/** Run the same fetch/filter/id pipeline as scout-transport-execute without
 * creating a run, writing state, applying LLM criteria, or charging credits. */
export async function runTransportTest(
  rawConfig: unknown,
  deps: TransportTestDependencies,
): Promise<TransportTestResult> {
  const validated = validateTransportConfig(rawConfig);
  if (validated.config === null) throw new ValidationError(validated.error);
  const config = validated.config;
  const geofence = await deps.resolveGeofence(config);
  const labels = new Map<string, string>();

  if (config.mode === "aircraft") {
    if (!await deps.aircraftWatchlistPopulated(config.categories ?? [])) {
      throw new ApiError(
        "aircraft watchlist not loaded for the requested category; run refresh-transport-watchlists",
        503,
        "transport_data_unavailable",
      );
    }
    const candidates = await deps.fetchAircraft(config, geofence);
    const watchlist = await deps.fetchAircraftWatchlist(
      candidates.map((aircraft) => aircraft.id),
      config.categories ?? [],
    );
    for (const aircraft of filterAircraft(config, candidates, watchlist)) {
      labels.set(
        aircraft.id,
        aircraft.callsign || aircraft.registration || aircraft.id.toUpperCase(),
      );
    }
  } else if (config.mode === "vessel") {
    if (!geofence) throw new ValidationError("vessel scout has no geofence");
    await deps.ensureVesselCoverage(geofence, config.watch_ids ?? []);
    const vessels = filterVessels(config, await deps.fetchVessels(geofence));
    for (const vessel of vessels) {
      labels.set(vessel.id, vessel.name || `MMSI ${vessel.id}`);
    }
  } else {
    if (!geofence) throw new ValidationError("satellite scout has no geofence");
    await deps.ensureGpCoverage();
    const noradIds = (config.watch_ids ?? []).map(Number);
    const elements = await deps.fetchElements(noradIds);
    const now = deps.now();
    for (const element of elements) {
      for (const pass of deps.predictPasses(element, geofence, now)) {
        const id = passStateKey(pass);
        const name = pass.name || `NORAD ${pass.noradId}`;
        labels.set(id, `${name} · ${pass.startIso}`);
      }
    }
  }

  const baselineIds = [...labels.keys()].sort();
  return {
    valid: true,
    baseline_ids: baselineIds,
    preview: baselineIds.slice(0, PREVIEW_LIMIT).map((id) => ({
      id,
      label: labels.get(id)!,
    })),
  };
}
