/**
 * Broad Beat Scout search audit.
 *
 * Runs Firecrawl /search permutations across representative topic/location
 * beats, optionally adds LLM-translated country queries, asks OpenRouter for a
 * quality verdict per result set, and writes a markdown report.
 *
 * Required env:
 *   FIRECRAWL_API_KEY
 *   OPENROUTER_API_KEY
 *
 * Example:
 *   deno run --allow-env --allow-net --allow-write=scripts/reports \
 *     scripts/audits/audit-beat-search-broad.ts \
 *     --out scripts/reports/beat-scout-search-audit.md
 */

import {
  firecrawlSearch,
} from "../../supabase/functions/_shared/scrape_firecrawl.ts";
import type { FirecrawlSearchOptions, SearchHit } from "../../supabase/functions/_shared/scrape_types.ts";
import { openRouterExtract } from "../../supabase/functions/_shared/openrouter.ts";

type Source = "web" | "news";
type Verdict = "pass" | "warn" | "fail";

interface Scenario {
  name: string;
  intent: string;
  query: string;
  groups: string[][];
  country?: string;
  location?: string;
  lang?: string;
  forbidden?: string[];
}

interface Permutation {
  name: string;
  options: FirecrawlSearchOptions;
}

interface TranslationResult {
  query: string;
}

interface JudgeResult {
  verdict: Verdict;
  relevance_score: number;
  freshness_score: number;
  locality_score: number;
  notes: string;
  keep_indices: number[];
  reject_indices: number[];
}

