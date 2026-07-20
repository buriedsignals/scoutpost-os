/**
 * Fleet Scout (type `transport`) live health benchmark — all production modes.
 *
 * Each canary creates a real user-owned Scout and audits the same two-run
 * contract: run 1 silently establishes positional state, then run 2 must not
 * re-alert any identity already in that baseline. Inputs come from the live
 * provider path rather than fixtures:
 *
 *   aircraft  — probe adsb.lol over Dover, then watch observed ICAO hexes.
 *   vessel    — sample AIS over Malacca, then watch newly cached MMSIs.
 *   satellite — refresh CelesTrak GP data, then predict ISS passes.
 *
 * Usage:
 *   scripts/benchmarks/with-linked-supabase-env.sh \
 *     deno run --allow-env --allow-net scripts/benchmarks/benchmark-transport.ts
 *
 * Required env: SCOUT_LIVE_BENCHMARK=1, SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY.
 */

import {
  assertLiveBenchmarkAllowed,
  type BenchCtx,
  dataApiHeaders,
  getBenchCtx,
  jsonOrThrow,
  pgSelectOne,
  purgeScoutUnits,
  serviceFunctionFetch,
  triggerScoutRun,
  userFetch,
  waitForScoutRun,
} from "./_bench_shared.ts";

export type TransportMode = "aircraft" | "vessel" | "satellite";

interface TransportConfig {
  mode: TransportMode;
  geofence?: {
    preset_id?: string;
    center?: { lat: number; lon: number };
    radius_km?: number;
  };
  watch_ids: string[];
}

export function aircraftCanaryConfig(watchIds: string[]): TransportConfig {
  return { mode: "aircraft", watch_ids: watchIds };
}

interface CreatedScout {
  id: string;
  baseline_established_at?: string | null;
}

export interface VesselPositionRow {
  mmsi: string;
  lat: number;
  lon: number;
  seen_at: string;
}

interface GpCacheRow {
  norad_id: number;
  name: string | null;
  fetched_at: string;
}

export interface SamplerRunRow {
  id: string;
  task: "ais" | "gp";
  status: "accepted" | "running" | "succeeded" | "failed" | "noop";
  connected: boolean | null;
  provider_errored: boolean | null;
  frames_received: number;
  items_parsed: number;
  items_written: number;
  error_code: string | null;
  error_message: string | null;
}

export function samplerRunFailureMessage(run: SamplerRunRow): string | null {
  if (run.status === "succeeded") return null;
  if (run.status === "accepted" || run.status === "running") {
    return `[sampler_timeout] ${run.task.toUpperCase()} sampler remained ${run.status}`;
  }
  return `[${run.error_code ?? `sampler_${run.status}`}] ` +
    `${run.task.toUpperCase()} sampler ${run.status}: ` +
    `${run.error_message ?? "no error message"}; connected=${run.connected}; ` +
    `provider_errored=${run.provider_errored}; frames=${run.frames_received}; ` +
    `parsed=${run.items_parsed}; written=${run.items_written}`;
}

export type VesselSamplerOutcome =
  | "ok"
  | "sampler_empty"
  | "positions_stale"
  | "no_candidates"
  | "no_geo_matches";

export function classifyVesselSamplerOutcome(input: {
  newestSeenAt: string | null;
  sampledAfter: Date;
  freshCandidateCount: number;
  freshGeofenceCount: number;
}): VesselSamplerOutcome {
  if (!input.newestSeenAt) return "sampler_empty";
  if (
    new Date(input.newestSeenAt).getTime() < input.sampledAfter.getTime()
  ) {
    return "positions_stale";
  }
  if (input.freshCandidateCount === 0) return "no_candidates";
  if (input.freshGeofenceCount === 0) return "no_geo_matches";
  return "ok";
}

