#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * Refresh transport_watchlists from sdr-enthusiasts/plane-alert-db.
 *
 * LICENSE (verified 2026-07-03): plane-alert-db is offered under the Open
 * Database License (ODbL 1.0); its individual contents under the Database
 * Contents License (DbCL 1.0). Commercial redistribution is permitted WITH
 * attribution and share-alike — so the derived `transport_watchlists` rows
 * must themselves be offered under ODbL, and the product attributes the
 * source (see docs/features/transport.md). This script REFUSES to import if
 * the upstream LICENSE section can no longer be verified, so a silent
 * upstream relicense can't leak into our DB.
 *
 * Only the aircraft (ICAO-hex) lists are imported. The shadowbroker vessel
 * lists (yacht / PLAN-CCG) are deliberately NOT imported — unlicensed and
 * partly synthetic (PRD R4).
 *
 * Usage (service-role, against a linked Supabase project):
 *   scripts/benchmarks/with-linked-supabase-env.sh \
 *     deno run --allow-net --allow-env scripts/ops/refresh-transport-watchlists.ts
 */

import {
  licenseTextIsOdbl,
  parsePlaneAlertCsv,
} from "../../supabase/functions/_shared/plane_alert.ts";

const REPO_RAW =
  "https://raw.githubusercontent.com/sdr-enthusiasts/plane-alert-db/main";
const DB_CSV = `${REPO_RAW}/plane-alert-db.csv`;
const README = `${REPO_RAW}/README.md`;

async function main() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  // License guard — refuse to import if upstream is no longer ODbL/DbCL.
  const readmeRes = await fetch(README);
  if (!readmeRes.ok) throw new Error(`README fetch failed: ${readmeRes.status}`);
  if (!licenseTextIsOdbl(await readmeRes.text())) {
    throw new Error(
      "REFUSING import: plane-alert-db README no longer states the ODbL/DbCL " +
        "license. Re-verify licensing before importing (see script header).",
    );
  }
  console.log("license verified: ODbL/DbCL");

  const csvRes = await fetch(DB_CSV);
  if (!csvRes.ok) throw new Error(`CSV fetch failed: ${csvRes.status}`);
  const rows = parsePlaneAlertCsv(await csvRes.text());
  console.log(`parsed ${rows.length} aircraft watchlist rows`);
  if (rows.length < 1000) {
    throw new Error(
      `sanity check failed: only ${rows.length} rows (expected ~15k); aborting`,
    );
  }

  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2"
  );
  const svc = createClient(url, key, {
    auth: { persistSession: false },
  });

  // Atomic-ish refresh: upsert ALL rows first (stamping this run's
  // imported_at), THEN delete stale rows from prior imports. There is never
  // an empty window — concurrent scout runs always see a fully-populated
  // table (old rows until the swap, new rows after).
  const importedAt = new Date().toISOString();
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await svc
      .from("transport_watchlists")
      .upsert(
        rows.slice(i, i + BATCH).map((r) => ({ ...r, imported_at: importedAt })),
        { onConflict: "ident_type,ident" },
      );
    if (error) throw new Error(error.message);
  }
  const { error: delErr } = await svc
    .from("transport_watchlists")
    .delete()
    .eq("ident_type", "icao_hex")
    .lt("imported_at", importedAt);
  if (delErr) throw new Error(delErr.message);
  console.log(`imported ${rows.length} rows into transport_watchlists`);
}

if (import.meta.main) {
  await main();
}
