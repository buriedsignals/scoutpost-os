/**
 * Page Scout (type "web") end-to-end benchmark + audit.
 *
 * Port of backend/scripts/benchmark_web.py.
 *
 * Modes:
 *   Quick (default): 3 URL classes (blocked, normal, normal)
 *   --audit        : 5 URLs exercising different provider outcomes, with
 *                    criteria-match validation + markdown report
 *
 *   set -a; source .env; set +a
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmark-web.ts
 *   deno run --allow-env --allow-net --allow-read=. --allow-write=scripts/reports \
 *     scripts/benchmark-web.ts --audit
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
import {
  Article,
  AuditRecord,
  detectFlaws,
  runQualityChecks,
  writeReport,
} from "./_bench_quality.ts";

interface TestCase {
  name: string;
  url: string;
  criteria: string;
  language: string;
  expectScraper: boolean;
  expectProvider: "firecrawl" | "firecrawl_plain" | null;
}

const QUICK: TestCase[] = [
  {
    name: "Blocked URL (nytimes.com)",
    url:
      "https://www.nytimes.com/2025/01/15/us/politics/trump-executive-orders.html",
    criteria: "any substantive content change",
    language: "en",
    expectScraper: false,
    expectProvider: null,
  },
  {
    name: "Normal URL (neunkirch.ch)",
    url: "https://www.neunkirch.ch/freizeit/veranstaltungen.html/23",
    criteria: "Veranstaltungen, Termine, Aktualit\u00e4ten",
    language: "de",
    expectScraper: true,
    expectProvider: null,
  },
  {
    name: "Normal URL (politico.com/news/congress)",
    url: "https://www.politico.com/news/congress",
    criteria: "Congress votes, committee actions, legislation",
    language: "en",
    expectScraper: true,
    expectProvider: "firecrawl",
  },
];

const AUDIT: TestCase[] = [
  ...QUICK,
  {
    name: "PDF page (firecrawl_plain)",
    url: "https://www.oaklandca.gov/documents/fy-2023-25-budget-book.pdf",
    criteria: "budget items, capital spending",
    language: "en",
    expectScraper: true,
    expectProvider: null,
  },
  {
    name: "High-JS SPA (bbc.com)",
    url: "https://www.bbc.com/news",
    criteria: "UK politics, economy, international",
    language: "en",
    expectScraper: true,
    expectProvider: null,
  },
];

async function runCase(
  ctx: BenchCtx,
  tc: TestCase,
  opts: { verbose?: boolean } = {},
): Promise<
  AuditRecord & {
    expected_scraper: boolean;
    actual_scraper: boolean | null;
    provider: string | null;
  }
> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const scoutName = `bench-web-${suffix}`;
  let scoutId: string | null = null;
  const startMs = performance.now();

  const record: AuditRecord & {
    expected_scraper: boolean;
    actual_scraper: boolean | null;
    provider: string | null;
  } = {
    permutation: tc.name,
    category: "news",
    source_mode: "reliable",
    scope: "topic",
    queries_generated: 1,
    raw_results: 0,
    final_articles: 0,
    articles: [],
    summary: "",
    processing_time_ms: 0,
    error: null,
    quality_checks: [],
    expected_scraper: tc.expectScraper,
    actual_scraper: null,
    provider: null,
  };

  try {
    const scout = await pgInsert<{ id: string }>(ctx, "scouts", {
      user_id: ctx.userId,
      name: scoutName,
      type: "web",
      url: tc.url,
      criteria: tc.criteria,
      preferred_language: tc.language,
      regularity: "daily",
      schedule_cron: "0 8 * * *",
      is_active: false,
    });
    scoutId = scout.id;
    if (opts.verbose) ok("scout created", scoutId);

    const res = await svcFetch(ctx, "/functions/v1/scout-web-execute", {
      scout_id: scoutId,
    });
    record.processing_time_ms = Math.round(performance.now() - startMs);

    // scout-web-execute is all-or-nothing: 4xx/5xx on scrape failure, 200 w/ body on success
    const run = await pgSelectOne<{
      scraper_status: boolean;
      articles_count: number;
      error_message: string | null;
    }>(ctx, "scout_runs", { scout_id: scoutId });
    record.actual_scraper = run?.scraper_status ?? null;
    record.final_articles = run?.articles_count ?? 0;
    record.raw_results = record.final_articles;

    // Re-read scout to see whether double-probe stamped a provider
    const scoutRow = await pgSelectOne<{ provider: string | null }>(
      ctx,
      "scouts",
      {
        id: scoutId,
      },
      "provider",
    );
    record.provider = scoutRow?.provider ?? null;

    if (res.status >= 400) {
      record.error = run?.error_message ??
        `HTTP ${res.status}: ${res.text.slice(0, 200)}`;
      return record;
    }

    // Pull inserted units for quality check
    const units = await fetchUnits(ctx, scoutId);
    record.articles = units.map<Article>((u) => ({
      title: u.source_title ?? u.source_url ?? "Untitled",
      url: u.source_url ?? "",
      source: u.source_domain ?? "",
      date: u.occurred_at,
      summary: u.statement ?? null,
    }));
    record.summary = units
      .slice(0, 5)
      .map((u) => `- ${u.statement ?? ""}`)
      .filter((s) => s.length > 2)
      .join("\n");

    if (record.actual_scraper) {
      record.quality_checks = runQualityChecks(
        {
          summary: record.summary,
          articles: record.articles,
          category: "news",
        },
        tc.language,
        "reliable",
      );
    }
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (scoutId) {
      await pgDelete(ctx, "scouts", { id: scoutId }).catch(() => {});
    }
  }
  return record;
}

async function fetchUnits(
  ctx: BenchCtx,
  scoutId: string,
): Promise<
  Array<{
    source_url: string | null;
    source_title: string | null;
    source_domain: string | null;
    statement: string | null;
    occurred_at: string | null;
  }>
> {
  const qs = new URLSearchParams();
  qs.set(
    "select",
    "source_url,source_title,source_domain,statement,occurred_at",
  );
  qs.set("scout_id", `eq.${scoutId}`);
  qs.set("order", "extracted_at.desc");
  qs.set("limit", "20");
  const res = await fetch(
    `${ctx.supabaseUrl}/rest/v1/information_units?${qs}`,
    {
      headers: {
        apikey: ctx.apiKey,
        Authorization: `Bearer ${ctx.serviceKey}`,
      },
    },
  );
  if (!res.ok) return [];
  return await res.json();
}

function printRecord(
  r: AuditRecord & {
    expected_scraper: boolean;
    actual_scraper: boolean | null;
    provider: string | null;
  },
): void {
  const scraperOk = r.expected_scraper === r.actual_scraper;
  const status = r.error && !r.expected_scraper && !r.actual_scraper
    ? "OK (expected fail)"
    : r.error
    ? "ERROR"
    : scraperOk
    ? "OK"
    : "MISMATCH";
  console.log(
    `  [${status}] ${r.permutation} | scraper=${r.actual_scraper} (want ${r.expected_scraper}) | ` +
      `provider=${r.provider ?? "—"} | units=${r.final_articles} | ${
        dur(r.processing_time_ms)
      }`,
  );
  if (r.error && r.expected_scraper) fail("error", r.error);
  for (const c of r.quality_checks) {
    const tag = c.status === "PASS"
      ? "  \u2713"
      : c.status === "FAIL"
      ? "  \u2717"
      : "  !";
    console.log(`    ${tag} ${c.check}: ${c.detail}`);
  }
}

async function runAudit(ctx: BenchCtx): Promise<void> {
  console.log(`Page audit: ${AUDIT.length} URLs against ${ctx.ownerEmail}\n`);
  const records: Array<
    AuditRecord & {
      expected_scraper: boolean;
      actual_scraper: boolean | null;
      provider: string | null;
    }
  > = [];
  for (const tc of AUDIT) {
    hr(tc.name);
    const r = await runCase(ctx, tc);
    records.push(r);
    printRecord(r);
  }

  hr("Flaw detection");
  const flaws = detectFlaws(records);
  if (flaws.length === 0) console.log("  No flaws detected \u2713");
  else for (const f of flaws) console.log(`  \u2717 ${f}`);

  const md = writeReport(records, flaws, AUDIT.length);
  const outDir = `${Deno.cwd()}/scripts/reports`;
  try {
    await Deno.mkdir(outDir, { recursive: true });
  } catch { /* exists */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = `${outDir}/web-audit-${stamp}.md`;
  await Deno.writeTextFile(path, md);
  console.log(`\nReport written: ${path}`);
}

// ---------------------------------------------------------------------------

const args = new Set(Deno.args);
const ctx = await getCtx();
console.log(
  `Running Page Scout benchmark as ${ctx.ownerEmail} (user_id=${ctx.userId})`,
);

if (args.has("--audit")) {
  await runAudit(ctx);
} else {
  for (const tc of QUICK) {
    hr(tc.name);
    const r = await runCase(ctx, tc, { verbose: true });
    printRecord(r);
  }
}
