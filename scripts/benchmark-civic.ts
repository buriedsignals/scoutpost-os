/**
 * Civic Scout (type "civic") end-to-end benchmark + audit.
 *
 * Port of backend/scripts/benchmark_civic.py. civic-execute enqueues PDFs +
 * docs; civic-extract-worker drains them. Audit mode exercises 10 civic URLs,
 * validates extracted promise count, language, date relevance, writes an
 * audit report to scripts/reports/civic-audit-*.md.
 *
 * Uses a temporary benchmark user created in-script so the benchmark does not
 * depend on a pre-seeded auth user existing in the target Supabase project.
 *
 *   set -a; source .env; set +a
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmark-civic.ts
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmark-civic.ts --url https://council.example/minutes
 *   deno run --allow-env --allow-net --allow-read=. --allow-write=scripts/reports scripts/benchmark-civic.ts --audit
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  assertSafeBenchmarkSupabaseUrl,
  BenchCtx,
  dur,
  fail,
  hr,
  ok,
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
  url: string;
  language: string;
  criteria: string | null;
}

// Zurich Gemeinderat index page lists council protocols in German with rich
// "protokoll" / "geschäfte" link text — exercises the multilingual
// MEETING_KEYWORDS match path and reliably produces extractable promises.
// The Oakland URL it replaced often queued PDFs that contain agendas but no
// explicit commitments, yielding queued>0 / promises=0 (pipeline fine, data
// thin — not a useful smoke-test signal).
const DEFAULT_URL = "https://www.gemeinderat-zuerich.ch/protokolle";

const AUDIT: Scenario[] = [
  {
    name: "Basel: Grosser Rat (DE)",
    url: "https://grosserrat.bs.ch/ratsbetrieb/ratsprotokolle?all=1",
    language: "de",
    criteria: null,
  },
  {
    name: "Basel: Grosser Rat + Wohnungspolitik (DE)",
    url: "https://grosserrat.bs.ch/ratsbetrieb/ratsprotokolle?all=1",
    language: "de",
    criteria: "Wohnungspolitik",
  },
  {
    name: "Zurich: Gemeinderat (DE)",
    url: "https://www.gemeinderat-zuerich.ch/protokolle",
    language: "de",
    criteria: null,
  },
  {
    name: "Lausanne: Conseil communal (FR)",
    url:
      "https://www.lausanne.ch/officiel/autorites/conseil-communal/seances-et-pv.html",
    language: "fr",
    criteria: null,
  },
  {
    name: "Bern: Stadtrat + Klimaschutz (DE)",
    url: "https://www.bern.ch/politik-und-verwaltung/stadtrat/sitzungen",
    language: "de",
    criteria: "Klimaschutz",
  },
  {
    name: "Bozeman: City Commission (EN)",
    url: "https://www.bozeman.net/departments/city-commission",
    language: "en",
    criteria: null,
  },
  {
    name: "Bozeman: City Commission + housing (EN)",
    url: "https://www.bozeman.net/departments/city-commission",
    language: "en",
    criteria: "housing policy",
  },
  {
    name: "Madison WI: Common Council (EN)",
    url: "https://www.cityofmadison.com/council",
    language: "en",
    criteria: null,
  },
  {
    name: "Zermatt: Gemeinde (DE)",
    url: "https://gemeinde.zermatt.ch",
    language: "de",
    criteria: null,
  },
  {
    name: "Zermatt: Gemeinde + Infrastruktur (DE)",
    url: "https://gemeinde.zermatt.ch",
    language: "de",
    criteria: "Infrastruktur",
  },
];

interface Args {
  urls: string[];
  audit: boolean;
  maxDrain: number;
}

interface BenchmarkUser {
  id: string;
  email: string;
  token: string;
  cleanup: () => Promise<void>;
}

interface Candidate {
  url: string;
  description?: string;
  confidence?: number;
}

interface CivicPreviewSample {
  promise_text?: string;
  context?: string;
  source_url?: string;
  source_date?: string;
}

interface CivicAuditRecordExt extends AuditRecord {
  discovery_count?: number;
  preview_documents?: number;
  selected_url?: string;
}

function mustEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    console.error(`missing env ${name}. Source .env first:`);
    console.error("  set -a; source .env; set +a");
    Deno.exit(2);
  }
  return value;
}

const SUPABASE_URL = mustEnv("SUPABASE_URL").replace(/\/$/, "");
assertSafeBenchmarkSupabaseUrl(SUPABASE_URL);
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_AUTH_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("PUBLISHABLE_KEY") ??
  Deno.env.get("ANON_KEY") ??
  Deno.env.get("SUPABASE_API_KEY") ??
  SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_API_KEY = Deno.env.get("SUPABASE_API_KEY") ??
  Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("PUBLISHABLE_KEY") ??
  Deno.env.get("ANON_KEY") ??
  SUPABASE_SERVICE_ROLE_KEY;

const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function parseArgs(): Args {
  const urls: string[] = [];
  let audit = false;
  let maxDrain = 10;
  for (let i = 0; i < Deno.args.length; i++) {
    const a = Deno.args[i];
    if (a === "--url") urls.push(Deno.args[++i]);
    else if (a === "--audit") audit = true;
    else if (a === "--max-drain") {
      maxDrain = parseInt(Deno.args[++i], 10) || maxDrain;
    }
  }
  return { urls: urls.length > 0 ? urls : [DEFAULT_URL], audit, maxDrain };
}

async function createBenchmarkUser(): Promise<BenchmarkUser> {
  const email = `civic-benchmark-${crypto.randomUUID()}@example.com`;
  const password = `CivicBench-${crypto.randomUUID()}`;

  const { data: created, error: createErr } = await service.auth.admin
    .createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createErr || !created.user) {
    throw new Error(`failed to create benchmark user: ${createErr?.message}`);
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_AUTH_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signInErr } = await authClient.auth
    .signInWithPassword({
      email,
      password,
    });
  if (signInErr || !signedIn.session) {
    throw new Error(`failed to sign in benchmark user: ${signInErr?.message}`);
  }

  const { error: creditsErr } = await service.from("credit_accounts").upsert({
    user_id: created.user.id,
    tier: "free",
    monthly_cap: 100,
    balance: 100,
    entitlement_source: "civic-benchmark",
  }, { onConflict: "user_id" });
  if (creditsErr) {
    throw new Error(`failed to seed benchmark credits: ${creditsErr.message}`);
  }

  return {
    id: created.user.id,
    email,
    token: signedIn.session.access_token,
    cleanup: async () => {
      await service.auth.admin.deleteUser(created.user.id).catch(() =>
        undefined
      );
    },
  };
}

function benchmarkCtx(user: BenchmarkUser): BenchCtx {
  return {
    supabaseUrl: SUPABASE_URL,
    serviceKey: SUPABASE_SERVICE_ROLE_KEY,
    apiKey: SUPABASE_API_KEY,
    ownerEmail: user.email,
    userId: user.id,
  };
}

async function authedFetch(
  token: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/functions/v1${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_AUTH_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function jsonOrThrow<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(
      `${label} ${res.status}: ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`,
    );
  }
  return parsed as T;
}

async function discoverCandidate(
  token: string,
  inputUrl: string,
): Promise<{ candidates: Candidate[]; selectedUrl: string }> {
  const res = await authedFetch(token, "/civic/discover", {
    root_domain: inputUrl,
  });
  const body = await jsonOrThrow<{ candidates?: Candidate[] }>(
    res,
    `discover ${inputUrl}`,
  );
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  return {
    candidates,
    selectedUrl: candidates[0]?.url ?? inputUrl,
  };
}

async function runPreview(
  token: string,
  trackedUrl: string,
  criteria: string | null,
): Promise<{ documentsFound: number; samplePromises: CivicPreviewSample[] }> {
  const res = await authedFetch(token, "/civic/test", {
    tracked_urls: [trackedUrl],
    criteria: criteria ?? undefined,
  });
  const body = await jsonOrThrow<{
    documents_found?: number;
    sample_promises?: CivicPreviewSample[];
  }>(res, `preview ${trackedUrl}`);
  return {
    documentsFound: body.documents_found ?? 0,
    samplePromises: Array.isArray(body.sample_promises)
      ? body.sample_promises
      : [],
  };
}

async function runCivic(
  ctx: BenchCtx,
  benchmarkUser: BenchmarkUser,
  sc: Scenario,
  maxDrain: number,
  opts: { verbose?: boolean } = {},
): Promise<CivicAuditRecordExt> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const scoutName = `bench-civic-${suffix}`;
  let scoutId: string | null = null;
  const startMs = performance.now();

  const record: CivicAuditRecordExt = {
    permutation: sc.name,
    category: "civic",
    source_mode: "reliable",
    scope: "location",
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
    const discovery = await discoverCandidate(benchmarkUser.token, sc.url);
    record.discovery_count = discovery.candidates.length;
    record.selected_url = discovery.selectedUrl;
    if (opts.verbose) ok("selected candidate", discovery.selectedUrl);

    const preview = await runPreview(
      benchmarkUser.token,
      discovery.selectedUrl,
      sc.criteria,
    );
    record.preview_documents = preview.documentsFound;

    let domain = "";
    try {
      domain = new URL(sc.url).hostname;
    } catch {
      /* leave blank */
    }
    const createRes = await authedFetch(benchmarkUser.token, "/scouts", {
      name: scoutName,
      type: "civic",
      topic: "civic",
      root_domain: domain,
      tracked_urls: [discovery.selectedUrl],
      criteria: sc.criteria ?? undefined,
      preferred_language: sc.language,
      regularity: "weekly",
      schedule_cron: "0 8 * * MON",
    });
    const scout = await jsonOrThrow<{ id?: string }>(
      createRes,
      "create civic scout",
    );
    if (!scout.id) throw new Error("created civic scout response missing id");
    scoutId = scout.id;
    await service.from("scouts").update({ is_active: false }).eq("id", scoutId);
    if (opts.verbose && scoutId) ok("scout created", scoutId);

    // Phase 1: enqueue
    const enqueueRes = await svcFetch(ctx, "/functions/v1/civic-execute", {
      scout_id: scoutId,
    });
    if (enqueueRes.status >= 400) {
      record.error = `civic-execute HTTP ${enqueueRes.status}: ${
        enqueueRes.text.slice(0, 200)
      }`;
      return record;
    }
    const enqueuePayload = enqueueRes.json as { queued?: number };
    record.queries_generated = enqueuePayload?.queued ?? 0;
    record.raw_results = enqueuePayload?.queued ?? 0;

    if (!record.raw_results) {
      // no new documents — skip the drain loop
      record.processing_time_ms = Math.round(performance.now() - startMs);
      return record;
    }

    // Phase 2: drain the queue
    for (let i = 0; i < maxDrain; i++) {
      const drainRes = await svcFetch(
        ctx,
        "/functions/v1/civic-extract-worker",
        {},
      );
      if (drainRes.status >= 400) {
        record.error = `civic-extract-worker HTTP ${drainRes.status}`;
        break;
      }
      const p = drainRes.json as {
        status?: string;
        promises_extracted?: number;
      };
      if (p.status === "idle") break;
      record.final_articles += p.promises_extracted ?? 0;
    }
    record.processing_time_ms = Math.round(performance.now() - startMs);

    // Pull inserted promises to feed quality pipeline
    if (!scoutId) throw new Error("benchmark scout id missing after create");
    const promises = await fetchPromises(scoutId);
    record.articles = promises.map<Article>((p) => ({
      title: p.promise_text ?? "Untitled",
      url: p.source_url ?? "",
      source: p.source_title ?? undefined,
      date: p.meeting_date,
      summary: p.context ?? null,
    }));
    record.summary = promises
      .slice(0, 5)
      .map((p) => `- **${p.promise_text}** ([source](${p.source_url}))`)
      .join("\n");

    record.quality_checks = runQualityChecks(
      {
        summary: record.summary,
        articles: record.articles,
        category: "government",
      },
      sc.language,
      "reliable",
    );
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (scoutId) {
      await cleanupScoutData(scoutId);
    }
  }
  return record;
}