const DORMANT_CRON = "0 0 1 1 *";
const DAILY_CRON = "0 0 * * *";
const RUN_TIMEOUT_MS = 4 * 60_000;
const POLL_INTERVAL_MS = 3_000;
const SAMPLER_TIMEOUT_MS = 90_000;
const MAX_WATCH_IDS = 20;

const DOVER_PRESET = "dover-strait";
const DOVER_PROBE = { lat: 51.0, lon: 1.5, distNm: 60 };
const MALACCA_PRESET = "strait-of-malacca";
const MALACCA_BOUNDS = { minLat: 1, maxLat: 6.5, minLon: 98, maxLon: 104 };
const BOOTSTRAP_MMSI = "563024500";
const ISS_NORAD_ID = "25544";
const ISS_GEOFENCE = {
  center: { lat: 0, lon: 0 },
  radius_km: 1500,
};

export function modeScheduleCron(mode: TransportMode): string {
  return mode === "satellite" ? DAILY_CRON : DORMANT_CRON;
}

export function selectFreshMalaccaVessels(
  rows: VesselPositionRow[],
  sampledAfter: Date,
): VesselPositionRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.mmsi) || !/^[2-7]\d{8}$/.test(row.mmsi)) return false;
    if (new Date(row.seen_at).getTime() < sampledAfter.getTime()) return false;
    if (
      row.lat < MALACCA_BOUNDS.minLat || row.lat > MALACCA_BOUNDS.maxLat ||
      row.lon < MALACCA_BOUNDS.minLon || row.lon > MALACCA_BOUNDS.maxLon
    ) return false;
    seen.add(row.mmsi);
    return true;
  }).slice(0, MAX_WATCH_IDS);
}

export function reAlertedObjectIds(
  baselined: string[],
  alerted: string[],
): string[] {
  const baseline = new Set(baselined);
  return [...new Set(alerted.filter((id) => baseline.has(id)))];
}

async function probeDoverHexes(): Promise<string[]> {
  const res = await fetch(
    `https://api.adsb.lol/v2/lat/${DOVER_PROBE.lat}/lon/${DOVER_PROBE.lon}/dist/${DOVER_PROBE.distNm}`,
    { headers: { "Accept": "application/json" } },
  );
  if (!res.ok) throw new Error(`adsb.lol probe responded ${res.status}`);
  const payload = await res.json() as { ac?: { hex?: string }[] };
  return [
    ...new Set(
      (payload.ac ?? [])
        .map((aircraft) => (aircraft.hex ?? "").trim().toLowerCase())
        .filter((hex) => /^[0-9a-f]{6}$/.test(hex)),
    ),
  ].slice(0, MAX_WATCH_IDS);
}

async function createTransportScout(
  ctx: BenchCtx,
  config: TransportConfig,
): Promise<string> {
  const res = await userFetch(ctx, "/scouts", {
    method: "POST",
    body: {
      name: `bench-transport-${config.mode}-${Date.now()}`,
      type: "transport",
      schedule_cron: modeScheduleCron(config.mode),
      config,
    },
  });
  const created = await jsonOrThrow<CreatedScout>(
    res,
    `create ${config.mode} transport scout`,
  );
  if (!created.id) throw new Error("scout creation returned no id");
  return created.id;
}

async function updateTransportConfig(
  ctx: BenchCtx,
  scoutId: string,
  config: TransportConfig,
): Promise<void> {
  const res = await userFetch(ctx, `/scouts/${scoutId}`, {
    method: "PATCH",
    body: { config },
  });
  await jsonOrThrow<CreatedScout>(res, `update ${config.mode} watch list`);
}

async function pgList<T>(
  ctx: BenchCtx,
  table: string,
  query: string,
): Promise<T[]> {
  const res = await fetch(
    `${ctx.supabaseUrl}/rest/v1/${table}?${query}&limit=1000`,
    { headers: dataApiHeaders(ctx) },
  );
  if (!res.ok) throw new Error(`list ${table} responded ${res.status}`);
  return await res.json() as T[];
}

