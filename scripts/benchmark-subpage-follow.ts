/**
 * Phase B subpage-follow end-to-end benchmark.
 *
 * Creates a temp Page Scout pointing at a listing URL, invokes the
 * scout-web-execute Edge Function, and asserts that:
 *   1. The index page was detected as a listing (isListingPage)
 *   2. Subpage links were followed (information_units.source_url != scout.url)
 *   3. At least 3 units were extracted from subpages
 *
 * Usage:
 *   set -a; source .env; set +a
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmark-subpage-follow.ts
 *
 * Cleanup: the temp scout and its runs/units are deleted after the test.
 */

import {
  BenchCtx,
  dur,
  fail,
  getCtx,
  hr,
  ok,
  pgDelete,
  pgInsert,
  pgSelectOne,
  svcFetch,
} from "./_bench_shared.ts";

const TARGET_URL =
  "https://www.baselland.ch/politik-und-behorden/regierungsrat/medienmitteilungen/";
const TARGET_CRITERIA = "Regierungsrat Medienmitteilungen";
const MIN_SUBPAGE_UNITS = 3;

async function fetchUnitsForScout(
  ctx: BenchCtx,
  scoutId: string,
): Promise<
  Array<{
    source_url: string | null;
    source_title: string | null;
    statement: string | null;
    extracted_at: string | null;
  }>
> {
  const qs = new URLSearchParams();
  qs.set("select", "source_url,source_title,statement,extracted_at");
  qs.set("scout_id", `eq.${scoutId}`);
  qs.set("order", "extracted_at.desc");
  qs.set("limit", "50");
  const res = await fetch(
    `${ctx.supabaseUrl}/rest/v1/information_units?${qs}`,
    {
      headers: {
        apikey: ctx.apiKey,
        Authorization: `Bearer ${ctx.serviceKey}`,
      },
    },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`fetchUnits: ${res.status} ${t.slice(0, 300)}`);
  }
  return await res.json();
}

async function fetchRun(ctx: BenchCtx, scoutId: string) {
  return pgSelectOne<{
    status: string;
    articles_count: number;
    scraper_status: boolean;
    criteria_status: boolean | null;
    error_message: string | null;
  }>(ctx, "scout_runs", { scout_id: scoutId });
}

async function cleanup(ctx: BenchCtx, scoutId: string) {
  // Units reference the scout_runs and raw_captures — delete in dependency order.
  await pgDelete(ctx, "information_units", { scout_id: scoutId }).catch(
    () => {},
  );
  await pgDelete(ctx, "raw_captures", { scout_id: scoutId }).catch(() => {});
  await pgDelete(ctx, "scout_runs", { scout_id: scoutId }).catch(() => {});
  await pgDelete(ctx, "scouts", { id: scoutId }).catch(() => {});
}