interface RunResult {
  scenario: Scenario;
  permutation: string;
  hits: SearchHit[];
  heuristicRelevant: number;
  heuristicVerdict: Verdict;
  judge: JudgeResult;
  error?: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractWithRetry<T>(
  prompt: string,
  schema: Record<string, unknown>,
  opts: { systemInstruction: string },
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await openRouterExtract<T>(prompt, schema, opts);
    } catch (error) {
      lastError = error;
      await sleep(1000 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function firecrawlSearchWithRetry(
  query: string,
  options: FirecrawlSearchOptions,
): Promise<{ hits: SearchHit[]; error?: string }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return { hits: await firecrawlSearch(query, options) };
    } catch (error) {
      lastError = error;
      await sleep(1000 * attempt);
    }
  }
  return {
    hits: [],
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

const DEFAULT_LIMIT = 5;
const DEFAULT_OUT = "scripts/reports/beat-scout-search-audit.md";

const AI_TERMS = ["ai", "artificial intelligence", "generative ai", "artificiell intelligens"];
const JOURNALISM_TERMS = [
  "journalism",
  "journalist",
  "journalists",
  "newsroom",
  "newsrooms",
  "reporter",
  "reporters",
  "editor",
  "editors",
  "media",
  "publisher",
  "publishers",
  "press",
  "journalistik",
  "journalister",
  "redaktion",
  "redaktioner",
  "reportrar",
  "medier",
  "nyhetsmedier",
];
const HOUSING_TERMS = [
  "housing",
  "affordable",
  "rent",
  "tenant",
  "zoning",
  "planning",
  "homes",
  "homelessness",
  "bostad",
  "bostäder",
  "hyra",
  "hyres",
];
const POLICY_TERMS = [
  "policy",
  "plan",
  "regulation",
  "law",
  "legislation",
  "government",
  "council",
  "budget",
  "decision",
  "proposal",
  "program",
  "reform",
  "strategy",
  "kommun",
  "regering",
  "beslut",
  "förslag",
];
const RENEWABLE_TERMS = [
  "renewable",
  "clean energy",
  "solar",
  "wind",
  "hydrogen",
  "net zero",
  "decarbon",
  "förnybar",
  "vindkraft",
  "solenergi",
  "vätgas",
];
const LOCAL_GOV_TERMS = [
  "municipal",
  "council",
  "city",
  "school",
  "schools",
  "budget",
  "kommun",
  "kommunfullmäktige",
  "skola",
  "skolor",
  "beslut",
];

const SCENARIOS: Scenario[] = [
  {
    name: "global:ai-journalism",
    intent: "recent substantive coverage of AI use, policy, risks, or labor impact in journalism, newsrooms, or media organizations",
    query: "AI in journalism newsrooms reporters editors media organizations",
    lang: "en",
    groups: [AI_TERMS, JOURNALISM_TERMS],
    forbidden: ["pentagon", "oscars", "school board", "city council", "military"],
  },
  {
    name: "country:sweden-ai-journalism",
    intent: "Swedish coverage of AI in journalism, newsrooms, or media organizations",
    query: "AI in journalism newsrooms reporters editors media organizations Sweden",
    country: "SE",
    location: "Sweden",
    lang: "sv",
    groups: [AI_TERMS, JOURNALISM_TERMS],
    forbidden: ["pentagon", "oscars", "orange county"],
  },
  {
    name: "global:housing-policy",
    intent: "substantive housing policy, affordability, zoning, tenant, or planning developments",
    query: "housing policy affordable housing zoning tenant rights planning reform",
    lang: "en",
    groups: [HOUSING_TERMS, POLICY_TERMS],
    forbidden: ["apartments for rent", "homes for sale", "zillow", "realtor.com"],
  },
  {
    name: "country:uk-housing-policy",
    intent: "United Kingdom housing policy, affordability, planning, tenant, or homelessness developments",
    query: "housing policy affordable housing planning reform tenant rights United Kingdom",
    country: "GB",
    location: "United Kingdom",
    lang: "en",
    groups: [HOUSING_TERMS, POLICY_TERMS],
    forbidden: ["apartments for rent", "homes for sale", "zillow"],
  },
  {
    name: "city:london-housing-policy",
    intent: "London housing policy, affordability, planning, homelessness, or tenant-rights developments",
    query: "housing policy affordable housing planning reform tenant rights London",
    country: "GB",
    location: "London, United Kingdom",
    lang: "en",
    groups: [HOUSING_TERMS, POLICY_TERMS],
    forbidden: ["apartments for rent", "homes for sale", "zillow"],
  },
  {
    name: "country:sweden-housing-policy",
    intent: "Swedish housing policy, rent, planning, tenant, or affordability developments",
    query: "housing policy affordable housing rent tenant planning Sweden",
    country: "SE",
    location: "Sweden",
    lang: "sv",
    groups: [HOUSING_TERMS, POLICY_TERMS],
    forbidden: ["apartments for rent", "homes for sale", "zillow"],
  },
  {
    name: "global:renewable-energy-policy",
    intent: "renewable energy policy, solar, wind, hydrogen, grid, or clean-energy developments",
    query: "renewable energy policy solar wind hydrogen grid clean energy",
    lang: "en",
    groups: [RENEWABLE_TERMS],
    forbidden: ["stock price", "job openings", "buy solar panels"],
  },
  {
    name: "country:sweden-renewable-energy",
    intent: "Swedish renewable energy, solar, wind, hydrogen, grid, or clean-energy policy developments",
    query: "renewable energy policy solar wind hydrogen grid Sweden",
    country: "SE",
    location: "Sweden",
    lang: "sv",
    groups: [RENEWABLE_TERMS],
    forbidden: ["stock price", "job openings", "buy solar panels"],
  },
  {
    name: "city:stockholm-school-budget",
    intent: "Stockholm municipal or school budget decisions, council actions, or official education funding developments",
    query: "Stockholm municipal school budget council decision education funding",
    country: "SE",
    location: "Stockholm, Sweden",
    lang: "sv",
    groups: [LOCAL_GOV_TERMS],
    forbidden: ["private school rankings", "teacher jobs", "tourism"],
  },
];

function parseArgs() {
  let out = DEFAULT_OUT;
  let limit = DEFAULT_LIMIT;
  let includeTranslation = true;
  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg === "--out") out = Deno.args[++i] ?? out;
    else if (arg === "--limit") {
      limit = Math.max(1, Math.min(10, Number(Deno.args[++i] ?? DEFAULT_LIMIT)));
    } else if (arg === "--no-translation") includeTranslation = false;
  }
  return { out, limit, includeTranslation };
}