async function triggerSampler(
  ctx: BenchCtx,
  body: { task: "ais" | "gp"; window_ms?: number },
): Promise<string> {
  const result = await serviceFunctionFetch(
    ctx,
    "/functions/v1/transport-sampler",
    body,
  );
  if (result.status !== 202) {
    throw new Error(
      `transport sampler ${body.task} responded ${result.status}: ${result.text}`,
    );
  }
  let payload: { run_id?: unknown };
  try {
    payload = JSON.parse(result.text) as { run_id?: unknown };
  } catch {
    throw new Error(`transport sampler ${body.task} returned invalid JSON`);
  }
  if (typeof payload.run_id !== "string") {
    throw new Error(`transport sampler ${body.task} returned no run_id`);
  }
  return payload.run_id;
}

async function waitForSamplerRun(
  ctx: BenchCtx,
  runId: string,
): Promise<SamplerRunRow> {
  const deadline = Date.now() + SAMPLER_TIMEOUT_MS;
  let latest: SamplerRunRow | null = null;
  while (Date.now() < deadline) {
    const rows = await pgList<SamplerRunRow>(
      ctx,
      "transport_sampler_runs",
      "select=id,task,status,connected,provider_errored,frames_received," +
        "items_parsed,items_written,error_code,error_message" +
        `&id=eq.${runId}`,
    );
    latest = rows[0] ?? null;
    if (
      latest &&
      ["succeeded", "failed", "noop"].includes(latest.status)
    ) return latest;
    await delay(POLL_INTERVAL_MS);
  }
  if (latest) return latest;
  throw new Error(`[sampler_missing] no sampler heartbeat found for ${runId}`);
}

async function requireSuccessfulSamplerRun(
  ctx: BenchCtx,
  runId: string,
): Promise<SamplerRunRow> {
  const run = await waitForSamplerRun(ctx, runId);
  const failure = samplerRunFailureMessage(run);
  if (failure) throw new Error(failure);
  return run;
}

async function waitForFreshMalaccaVessels(
  ctx: BenchCtx,
  sampledAfter: Date,
): Promise<VesselPositionRow[]> {
  const deadline = Date.now() + SAMPLER_TIMEOUT_MS;
  const after = encodeURIComponent(sampledAfter.toISOString());
  while (Date.now() < deadline) {
    const rows = await pgList<VesselPositionRow>(
      ctx,
      "transport_positions",
      `select=mmsi,lat,lon,seen_at&lat=gte.${MALACCA_BOUNDS.minLat}` +
        `&lat=lte.${MALACCA_BOUNDS.maxLat}&lon=gte.${MALACCA_BOUNDS.minLon}` +
        `&lon=lte.${MALACCA_BOUNDS.maxLon}&seen_at=gte.${after}` +
        "&order=seen_at.desc",
    );
    const selected = selectFreshMalaccaVessels(rows, sampledAfter);
    if (selected.length > 0) return selected;
    await delay(POLL_INTERVAL_MS);
  }

  const newest = await pgList<VesselPositionRow>(
    ctx,
    "transport_positions",
    "select=mmsi,lat,lon,seen_at&order=seen_at.desc",
  );
  const recent = await pgList<VesselPositionRow>(
    ctx,
    "transport_positions",
    `select=mmsi,lat,lon,seen_at&seen_at=gte.${after}` +
      "&order=seen_at.desc",
  );
  const freshInMalacca = selectFreshMalaccaVessels(recent, sampledAfter);
  const outcome = classifyVesselSamplerOutcome({
    newestSeenAt: newest[0]?.seen_at ?? null,
    sampledAfter,
    freshCandidateCount: recent.length,
    freshGeofenceCount: freshInMalacca.length,
  });
  throw new Error(
    `[${outcome}] AIS sampler wrote no fresh vessel positions in Malacca before timeout; ` +
      `newest_seen_at=${newest[0]?.seen_at ?? "none"}; ` +
      `fresh_candidates=${recent.length}; fresh_malacca=${freshInMalacca.length}`,
  );
}

