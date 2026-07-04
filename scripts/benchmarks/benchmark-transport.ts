/**
 * Transport Scout live health benchmark (aircraft mode).
 *
 * Manual/weekly operator run on the user-authenticated product path (see
 * docs/solutions/workflow-issues/benchmark-auth-model.md): the benchmark
 * owner session creates a real aircraft scout over the Dover Strait preset,
 * triggers Run Now twice, and audits the enter-only state machine:
 *
 *   run 1 — silent baseline: status success, articles_count 0, positional
 *           state rows recorded, baseline_established_at stamped.
 *   run 2 — steady state: status success, and NO run-2 feed event may name
 *           an aircraft that was already baselined in run 1 (exact identity
 *           check — any re-alert of baselined traffic fails the benchmark).
 *
 * Dover Strait always carries commercial traffic, so a healthy deployment
 * should observe >0 aircraft on run 1. Zero observed aircraft fails the
 * benchmark (upstream adsb.lol outage or fetch pipeline regression).
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
  triggerScoutRun,
  userFetch,
  waitForScoutRun,
} from "./_bench_shared.ts";

// Far-future cron so pg_cron never fires mid-benchmark; passes the transport
// 3h floor (single fixed minute + hour).
const FUTURE_CRON = "0 0 1 1 *";
const RUN_TIMEOUT_MS = 4 * 60_000;
const PRESET_ID = "dover-strait";

interface CreatedScout {
  id: string;
  baseline_established_at?: string | null;
}

async function createTransportScout(ctx: BenchCtx): Promise<string> {
  const res = await userFetch(ctx, "/scouts", {
    method: "POST",
    body: {
      name: `bench-transport-${Date.now()}`,
      type: "transport",
      schedule_cron: FUTURE_CRON,
      config: {
        mode: "aircraft",
        geofence: { preset_id: PRESET_ID },
      },
    },
  });
  const created = await jsonOrThrow<CreatedScout>(
    res,
    "create transport scout",
  );
  if (!created.id) throw new Error("scout creation returned no id");
  return created.id;
}

/** Service-role REST list. No PostgREST aggregates — count() is disabled on
 * hosted projects; plain selects with a bounded limit are always available. */
async function pgList<T>(
  ctx: BenchCtx,
  table: string,
  query: string,
): Promise<T[]> {
  const res = await fetch(
    `${ctx.supabaseUrl}/rest/v1/${table}?${query}&limit=1000`,
    { headers: dataApiHeaders(ctx) },
  );
  if (!res.ok) {
    throw new Error(`list ${table} responded ${res.status}`);
  }
  return await res.json() as T[];
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
  return rows.map((r) => r.object_id);
}

/** Aircraft identities alerted by a specific run, via its feed events. The
 * worker stores the ICAO hex as entities[0] on each information_unit. */
async function listRunAlertedIds(
  ctx: BenchCtx,
  runId: string,
): Promise<string[]> {
  const occ = await pgList<{ unit_id: string }>(
    ctx,
    "unit_occurrences",
    `scout_run_id=eq.${runId}&select=unit_id`,
  );
  if (occ.length === 0) return [];
  const ids = occ.map((o) => o.unit_id).join(",");
  const units = await pgList<{ entities: string[] | null }>(
    ctx,
    "information_units",
    `id=in.(${ids})&select=entities`,
  );
  return units.flatMap((u) => u.entities?.slice(0, 1) ?? []);
}

async function main() {
  const ctx = await getBenchCtx({ userToken: true });
  assertLiveBenchmarkAllowed(ctx.supabaseUrl);
  if (!ctx.userToken) {
    throw new Error("failed to acquire benchmark user token");
  }
  let scoutId: string | null = null;
  const failures: string[] = [];

  try {
    scoutId = await createTransportScout(ctx);
    console.log(`created transport scout ${scoutId} (aircraft, ${PRESET_ID})`);

    // Run 1 — silent baseline.
    const run1 = await waitForScoutRun(
      ctx,
      await triggerScoutRun(ctx, scoutId),
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    console.log(`run 1: status=${run1.status} units=${run1.articles_count}`);
    if (run1.status !== "success") {
      failures.push(`run 1 status ${run1.status}: ${run1.error_message ?? ""}`);
    }
    if ((run1.articles_count ?? 0) !== 0) {
      failures.push(
        `run 1 must be a silent baseline but created ${run1.articles_count} units`,
      );
    }
    const baselined = await listBaselinedObjectIds(ctx, scoutId);
    console.log(
      `run 1 observed ${baselined.length} aircraft over ${PRESET_ID}`,
    );
    if (baselined.length === 0) {
      failures.push(
        "run 1 observed zero aircraft over Dover Strait — adsb.lol outage or fetch pipeline regression",
      );
    }
    const scoutRow = await pgSelectOne<CreatedScout>(
      ctx,
      "scouts",
      { id: scoutId },
      "id,baseline_established_at",
    );
    if (!scoutRow?.baseline_established_at) {
      failures.push("baseline_established_at not stamped after run 1");
    }

    // Run 2 — steady state: exact identity check, no baselined aircraft may
    // re-alert. Genuinely new arrivals (hexes outside the baseline set) are
    // legitimate and pass.
    const baselinedSet = new Set(baselined);
    const run2 = await waitForScoutRun(
      ctx,
      await triggerScoutRun(ctx, scoutId),
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    console.log(
      `run 2: status=${run2.status} entrants=${run2.articles_count}`,
    );
    if (run2.status !== "success") {
      failures.push(`run 2 status ${run2.status}: ${run2.error_message ?? ""}`);
    }
    const run2Alerted = await listRunAlertedIds(ctx, run2.id);
    const reAlerted = run2Alerted.filter((hex) => baselinedSet.has(hex));
    if (reAlerted.length > 0) {
      failures.push(
        `run 2 re-alerted ${reAlerted.length} baselined aircraft (${
          reAlerted.slice(0, 5).join(", ")
        }) — enter-only state machine is re-alerting`,
      );
    }
  } finally {
    if (scoutId) {
      // State rows + runs cascade with the scout via FK.
      await userFetch(ctx, `/scouts/${scoutId}`, { method: "DELETE" })
        .catch(() => {});
    }
  }

  if (failures.length > 0) {
    console.error(`\nbenchmark-transport FAILED:\n- ${failures.join("\n- ")}`);
    Deno.exit(1);
  }
  console.log("\nbenchmark-transport PASSED");
}

if (import.meta.main) {
  await main();
}