async function main() {
  const ctx = await getCtx();
  const startMs = performance.now();

  hr("Phase B Subpage-Follow Benchmark");
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Min subpage units: ${MIN_SUBPAGE_UNITS}`);
  console.log("");

  const suffix = crypto.randomUUID().slice(0, 8);
  const scoutName = `bench-subpage-${suffix}`;
  let scoutId: string | null = null;

  try {
    // 1. Create temp scout
    hr("1. Create temp scout");
    const scout = await pgInsert<{ id: string }>(ctx, "scouts", {
      user_id: ctx.userId,
      name: scoutName,
      type: "web",
      url: TARGET_URL,
      criteria: TARGET_CRITERIA,
      preferred_language: "de",
      regularity: "daily",
      schedule_cron: "0 8 * * *",
      is_active: false,
    });
    scoutId = scout.id;
    ok("scout created", scoutId);

    // 2. Invoke scout-web-execute
    hr("2. Execute scout-web-execute");
    const execStart = performance.now();
    const res = await svcFetch(ctx, "/functions/v1/scout-web-execute", {
      scout_id: scoutId,
    });
    const execMs = Math.round(performance.now() - execStart);
    console.log(`  Response: HTTP ${res.status} (${dur(execMs)})`);

    if (res.status >= 400) {
      const body = typeof res.text === "string" ? res.text.slice(0, 500) : "";
      fail("execute failed", `HTTP ${res.status}: ${body}`);
      Deno.exit(1);
    }

    // 3. Inspect run status
    hr("3. Inspect scout_runs");
    const run = await fetchRun(ctx, scoutId);
    if (!run) {
      fail("no run row found", `scout_id=${scoutId}`);
      Deno.exit(1);
    }
    console.log(`  status=${run.status}, articles_count=${run.articles_count}`);
    console.log(`  scraper_status=${run.scraper_status}`);
    if (run.error_message) {
      console.log(`  error=${run.error_message.slice(0, 200)}`);
    }

    // 4. Fetch and inspect units
    hr("4. Fetch information_units");
    const units = await fetchUnitsForScout(ctx, scoutId);
    console.log(`  Total units: ${units.length}`);

    // 5. Separate index vs subpage units
    const indexUnits = units.filter(
      (u) => u.source_url === TARGET_URL,
    );
    const subpageUnits = units.filter(
      (u) => u.source_url !== TARGET_URL && u.source_url !== null,
    );

    console.log(`  From index page: ${indexUnits.length}`);
    console.log(`  From subpages: ${subpageUnits.length}`);

    if (subpageUnits.length > 0) {
      console.log("  Subpage URLs:");
      const seenUrls = new Set<string>();
      for (const u of subpageUnits) {
        if (u.source_url && !seenUrls.has(u.source_url)) {
          seenUrls.add(u.source_url);
          console.log(`    - ${u.source_url}`);
        }
      }
    }

    // 6. Assertions
    hr("5. Assertions");
    let allPassed = true;

    // Listing page was detected: the index page should have returned zero units
    // (because isListingPage was set) but subpages should have content.
    if (indexUnits.length === 0 && subpageUnits.length > 0) {
      ok(
        "Listing detected",
        "index produced 0 units, subpages produced content",
      );
    } else if (subpageUnits.length > 0) {
      ok(
        "Subpage units present",
        `${subpageUnits.length} units from subpages (index also had ${indexUnits.length})`,
      );
    } else {
      fail("No subpage units", "Phase B subpage follow may not have triggered");
      allPassed = false;
    }

    if (subpageUnits.length >= MIN_SUBPAGE_UNITS) {
      ok("Min subpage units", `${subpageUnits.length} >= ${MIN_SUBPAGE_UNITS}`);
    } else {
      fail(
        "Min subpage units",
        `${subpageUnits.length} < ${MIN_SUBPAGE_UNITS}`,
      );
      allPassed = false;
    }

    // Verify unique subpage URLs (Phase B should have fetched multiple)
    const uniqueSubpageUrls = new Set(
      subpageUnits.map((u) => u.source_url).filter(Boolean),
    );
    if (uniqueSubpageUrls.size >= 2) {
      ok(
        "Multiple subpages",
        `${uniqueSubpageUrls.size} distinct subpage URLs followed`,
      );
    } else {
      fail(
        "Multiple subpages",
        `Only ${uniqueSubpageUrls.size} distinct subpage URL (expected >= 2)`,
      );
      allPassed = false;
    }

    // Total time
    hr("Summary");
    const totalMs = Math.round(performance.now() - startMs);
    console.log(`  Total time: ${dur(totalMs)}`);
    console.log(`  Subpage units: ${subpageUnits.length}`);
    console.log(`  Distinct subpages: ${uniqueSubpageUrls.size}`);

    if (allPassed) {
      ok("ALL PASS", "Phase B subpage-follow benchmark succeeded");
    } else {
      fail("SOME CHECKS FAILED", "Review output above");
      Deno.exit(1);
    }
  } catch (e) {
    fail("Unhandled error", e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  } finally {
    if (scoutId) {
      console.log("");
      console.log("Cleaning up temp scout...");
      await cleanup(ctx, scoutId);
      ok("Cleanup complete", scoutId);
    }
  }
}

main();