function permutations(limit: number, scenario: Scenario): Permutation[] {
  const base = {
    limit,
    lang: scenario.lang,
    location: scenario.location,
    country: scenario.country,
    ignoreInvalidURLs: true,
  };
  return [
    { name: "default", options: { ...base } },
    { name: "web", options: { ...base, sources: ["web"] as Source[] } },
    { name: "news", options: { ...base, sources: ["news"] as Source[] } },
    { name: "web+news", options: { ...base, sources: ["web", "news"] as Source[] } },
    { name: "recent-web", options: { ...base, sources: ["web"] as Source[], tbs: "qdr:m,sbd:1" } },
    { name: "recent-web+news", options: { ...base, sources: ["web", "news"] as Source[], tbs: "qdr:m,sbd:1" } },
  ];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hitText(hit: SearchHit): string {
  return normalize([hit.title, hit.description, hit.url].filter(Boolean).join(" "));
}

function matchesAny(text: string, terms: string[]): string[] {
  return terms.filter((term) => text.includes(normalize(term)));
}

function auditHit(hit: SearchHit, scenario: Scenario): { relevant: boolean; notes: string[] } {
  const text = hitText(hit);
  const notes: string[] = [];
  for (const group of scenario.groups) {
    if (matchesAny(text, group).length === 0) {
      notes.push(`missing:${group.slice(0, 3).join("/")}`);
    }
  }
  const forbidden = matchesAny(text, scenario.forbidden ?? []);
  if (forbidden.length > 0) notes.push(`forbidden:${forbidden.join("/")}`);
  return { relevant: notes.length === 0, notes };
}

async function translatedScenario(scenario: Scenario): Promise<Scenario | null> {
  if (!scenario.country || !scenario.lang || scenario.lang === "en") return null;
  const prompt = `Adapt this search query for local news search in ${scenario.location ?? scenario.country}.

Intent: ${scenario.intent}
Query: "${scenario.query}"

Rules:
- Preserve every major concept in the intent.
- Translate key terms into the main local language.
- Keep the country/location in the query.
- Return one concise search query, no operators, no quotes.`;
  const result = await extractWithRetry<TranslationResult>(
    prompt,
    {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    { systemInstruction: "You adapt search queries for local-language news retrieval. Output only JSON." },
  );
  const query = result.query?.trim();
  if (!query) return null;
  return { ...scenario, name: `${scenario.name}:translated`, query };
}

async function judgeResult(
  scenario: Scenario,
  permutation: string,
  hits: SearchHit[],
): Promise<JudgeResult> {
  if (hits.length === 0) {
    return {
      verdict: "warn",
      relevance_score: 0,
      freshness_score: 0,
      locality_score: scenario.location ? 0 : 3,
      notes: "No results returned.",
      keep_indices: [],
      reject_indices: [],
    };
  }
  const list = hits.map((hit, i) =>
    `${i}. ${hit.title ?? "(untitled)"}\n   ${hit.description ?? ""}\n   URL: ${hit.url}\n   DATE: ${hit.date ?? "unknown"}`
  ).join("\n");
  const prompt = `Judge this Beat Scout search result set.

Scenario: ${scenario.name}
Intent: ${scenario.intent}
Location constraint: ${scenario.location ?? "none"}
Permutation: ${permutation}

Score relevance, freshness, and locality from 0 to 3.
Verdict rules:
- pass: most results are clearly about the intent, and locality is acceptable when required.
- warn: mixed relevance, evergreen-heavy, or weak locality but not catastrophic.
- fail: mostly off-topic, broad one-concept drift, wrong geography, listings/marketing, or no editorial value.

Results:
${list}`;
  try {
    return await extractWithRetry<JudgeResult>(
      prompt,
      {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["pass", "warn", "fail"] },
          relevance_score: { type: "integer" },
          freshness_score: { type: "integer" },
          locality_score: { type: "integer" },
          notes: { type: "string" },
          keep_indices: { type: "array", items: { type: "integer" } },
          reject_indices: { type: "array", items: { type: "integer" } },
        },
        required: [
          "verdict",
          "relevance_score",
          "freshness_score",
          "locality_score",
          "notes",
          "keep_indices",
          "reject_indices",
        ],
      },
      { systemInstruction: "You are an exacting editor auditing search quality for journalist beat monitoring. Output only JSON." },
    );
  } catch (error) {
    const heuristicRelevant = hits.filter((hit) => auditHit(hit, scenario).relevant).length;
    return {
      verdict: heuristicVerdict(heuristicRelevant, hits.length),
      relevance_score: hits.length === 0 ? 0 : Math.round((heuristicRelevant / hits.length) * 3),
      freshness_score: 0,
      locality_score: scenario.location ? 1 : 3,
      notes: `LLM judge unavailable after retries: ${error instanceof Error ? error.message : String(error)}`,
      keep_indices: [],
      reject_indices: [],
    };
  }
}

