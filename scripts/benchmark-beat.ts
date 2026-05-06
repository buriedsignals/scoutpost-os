/**
 * Beat Scout live health benchmark + quality audit.
 *
 * Manual operator run. Uses a temporary benchmark user so we exercise:
 *   - preview search via /functions/v1/beat-search
 *   - scout creation via /functions/v1/scouts
 *   - scheduled execution via /functions/v1/scouts/:id/run
 *
 * The default run covers multiple query types:
 *   1. location-only
 *   2. topic-only
 *   3. topic + country
 *   4. topic + city
 *   5. another topic + country
 *
 * Unlike the old smoke benchmark, this script audits relevance:
 *   - requires scenario-specific topic/location signals
 *   - rejects obvious drift terms (for example Montreal/Quebec for UK queries)
 *
 * Compatibility replay:
 *   deno run --allow-env --allow-net scripts/benchmark-beat.ts \
 *     --scout-id <existing-beat-scout-uuid>
 *
 * Required env:
 *   COJO_LIVE_BENCHMARK=1
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertLiveBenchmarkAllowed } from "./_bench_shared.ts";

const SUPABASE_URL = mustEnv("SUPABASE_URL");
assertLiveBenchmarkAllowed(SUPABASE_URL, { firecrawl: true });
const SUPABASE_ANON_KEY = mustEnv("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const FUTURE_CRON = "0 0 1 1 *";
const DEFAULT_TIMEOUT_MS = 8 * 60_000;
const MAX_ATTEMPTS = 1;
const DEFAULT_CANARY_COUNT = 2;

const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface BenchLocation {
  displayName: string;
  city?: string;
  country: string;
  locationType?: string;
}

interface AuditExpectation {
  requiredGroups?: string[][];
  forbiddenTerms?: string[];
}

interface Scenario {
  name: string;
  criteria?: string;
  topic?: string | null;
  location?: BenchLocation | null;
  sourceMode: "reliable" | "niche";
  excludedDomains?: string[];
  prioritySources?: string[];
  preferredLanguage?: string;
  previewAudit?: AuditExpectation;
  executionAudit?: AuditExpectation;
}

interface PreviewArticle {
  title?: string;
  url?: string;
  source?: string;
  summary?: string;
}

interface PreviewCategoryResult {
  category: "news" | "government" | "analysis";
  articles: PreviewArticle[];
  summary: string;
  articleCount: number;
}

interface PreviewRunResult {
  totalCount: number;
  categories: PreviewCategoryResult[];
  combinedText: string;
}

interface ExecutionUnit {
  statement: string;
  source_title: string | null;
  source_url: string | null;
  country: string | null;
  city: string | null;
  topic: string | null;
}

interface ExecutionRunResult {
  status: string;
  articlesCount: number;
  units: ExecutionUnit[];
  combinedText: string;
  errorMessage: string | null;
}

interface Result {
  name: string;
  previewCount: number;
  executionCount: number;
  elapsedMs: number;
  ok: boolean;
  detail?: string;
}

interface BenchmarkUser {
  id: string;
  email: string;
  token: string;
  cleanup: () => Promise<void>;
}

const HOUSING_TERMS = [
  "housing policy",
  "housing policies",
  "affordable housing",
  "housing affordability",
  "social housing",
  "planning reform",
  "homelessness",
  "housing plan",
  "land use",
  "development plan",
  "tenant rights",
  "rent regulation",
  "zoning",
  "urbanisme",
  "logement",
  "logement social",
  "abordable",
  "règlement",
  "reglement",
];

const RENEWABLE_TERMS = [
  "renewable energy",
  "clean energy",
  "solar",
  "wind",
  "net zero",
  "decarbon",
  "hydrogen",
];

const AI_TERMS = [
  "ai",
  "artificial intelligence",
  "generative ai",
];

const JOURNALISM_TERMS = [
  "journalism",
  "artificial intelligence journalism",
  "newsroom",
  "newsrooms",
  "journalist",
  "journalists",
  "reporter",
  "reporters",
  "editor",
  "editors",
  "media",
  "publisher",
  "publishers",
];

const AI_JOURNALISM_DRIFT_TERMS = [
  "pentagon",
  "classified networks",
  "oscars",
  "orange county school board",
  "lawton council",
  "camping ordinance",
];

const UK_TERMS = [
  "united kingdom",
  "uk",
  "britain",
  "british",
  "england",
  "london",
  "wales",
  "scotland",
];

const LONDON_TERMS = [
  "london",
  "united kingdom",
  "uk",
  "england",
  "britain",
];

const DRIFT_TERMS = [
  "montreal",
  "quebec",
  "canada",
  "milwaukee",
  "wisconsin",
];

const CANARIES: Scenario[] = [
  {
    name: "location-only:london",
    location: {
      displayName: "London, United Kingdom",
      city: "London",
      country: "GB",
      locationType: "city",
    },
    sourceMode: "reliable",
    preferredLanguage: "en",
    previewAudit: {
      requiredGroups: [LONDON_TERMS],
      forbiddenTerms: DRIFT_TERMS,
    },
    executionAudit: {
      requiredGroups: [LONDON_TERMS],
      forbiddenTerms: DRIFT_TERMS,
    },
  },
  {
    name: "topic-only:housing-policy",
    topic: "housing policy",
    criteria: "housing policy",
    sourceMode: "reliable",
    preferredLanguage: "en",
    previewAudit: {
      requiredGroups: [HOUSING_TERMS],
    },
    executionAudit: {
      requiredGroups: [HOUSING_TERMS],
    },
  },
  {
    name: "topic-only:ai-journalism",
    topic: "AI journalism",
    criteria:
      "AI in journalism newsrooms reporters editors media organizations",
    sourceMode: "reliable",
    preferredLanguage: "en",
    previewAudit: {
      requiredGroups: [AI_TERMS, JOURNALISM_TERMS],
      forbiddenTerms: AI_JOURNALISM_DRIFT_TERMS,
    },
    executionAudit: {
      requiredGroups: [AI_TERMS, JOURNALISM_TERMS],
      forbiddenTerms: AI_JOURNALISM_DRIFT_TERMS,
    },
  },
  {
    name: "topic+country:uk-housing-policy",
    criteria: "housing policy",
    location: {
      displayName: "United Kingdom",
      country: "GB",
      locationType: "country",
    },
    sourceMode: "reliable",
    preferredLanguage: "en",
    previewAudit: {
      requiredGroups: [HOUSING_TERMS, UK_TERMS],
      forbiddenTerms: DRIFT_TERMS,
    },
    executionAudit: {
      requiredGroups: [HOUSING_TERMS, UK_TERMS],
      forbiddenTerms: DRIFT_TERMS,
    },
  },
  {
    name: "topic+city:london-housing-policy",
    criteria: "housing policy",
    location: {
      displayName: "London, United Kingdom",
      city: "London",
      country: "GB",
      locationType: "city",
    },
    sourceMode: "reliable",
    preferredLanguage: "en",
    previewAudit: {
      requiredGroups: [HOUSING_TERMS, LONDON_TERMS],
      forbiddenTerms: DRIFT_TERMS,
    },
    executionAudit: {
      requiredGroups: [HOUSING_TERMS, LONDON_TERMS],
      forbiddenTerms: DRIFT_TERMS,
    },
  },
  {
    name: "topic+country:uk-renewable-energy",
    criteria: "renewable energy",
    location: {
      displayName: "United Kingdom",
      country: "GB",
      locationType: "country",
    },
    sourceMode: "reliable",
    preferredLanguage: "en",
    previewAudit: {
      requiredGroups: [RENEWABLE_TERMS, UK_TERMS],
      forbiddenTerms: DRIFT_TERMS,
    },
    executionAudit: {
      requiredGroups: [RENEWABLE_TERMS, UK_TERMS],
      forbiddenTerms: DRIFT_TERMS,
    },
  },
];

function mustEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function parseArgs() {
  let scoutId: string | null = null;
  let scenarioPattern: string | null = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let verbose = false;
  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg === "--scout-id") scoutId = Deno.args[++i] ?? null;
    else if (arg === "--scenario") scenarioPattern = Deno.args[++i] ?? null;
    else if (arg === "--timeout-min") {
      timeoutMs = parseInt(Deno.args[++i], 10) * 60_000;
    } else if (arg === "--verbose") verbose = true;
  }
  return { scoutId, scenarioPattern, timeoutMs, verbose };
}

async function createBenchmarkUser(): Promise<BenchmarkUser> {
  const email = `beat-benchmark-${crypto.randomUUID()}@example.com`;
  const password = `BeatBench-${crypto.randomUUID()}`;

  const { data: created, error: createErr } = await service.auth.admin
    .createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createErr || !created.user) {
    throw new Error(`failed to create benchmark user: ${createErr?.message}`);
  }

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signInErr } = await anon.auth
    .signInWithPassword({
      email,
      password,
    });
  if (signInErr || !signedIn.session) {
    throw new Error(`failed to sign in benchmark user: ${signInErr?.message}`);
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

async function authedFetch(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/functions/v1${path}`, {
    method: init.method ?? "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
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

async function seedCredits(userId: string) {
  const { error } = await service.from("credit_accounts").upsert({
    user_id: userId,
    tier: "free",
    monthly_cap: 100,
    balance: 100,
    entitlement_source: "beat-benchmark",
  }, { onConflict: "user_id" });
  if (error) throw new Error(`credit seed failed: ${error.message}`);
}

function effectiveCriteria(scenario: Scenario): string | undefined {
  const criteria = scenario.criteria?.trim();
  if (criteria) return criteria;
  const topic = scenario.topic?.trim();
  return topic || undefined;
}

function previewCategories(
  scenario: Scenario,
): Array<"news" | "government" | "analysis"> {
  if (Deno.env.get("COJO_FULL_BEAT_BENCHMARK") !== "1") return ["news"];
  const hasLocation = Boolean(scenario.location);
  const hasCriteria = Boolean(effectiveCriteria(scenario));
  if (scenario.sourceMode === "niche" && hasLocation && !hasCriteria) {
    return ["news"];
  }
  return ["news", hasCriteria && !hasLocation ? "analysis" : "government"];
}

function textOfPreviewCategory(result: PreviewCategoryResult): string {
  return [
    result.summary,
    ...result.articles.flatMap((article) => [
      article.title ?? "",
      article.summary ?? "",
      article.source ?? "",
      article.url ?? "",
    ]),
  ].join("\n");
}

function textOfExecutionUnits(units: ExecutionUnit[]): string {
  return units.flatMap((unit) => [
    unit.statement,
    unit.source_title ?? "",
    unit.source_url ?? "",
    unit.city ?? "",
    unit.country ?? "",
    unit.topic ?? "",
  ]).join("\n");
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function findMatchedTerms(text: string, terms: string[]): string[] {
  const haystack = normalize(text);
  return terms.filter((term) => haystack.includes(normalize(term)));
}

function evaluateAudit(text: string, audit?: AuditExpectation): string[] {
  if (!audit) return [];
  const issues: string[] = [];

  for (const group of audit.requiredGroups ?? []) {
    const matches = findMatchedTerms(text, group);
    if (matches.length === 0) {
      issues.push(`missing any of [${group.join(", ")}]`);
    }
  }

  const forbidden = findMatchedTerms(text, audit.forbiddenTerms ?? []);
  if (forbidden.length > 0) {
    issues.push(`forbidden terms present: ${forbidden.join(", ")}`);
  }

  return issues;
}

async function runPreview(
  token: string,
  scenario: Scenario,
): Promise<PreviewRunResult> {
  const categories = previewCategories(scenario);
  const results: PreviewCategoryResult[] = [];

  for (const category of categories) {
    const res = await authedFetch(token, "/beat-search", {
      body: {
        category,
        location: scenario.location ?? undefined,
        criteria: effectiveCriteria(scenario),
        source_mode: scenario.sourceMode,
        excluded_domains: scenario.excludedDomains?.length
          ? scenario.excludedDomains
          : undefined,
        priority_sources: scenario.prioritySources?.length
          ? scenario.prioritySources
          : undefined,
      },
    });
    const body = await jsonOrThrow<{
      summary?: string;
      articles?: PreviewArticle[];
    }>(res, `preview ${scenario.name}/${category}`);

    results.push({
      category,
      summary: body.summary ?? "",
      articles: Array.isArray(body.articles) ? body.articles : [],
      articleCount: Array.isArray(body.articles) ? body.articles.length : 0,
    });
  }

  return {
    totalCount: results.reduce((sum, result) => sum + result.articleCount, 0),
    categories: results,
    combinedText: results.map(textOfPreviewCategory).join("\n\n"),
  };
}

async function createScout(
  token: string,
  scenario: Scenario,
): Promise<string> {
  const res = await authedFetch(token, "/scouts", {
    body: {
      name: `bench-beat-${scenario.name}-${crypto.randomUUID().slice(0, 8)}`,
      type: "beat",
      criteria: scenario.criteria ?? undefined,
      topic: scenario.topic ?? effectiveCriteria(scenario),
      location: scenario.location ?? undefined,
      source_mode: scenario.sourceMode,
      excluded_domains: scenario.excludedDomains?.length
        ? scenario.excludedDomains
        : undefined,
      priority_sources: scenario.prioritySources?.length
        ? scenario.prioritySources
        : undefined,
      preferred_language: scenario.preferredLanguage ?? "en",
      regularity: "weekly",
      schedule_cron: FUTURE_CRON,
    },
  });
  const body = await jsonOrThrow<{ id: string }>(
    res,
    `create scout ${scenario.name}`,
  );
  return body.id;
}

async function triggerScout(token: string, scoutId: string): Promise<string> {
  const res = await authedFetch(token, `/scouts/${scoutId}/run`, {
    body: {},
  });
  const body = await jsonOrThrow<{ run_id: string }>(
    res,
    `run scout ${scoutId}`,
  );
  return body.run_id;
}

async function waitForRun(
  runId: string,
  timeoutMs: number,
): Promise<{
  status: string;
  articles_count: number | null;
  error_message: string | null;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await service.from("scout_runs")
      .select("status, articles_count, error_message")
      .eq("id", runId)
      .maybeSingle();
    if (error) throw new Error(`run lookup failed: ${error.message}`);
    if (data && data.status !== "queued" && data.status !== "running") {
      return {
        status: String(data.status),
        articles_count: typeof data.articles_count === "number"
          ? data.articles_count
          : null,
        error_message: typeof data.error_message === "string"
          ? data.error_message
          : null,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`timed out waiting for run ${runId}`);
}

async function fetchUnits(scoutId: string): Promise<ExecutionUnit[]> {
  const { data, error } = await service.from("information_units")
    .select("statement, source_title, source_url, country, city, topic")
    .eq("scout_id", scoutId)
    .limit(25);
  if (error) throw new Error(`unit fetch failed: ${error.message}`);
  return Array.isArray(data) ? data as ExecutionUnit[] : [];
}

async function cleanupScout(scoutId: string) {
  await service.from("scouts").delete().eq("id", scoutId);
}

async function cloneScenarioFromScout(scoutId: string): Promise<Scenario> {
  const { data, error } = await service.from("scouts")
    .select(
      "name, criteria, topic, location, source_mode, excluded_domains, priority_sources, preferred_language",
    )
    .eq("id", scoutId)
    .maybeSingle();
  if (error) {
    throw new Error(`failed to load scout ${scoutId}: ${error.message}`);
  }
  if (!data) throw new Error(`scout ${scoutId} not found`);
  return {
    name: `replay:${scoutId}`,
    criteria: typeof data.criteria === "string" ? data.criteria : undefined,
    topic: typeof data.topic === "string" ? data.topic : null,
    location: (data.location ?? null) as BenchLocation | null,
    sourceMode: data.source_mode === "niche" ? "niche" : "reliable",
    excludedDomains: Array.isArray(data.excluded_domains)
      ? data.excluded_domains.filter((d): d is string => typeof d === "string")
      : [],
    prioritySources: Array.isArray(data.priority_sources)
      ? data.priority_sources.filter((d): d is string => typeof d === "string")
      : [],
    preferredLanguage: typeof data.preferred_language === "string"
      ? data.preferred_language
      : "en",
  };
}

function samplePreview(result: PreviewRunResult): string {
  const first = result.categories.find((category) =>
    category.articles.length > 0
  );
  if (!first) return "";
  const title = first.articles[0]?.title?.trim();
  const summary = first.summary.trim();
  return [
    title ? `title=${title}` : "",
    summary ? `summary=${summary.slice(0, 180)}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function sampleExecution(units: ExecutionUnit[]): string {
  const first = units[0];
  if (!first) return "";
  return [first.source_title ?? "", first.statement ?? ""]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 220);
}

async function runScenario(
  token: string,
  scenario: Scenario,
  timeoutMs: number,
  verbose: boolean,
): Promise<Result> {
  const startedAt = performance.now();
  let lastResult: Result | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let scoutId: string | null = null;
    try {
      const preview = await runPreview(token, scenario);
      const previewIssues = [
        ...(preview.totalCount > 0 ? [] : ["preview returned zero articles"]),
        ...evaluateAudit(preview.combinedText, scenario.previewAudit),
      ];

      scoutId = await createScout(token, scenario);
      const runId = await triggerScout(token, scoutId);
      const run = await waitForRun(runId, timeoutMs);
      const units = await fetchUnits(scoutId);
      const execution: ExecutionRunResult = {
        status: run.status,
        articlesCount: Math.max(run.articles_count ?? 0, units.length),
        units,
        combinedText: textOfExecutionUnits(units),
        errorMessage: run.error_message,
      };
      const executionIssues = [
        ...(execution.articlesCount > 0
          ? []
          : ["execution returned zero units"]),
        ...(execution.status === "success"
          ? []
          : [`status=${execution.status}`]),
        ...evaluateAudit(execution.combinedText, scenario.executionAudit),
      ];

      const issues = [...previewIssues, ...executionIssues];
      const ok = issues.length === 0;
      const detailParts = [
        ...issues,
        ...(verbose && !ok && samplePreview(preview)
          ? [`preview_sample=${samplePreview(preview)}`]
          : []),
        ...(verbose && !ok && sampleExecution(units)
          ? [`execution_sample=${sampleExecution(units)}`]
          : []),
        ...(!ok && run.error_message ? [`run_error=${run.error_message}`] : []),
        ...(attempt > 1 ? [`attempt=${attempt}`] : []),
      ];

      lastResult = {
        name: scenario.name,
        previewCount: preview.totalCount,
        executionCount: execution.articlesCount,
        elapsedMs: Math.round(performance.now() - startedAt),
        ok,
        detail: detailParts.length > 0 ? detailParts.join(" | ") : undefined,
      };
      if (ok || !shouldRetry(lastResult.detail)) {
        return lastResult;
      }
    } catch (error) {
      lastResult = {
        name: scenario.name,
        previewCount: 0,
        executionCount: 0,
        elapsedMs: Math.round(performance.now() - startedAt),
        ok: false,
        detail: [
          error instanceof Error ? error.message : String(error),
          ...(attempt > 1 ? [`attempt=${attempt}`] : []),
        ].join(" | "),
      };
      if (!shouldRetry(lastResult.detail)) {
        return lastResult;
      }
    } finally {
      if (scoutId) await cleanupScout(scoutId).catch(() => undefined);
    }
  }

  return lastResult ?? {
    name: scenario.name,
    previewCount: 0,
    executionCount: 0,
    elapsedMs: Math.round(performance.now() - startedAt),
    ok: false,
    detail: "scenario failed without a captured result",
  };
}

function shouldRetry(detail: string | undefined): boolean {
  if (!detail) return false;
  return detail.includes("timed out waiting for run") ||
    detail.includes("preview returned zero articles") ||
    detail.includes("execution returned zero units");
}

function printResult(result: Result) {
  const status = result.ok ? "PASS" : "FAIL";
  const detail = result.detail ? ` | ${result.detail}` : "";
  console.log(
    `[${status}] ${result.name} | preview=${result.previewCount} | execution=${result.executionCount} | ${
      (result.elapsedMs / 1000).toFixed(1)
    }s${detail}`,
  );
}

const { scoutId, scenarioPattern, timeoutMs, verbose } = parseArgs();
const benchmarkUser = await createBenchmarkUser();

try {
  await seedCredits(benchmarkUser.id);
  const scenarios = scoutId
    ? [await cloneScenarioFromScout(scoutId)]
    : scenarioPattern
    ? CANARIES.filter((scenario) => scenario.name.includes(scenarioPattern))
    : Deno.env.get("COJO_FULL_BEAT_BENCHMARK") === "1"
    ? CANARIES
    : CANARIES.slice(0, DEFAULT_CANARY_COUNT);
  if (scenarios.length === 0) {
    throw new Error(`no benchmark scenarios matched ${scenarioPattern}`);
  }

  console.log(
    `Running Beat Scout live audit as temp user ${benchmarkUser.email} (${benchmarkUser.id})`,
  );

  let failed = 0;
  for (const scenario of scenarios) {
    const result = await runScenario(
      benchmarkUser.token,
      scenario,
      timeoutMs,
      verbose,
    );
    printResult(result);
    if (!result.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(
      `Beat Scout live audit failed (${failed}/${scenarios.length})`,
    );
    Deno.exit(1);
  }
  console.log(
    `Beat Scout live audit passed (${scenarios.length}/${scenarios.length})`,
  );
} finally {
  await benchmarkUser.cleanup();
}