async function prepareVesselCanary(
  ctx: BenchCtx,
  scoutId: string,
): Promise<TransportConfig> {
  const sampledAfter = new Date(Date.now() - 1_000);
  const sampler = await requireSuccessfulSamplerRun(
    ctx,
    await triggerSampler(ctx, { task: "ais", window_ms: 30_000 }),
  );
  const vessels = await waitForFreshMalaccaVessels(ctx, sampledAfter);
  const config: TransportConfig = {
    mode: "vessel",
    geofence: { preset_id: MALACCA_PRESET },
    watch_ids: vessels.map((row) => row.mmsi),
  };
  await updateTransportConfig(ctx, scoutId, config);
  console.log(
    `vessel sampler: connected=${sampler.connected} frames=${sampler.frames_received} ` +
      `written=${sampler.items_written}; ${vessels.length} fresh MMSI(s) over ${MALACCA_PRESET}`,
  );
  return config;
}

async function waitForFreshIssElement(ctx: BenchCtx): Promise<GpCacheRow> {
  const deadline = Date.now() + SAMPLER_TIMEOUT_MS;
  const maxAgeMs = 48 * 60 * 60_000;
  while (Date.now() < deadline) {
    const rows = await pgList<GpCacheRow>(
      ctx,
      "transport_gp_cache",
      `select=norad_id,name,fetched_at&norad_id=eq.${ISS_NORAD_ID}`,
    );
    const row = rows[0];
    if (
      row && Date.now() - new Date(row.fetched_at).getTime() <= maxAgeMs
    ) return row;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    "GP sampler did not produce a fresh ISS element before timeout",
  );
}

async function prepareSatelliteCanary(ctx: BenchCtx): Promise<void> {
  const sampler = await requireSuccessfulSamplerRun(
    ctx,
    await triggerSampler(ctx, { task: "gp" }),
  );
  const iss = await waitForFreshIssElement(ctx);
  console.log(
    `satellite sampler: written=${sampler.items_written}; ` +
      `${iss.name ?? "ISS"} GP fetched ${iss.fetched_at}`,
  );
}

async function listBaselinedObjectIds(
  ctx: BenchCtx,
  scoutId: string,
): Promise<string[]> {
  const rows = await pgList<{ object_id: string }>(
    ctx,
    "transport_scout_state",
    `scout_id=eq.${scoutId}&select=object_id`,
  );
  return rows.map((row) => row.object_id);
}

async function listRunAlertedIds(
  ctx: BenchCtx,
  runId: string,
): Promise<string[]> {
  const occurrences = await pgList<{ unit_id: string }>(
    ctx,
    "unit_occurrences",
    `scout_run_id=eq.${runId}&select=unit_id`,
  );
  if (occurrences.length === 0) return [];
  const ids = occurrences.map((occurrence) => occurrence.unit_id).join(",");
  const units = await pgList<{ entities: string[] | null }>(
    ctx,
    "information_units",
    `id=in.(${ids})&select=entities`,
  );
  return units.flatMap((unit) => unit.entities?.slice(0, 1) ?? []);
}