async function fetchPromises(
  scoutId: string,
): Promise<
  Array<{
    promise_text: string | null;
    context: string | null;
    source_url: string | null;
    source_title: string | null;
    meeting_date: string | null;
  }>
> {
  const { data, error } = await service
    .from("promises")
    .select("promise_text,context,source_url,source_title,meeting_date")
    .eq("scout_id", scoutId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data;
}

async function cleanupScoutData(scoutId: string): Promise<void> {
  try {
    await service.from("promises").delete().eq("scout_id", scoutId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    await service.from("civic_extraction_queue").delete().eq(
      "scout_id",
      scoutId,
    );
  } catch {
    /* best-effort cleanup */
  }
  try {
    await service.from("scout_runs").delete().eq("scout_id", scoutId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    await service.from("scouts").delete().eq("id", scoutId);
  } catch {
    /* best-effort cleanup */
  }
}

function printRecord(r: CivicAuditRecordExt): void {
  // Pass/fail cascade:
  //   ERROR — HTTP failure somewhere in the pipeline
  //   FAIL — discovery returned 0 candidates
  //   FAIL — preview resolved 0 documents from the selected listing page
  //   FAIL — queued 0 documents (pipeline found no civic PDFs to parse)
  //   WARN — queued something but extraction yielded 0 promises (LLM saw no
  //          commitments, or ≤1 promise — pipeline healthy, data thin)
  //   OK   — ≥ 2 promises extracted
  const discovered = r.discovery_count ?? 0;
  const previewDocs = r.preview_documents ?? 0;
  const queued = r.queries_generated ?? 0;
  const promises = r.final_articles;
  const status = r.error
    ? "ERROR"
    : discovered === 0
    ? "FAIL (discover)"
    : previewDocs === 0
    ? "FAIL (preview)"
    : queued === 0
    ? "FAIL"
    : promises === 0
    ? "WARN (no extractable promises)"
    : promises <= 1
    ? `WARN (${promises})`
    : "OK";
  console.log(
    `  [${status}] ${r.permutation} | discover=${discovered} | preview=${previewDocs} | queued=${r.queries_generated} | ` +
      `promises=${r.final_articles} | ${dur(r.processing_time_ms)}`,
  );
  if (r.selected_url) console.log(`    selected: ${r.selected_url}`);
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

async function runAudit(ctx: BenchCtx, maxDrain: number): Promise<void> {
  console.log(
    `Civic audit: ${AUDIT.length} permutations against ${ctx.ownerEmail}\n`,
  );
  const records: CivicAuditRecordExt[] = [];
  for (const sc of AUDIT) {
    hr(sc.name);
    const r = await runCivic(ctx, benchmarkUser, sc, maxDrain);
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
  const path = `${outDir}/civic-audit-${stamp}.md`;
  await Deno.writeTextFile(path, md);
  console.log(`\nReport written: ${path}`);
}

// ---------------------------------------------------------------------------

const { urls, audit, maxDrain } = parseArgs();
const benchmarkUser = await createBenchmarkUser();

try {
  const ctx = benchmarkCtx(benchmarkUser);
  console.log(
    `Running Civic Scout benchmark as ${ctx.ownerEmail} (user_id=${ctx.userId})`,
  );

  if (audit) {
    await runAudit(ctx, maxDrain);
  } else {
    for (const url of urls) {
      hr(`Civic Scout: ${url}`);
      const r = await runCivic(
        ctx,
        benchmarkUser,
        { name: url, url, language: "en", criteria: null },
        maxDrain,
        { verbose: true },
      );
      printRecord(r);
    }
  }
} finally {
  await benchmarkUser.cleanup();
}
