/**
 * Social Scout (type "social") end-to-end benchmark + audit.
 *
 * Port of backend/scripts/benchmark_social.py.
 *
 * Modes:
 *   Quick (default): 1 handle, wait for Apify
 *   --no-wait      : fire-and-forget, row stays in apify_run_queue for later inspection
 *   --audit        : 4 handles across Instagram + X, wait each, write markdown report
 *
 *   set -a; source .env; set +a
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmark-social.ts
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmark-social.ts \
 *     --platform instagram --handle natgeo
 *   deno run --allow-env --allow-net --allow-read=. --allow-write=scripts/reports \
 *     scripts/benchmark-social.ts --audit
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

interface Scenario {
  name: string;
  platform: "instagram" | "x" | "facebook";
  handle: string;
  mode: "summarize" | "criteria";
  criteria: string | null;
  language: string;
}

const DEFAULT: Scenario = {
  name: "x @SadiqKhan (summarize)",
  platform: "x",
  handle: "SadiqKhan",
  mode: "summarize",
  criteria: null,
  language: "en",
};

const AUDIT: Scenario[] = [
  {
    name: "IG @natgeo (summarize)",
    platform: "instagram",
    handle: "natgeo",
    mode: "summarize",
    criteria: null,
    language: "en",
  },
  {
    name: "IG @natgeo (criteria: wildlife)",
    platform: "instagram",
    handle: "natgeo",
    mode: "criteria",
    criteria: "wildlife, climate, conservation",
    language: "en",
  },
  {
    name: "X @SadiqKhan (summarize)",
    platform: "x",
    handle: "SadiqKhan",
    mode: "summarize",
    criteria: null,
    language: "en",
  },
  {
    name: "IG @spiegelonline (DE)",
    platform: "instagram",
    handle: "spiegelonline",
    mode: "summarize",
    criteria: null,
    language: "de",
  },
];

interface Args {
  scenario: Scenario;
  audit: boolean;
  noWait: boolean;
  timeoutMs: number;
}

function parseArgs(): Args {
  let s: Scenario = { ...DEFAULT };
  let audit = false;
  let noWait = false;
  let timeoutMs = 10 * 60 * 1000;
  for (let i = 0; i < Deno.args.length; i++) {
    const a = Deno.args[i];
    if (a === "--platform") s.platform = Deno.args[++i] as Scenario["platform"];
    else if (a === "--handle") s.handle = Deno.args[++i];
    else if (a === "--mode") s.mode = Deno.args[++i] as Scenario["mode"];
    else if (a === "--criteria") s.criteria = Deno.args[++i];
    else if (a === "--audit") audit = true;
    else if (a === "--no-wait") noWait = true;
    else if (a === "--timeout-min") {
      timeoutMs = parseInt(Deno.args[++i], 10) * 60_000;
    }
  }
  s.name = `${s.platform} @${s.handle} (${s.mode})`;
  return { scenario: s, audit, noWait, timeoutMs };
}

async function runSocial(
  ctx: BenchCtx,
  sc: Scenario,
  opts: { noWait?: boolean; timeoutMs: number; verbose?: boolean },
): Promise<AuditRecord> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const scoutName = `bench-social-${suffix}`;
  let scoutId: string | null = null;
  let queueId: string | null = null;
  const startMs = performance.now();

  const record: AuditRecord = {
    permutation: sc.name,
    category: "social",
    source_mode: "reliable",
    scope: "topic",
    queries_generated: 0,
    raw_results: 0,
    final_articles: 0,
    articles: [],
    summary: "",
    processing_time_ms: 0,
    error: null,
    quality_checks: [],
  };

  try {
    const scout = await pgInsert<{ id: string }>(ctx, "scouts", {
      user_id: ctx.userId,
      name: scoutName,
      type: "social",
      platform: sc.platform,
      profile_handle: sc.handle,
      monitor_mode: sc.mode,
      criteria: sc.mode === "criteria"
        ? (sc.criteria ?? "any substantive new content")
        : null,
      track_removals: false,
      preferred_language: sc.language,
      regularity: "daily",
      schedule_cron: "0 8 * * *",
      is_active: false,
    });
    scoutId = scout.id;
    if (opts.verbose) ok("scout created", scoutId);

    const res = await svcFetch(ctx, "/functions/v1/social-kickoff", {
      scout_id: scoutId,
    });
    if (res.status >= 400) {
      record.error = `social-kickoff HTTP ${res.status}: ${
        res.text.slice(0, 300)
      }`;
      record.processing_time_ms = Math.round(performance.now() - startMs);
      return record;
    }
    const payload = res.json as { queue_id?: string; apify_run_id?: string };
    queueId = payload?.queue_id ?? null;

    if (opts.noWait) {
      record.processing_time_ms = Math.round(performance.now() - startMs);
      if (opts.verbose) {
        ok(
          "social-kickoff",
          `queue_id=${queueId} apify_run_id=${payload?.apify_run_id}`,
        );
      }
      return record;
    }

    // Poll the queue row until terminal or deadline
    if (!queueId) {
      record.error = "social-kickoff returned no queue_id";
      return record;
    }
    const deadline = Date.now() + opts.timeoutMs;
    let last = "pending";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      const row = await pgSelectOne<
        { status: string; last_error: string | null }
      >(
        ctx,
        "apify_run_queue",
        { id: queueId },
      );
      if (!row) break;
      if (row.status !== last) last = row.status;
      if (["succeeded", "failed", "timeout"].includes(row.status)) {
        if (row.status !== "succeeded") {
          record.error = `apify ${row.status}: ${row.last_error ?? ""}`;
        }
        break;
      }
    }
    record.processing_time_ms = Math.round(performance.now() - startMs);

    // Pull scout_runs + units for quality
    const run = await pgSelectOne<{
      articles_count: number;
      notification_sent: boolean;
    }>(ctx, "scout_runs", { scout_id: scoutId });
    record.final_articles = run?.articles_count ?? 0;
    record.raw_results = run?.articles_count ?? 0;

    const units = await fetchUnits(ctx, scoutId);
    record.articles = units.map<Article>((u) => ({
      title: u.statement ?? "",
      url: u.source_url ?? "",
      source: u.source_domain ?? sc.platform,
      date: u.extracted_at,
      summary: u.context_excerpt,
    }));
    record.summary = units
      .slice(0, 5)
      .map((u) => `- ${u.statement ?? ""}`)
      .filter((s) => s.length > 2)
      .join("\n");

    if (record.final_articles > 0) {
      record.quality_checks = runQualityChecks(
        {
          summary: record.summary,
          articles: record.articles,
          category: "news",
        },
        sc.language,
        "reliable",
      );
    }
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (scoutId && !opts.noWait) {
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
    source_domain: string | null;
    statement: string | null;
    context_excerpt: string | null;
    extracted_at: string | null;
  }>
> {
  const qs = new URLSearchParams();
  qs.set(
    "select",
    "source_url,source_domain,statement,context_excerpt,extracted_at",
  );
  qs.set("scout_id", `eq.${scoutId}`);
  qs.set("order", "extracted_at.desc");
  qs.set("limit", "30");
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

function printRecord(r: AuditRecord): void {
  // Pass/fail cascade:
  //   ERROR — social-kickoff HTTP fail, Apify network error, or queue row
  //           marked failed/timeout. Real pipeline breakage.
  //   WARN (actor returned empty) — queue SUCCEEDED but no real posts were
  //           extracted. Apify's X/IG actors periodically return only
  //           `{noResults: true}` placeholders for perfectly valid handles;
  //           our pipeline correctly filters them, leaving units=0.
  //   WARN (N) — 1 unit (low signal, but pipeline healthy)
  //   OK   — ≥ 2 units extracted
  const status = r.error
    ? "ERROR"
    : r.final_articles === 0
    ? "WARN (actor returned empty)"
    : r.final_articles <= 1
    ? `WARN (${r.final_articles})`
    : "OK";
  console.log(
    `  [${status}] ${r.permutation} | units=${r.final_articles} | ${
      dur(r.processing_time_ms)
    }`,
  );
  if (r.error) fail("error", r.error);
  for (const c of r.quality_checks) {
    const tag = c.status === "PASS"
      ? "  \u2713"
      : c.status === "FAIL"
      ? "  \u2717"
      : "  !";
    console.log(`    ${tag} ${c.check}: ${c.detail}`);
  }
}

async function runAudit(ctx: BenchCtx, timeoutMs: number): Promise<void> {
  console.log(
    `Social audit: ${AUDIT.length} handles against ${ctx.ownerEmail} ` +
      `(each up to ${timeoutMs / 60_000}min)\n`,
  );
  const records: AuditRecord[] = [];
  for (const sc of AUDIT) {
    hr(sc.name);
    const r = await runSocial(ctx, sc, { timeoutMs });
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
  const path = `${outDir}/social-audit-${stamp}.md`;
  await Deno.writeTextFile(path, md);
  console.log(`\nReport written: ${path}`);
}

// ---------------------------------------------------------------------------

const parsed = parseArgs();
const ctx = await getCtx();
console.log(
  `Running Social Scout benchmark as ${ctx.ownerEmail} (user_id=${ctx.userId})`,
);

if (parsed.audit) {
  await runAudit(ctx, parsed.timeoutMs);
} else {
  hr(parsed.scenario.name);
  const r = await runSocial(ctx, parsed.scenario, {
    noWait: parsed.noWait,
    timeoutMs: parsed.timeoutMs,
    verbose: true,
  });
  printRecord(r);
}