async function auditTwoRunBaseline(
  ctx: BenchCtx,
  mode: TransportMode,
  scoutId: string,
): Promise<string[]> {
  const failures: string[] = [];
  const run1 = await waitForScoutRun(
    ctx,
    await triggerScoutRun(ctx, scoutId),
    { timeoutMs: RUN_TIMEOUT_MS },
  );
  console.log(
    `${mode} run 1: status=${run1.status} units=${run1.articles_count}`,
  );
  if (run1.status !== "success") {
    failures.push(
      `${mode} run 1 status ${run1.status}: ${run1.error_message ?? ""}`,
    );
  }
  if ((run1.articles_count ?? 0) !== 0) {
    failures.push(
      `${mode} run 1 must be a silent baseline but created ${run1.articles_count} units`,
    );
  }

  const baselined = await listBaselinedObjectIds(ctx, scoutId);
  console.log(`${mode} run 1 observed ${baselined.length} object(s)`);
  if (baselined.length === 0) {
    failures.push(`${mode} run 1 recorded no positional state`);
  }
  const scout = await pgSelectOne<CreatedScout>(
    ctx,
    "scouts",
    { id: scoutId },
    "id,baseline_established_at",
  );
  if (!scout?.baseline_established_at) {
    failures.push(`${mode} baseline_established_at not stamped after run 1`);
  }

  const run2 = await waitForScoutRun(
    ctx,
    await triggerScoutRun(ctx, scoutId),
    { timeoutMs: RUN_TIMEOUT_MS },
  );
  console.log(
    `${mode} run 2: status=${run2.status} entrants=${run2.articles_count}`,
  );
  if (run2.status !== "success") {
    failures.push(
      `${mode} run 2 status ${run2.status}: ${run2.error_message ?? ""}`,
    );
  }
  const reAlerted = reAlertedObjectIds(
    baselined,
    await listRunAlertedIds(ctx, run2.id),
  );
  if (reAlerted.length > 0) {
    failures.push(
      `${mode} run 2 re-alerted ${reAlerted.length} baselined object(s) (` +
        `${reAlerted.slice(0, 5).join(", ")})`,
    );
  }
  return failures;
}

async function runCanary(
  ctx: BenchCtx,
  mode: TransportMode,
  initialConfig: () => TransportConfig | Promise<TransportConfig>,
  prepare?: (ctx: BenchCtx, scoutId: string) => Promise<unknown>,
): Promise<string[]> {
  let scoutId: string | null = null;
  try {
    const config = await initialConfig();
    scoutId = await createTransportScout(ctx, config);
    console.log(
      `created ${mode} transport scout ${scoutId} watching ${config.watch_ids.length} object(s)`,
    );
    if (prepare) await prepare(ctx, scoutId);
    return await auditTwoRunBaseline(ctx, mode, scoutId);
  } catch (error) {
    return [
      `${mode} canary: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  } finally {
    if (scoutId) {
      await purgeScoutUnits(ctx, scoutId).catch(() => {});
      await userFetch(ctx, `/scouts/${scoutId}`, { method: "DELETE" })
        .catch(() => {});
    }
  }
}

async function main() {
  const ctx = await getBenchCtx({ userToken: true });
  assertLiveBenchmarkAllowed(ctx.supabaseUrl);
  if (!ctx.userToken) throw new Error("failed to acquire benchmark user token");

  const failures: string[] = [];
  failures.push(
    ...await runCanary(ctx, "aircraft", async () => {
      const watchIds = await probeDoverHexes();
      console.log(`aircraft probe: ${watchIds.length} over ${DOVER_PRESET}`);
      if (watchIds.length === 0) {
        throw new Error("adsb.lol observed zero aircraft over Dover Strait");
      }
      return aircraftCanaryConfig(watchIds);
    }),
  );

  failures.push(
    ...await runCanary(
      ctx,
      "vessel",
      () => ({
        mode: "vessel",
        geofence: { preset_id: MALACCA_PRESET },
        watch_ids: [BOOTSTRAP_MMSI],
      }),
      prepareVesselCanary,
    ),
  );

  failures.push(
    ...await runCanary(
      ctx,
      "satellite",
      () => ({
        mode: "satellite",
        geofence: ISS_GEOFENCE,
        watch_ids: [ISS_NORAD_ID],
      }),
      prepareSatelliteCanary,
    ),
  );

  if (failures.length > 0) {
    console.error(`\nbenchmark-transport FAILED:\n- ${failures.join("\n- ")}`);
    Deno.exit(1);
  }
  console.log("\nbenchmark-transport PASSED (aircraft, vessel, satellite)");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.main) await main();