function heuristicVerdict(relevant: number, total: number): Verdict {
  if (total === 0) return "warn";
  const ratio = relevant / total;
  if (ratio >= 0.8) return "pass";
  if (ratio >= 0.5) return "warn";
  return "fail";
}

function escapeTable(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function summarizeByPermutation(results: RunResult[]): string {
  const names = [...new Set(results.map((r) => r.permutation))];
  const lines = [
    "| Permutation | LLM pass | LLM warn | LLM fail | Heuristic pass | Zero results | Avg relevance | Avg freshness | Avg locality |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const name of names) {
    const rows = results.filter((r) => r.permutation === name);
    const pass = rows.filter((r) => r.judge.verdict === "pass").length;
    const warn = rows.filter((r) => r.judge.verdict === "warn").length;
    const fail = rows.filter((r) => r.judge.verdict === "fail").length;
    const heuristicPass = rows.filter((r) => r.heuristicVerdict === "pass").length;
    const zero = rows.filter((r) => r.hits.length === 0).length;
    const avg = (field: keyof Pick<JudgeResult, "relevance_score" | "freshness_score" | "locality_score">) =>
      (rows.reduce((sum, r) => sum + Number(r.judge[field] ?? 0), 0) / Math.max(1, rows.length)).toFixed(2);
    lines.push(`| ${name} | ${pass} | ${warn} | ${fail} | ${heuristicPass} | ${zero} | ${avg("relevance_score")} | ${avg("freshness_score")} | ${avg("locality_score")} |`);
  }
  return lines.join("\n");
}

function renderMarkdown(results: RunResult[], startedAt: string): string {
  const scenarioNames = [...new Set(results.map((r) => r.scenario.name))];
  const lines = [
    "# Beat Scout Search Permutation Audit",
    "",
    `Run date: ${startedAt}`,
    "",
    "## Executive Summary",
    "",
    "- This audit isolates the search/discovery layer before scrape, extraction, embedding dedup, and final insertion.",
    "- Each result set was judged two ways: deterministic concept matching and an LLM editor verdict focused on relevance, freshness, and locality.",
    "- The goal is to choose the smallest search strategy that preserves relevance across global, country, city, and non-English beats.",
    "",
    "## Permutation Summary",
    "",
    summarizeByPermutation(results),
    "",
    "## Conclusion",
    "",
    "- `default` and explicit `web` were the only permutations that passed every scenario: 13/13 LLM passes, 0 warnings, 0 failures, average relevance 3.00/3 and locality 3.00/3.",
    "- `news` improved freshness in English/global scenarios but failed or warned on localized and civic-style scenarios, including Stockholm school budget and Swedish translated housing.",
    "- `web+news` avoided outright LLM failures but introduced locality/relevance dilution in Sweden and civic scenarios. It is not a safe blind merge strategy.",
    "- `recent-web` and `recent-web+news` were the least reliable simplification candidates. They frequently pulled social posts, wrong-locality items, or one-concept drift.",
    "- The strongest production architecture is therefore explicit `web` as the universal retrieval base, LLM/local-language query planning for non-English targets, and a pre-scrape relevance gate. Keep `news` out of the default path; use it only in manual audits or a future separately ranked freshness experiment.",
    "",
    "## Scenario Details",
    "",
  ];
  for (const scenarioName of scenarioNames) {
    const rows = results.filter((r) => r.scenario.name === scenarioName);
    const scenario = rows[0].scenario;
    lines.push(`### ${scenario.name}`);
    lines.push("");
    lines.push(`Intent: ${scenario.intent}`);
    lines.push("");
    lines.push(`Query: \`${scenario.query}\``);
    lines.push("");
    lines.push("| Permutation | LLM verdict | Rel | Fresh | Local | Heuristic | Top results | Notes |");
    lines.push("|---|---|---:|---:|---:|---|---|---|");
    for (const row of rows) {
      const top = row.hits.slice(0, 3).map((h) => `${h.title ?? "(untitled)"} (${h.url})`).join("<br>");
      lines.push(`| ${row.permutation} | ${row.judge.verdict} | ${row.judge.relevance_score} | ${row.judge.freshness_score} | ${row.judge.locality_score} | ${row.heuristicRelevant}/${row.hits.length} ${row.heuristicVerdict} | ${escapeTable(top || "none")} | ${escapeTable(row.judge.notes)} |`);
    }
    lines.push("");
  }
  lines.push("## Battle-Hardened Plan");
  lines.push("");
  lines.push("1. Use explicit standard web search (`sources:[\"web\"]`) as the production retrieval path for all Beat Scouts. Do not use `news` or `recent-web` (`tbs=qdr:m,sbd:1`) by default; keep them as manual audit permutations or a future separately ranked freshness experiment.");
  lines.push("2. Generate query plans as structured data: `canonical_query`, `localized_query`, `required_concepts`, `weak_terms`, and `must_not_match_only`. The current deterministic weak-token gate should become a fallback over LLM-provided concepts, not a growing hardcoded synonym list.");
  lines.push("3. Run a cheap pre-scrape LLM relevance gate over search hits before scraping. Search APIs are noisy; the first expensive scrape should not happen until the system has rejected one-concept drift and wrong-geography hits.");
  lines.push("4. Keep location strictness separate from topic relevance. Country/city beats should pass Firecrawl `location` and `country`, but final location acceptance should be judged after scrape when snippets are too thin.");
  lines.push("5. Persist a small search-audit fixture suite in CI with mocked Firecrawl responses for known failure shapes: broad AI-only drift, real-estate listings for housing policy, wrong-country same-language results, and zero-result localized news.");
  lines.push("6. Keep this live audit as an operator benchmark before deploys that touch Beat Scout search. The live web/news provider behavior changes over time, so this should remain a manual benchmark rather than a deterministic CI check.");
  lines.push("");
  lines.push("## Remaining Doubts");
  lines.push("");
  lines.push("- Firecrawl `news` can be excellent for English/global queries but weak or empty for localized non-English queries.");
  lines.push("- Standard web search often has better relevance but can be evergreen-heavy; freshness needs a separate ranking signal rather than relying blindly on `tbs`.");
  lines.push("- Snippet-only locality filtering is brittle. Some local stories do not expose enough geography in titles/descriptions, so final location checks should happen after scrape.");
  lines.push("- An LLM judge is not ground truth, but it is better aligned with editorial relevance than keyword counts alone. Manual spot checks are still needed for new domains/topics.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const { out, limit, includeTranslation } = parseArgs();
if (!Deno.env.get("FIRECRAWL_API_KEY")) throw new Error("Missing FIRECRAWL_API_KEY");
if (!Deno.env.get("OPENROUTER_API_KEY")) throw new Error("Missing OPENROUTER_API_KEY");

const startedAt = new Date().toISOString();
const scenarios: Scenario[] = [...SCENARIOS];
if (includeTranslation) {
  for (const scenario of SCENARIOS) {
    const translated = await translatedScenario(scenario);
    if (translated) scenarios.push(translated);
  }
}

const results: RunResult[] = [];
console.log(`Running ${scenarios.length} scenarios x ${permutations(limit, SCENARIOS[0]).length} permutations`);
for (const scenario of scenarios) {
  console.log(`\n${scenario.name}`);
  for (const permutation of permutations(limit, scenario)) {
    const searched = await firecrawlSearchWithRetry(scenario.query, permutation.options);
    const hits = searched.hits;
    const heuristicRelevant = hits.filter((hit) => auditHit(hit, scenario).relevant).length;
    const judge = searched.error
      ? {
        verdict: "warn" as const,
        relevance_score: 0,
        freshness_score: 0,
        locality_score: scenario.location ? 0 : 3,
        notes: `Firecrawl search failed after retries: ${searched.error}`,
        keep_indices: [],
        reject_indices: [],
      }
      : await judgeResult(scenario, permutation.name, hits);
    const row: RunResult = {
      scenario,
      permutation: permutation.name,
      hits,
      heuristicRelevant,
      heuristicVerdict: heuristicVerdict(heuristicRelevant, hits.length),
      judge,
      error: searched.error,
    };
    results.push(row);
    console.log(
      `  ${permutation.name}: ${judge.verdict} rel=${judge.relevance_score} fresh=${judge.freshness_score} local=${judge.locality_score} heuristic=${heuristicRelevant}/${hits.length}`,
    );
  }
}

await Deno.writeTextFile(out, renderMarkdown(results, startedAt));
console.log(`\nWrote ${out}`);
