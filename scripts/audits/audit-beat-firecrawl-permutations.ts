/**
 * Focused Beat Scout Firecrawl permutation audit.
 *
 * This isolates the search layer from the full preview/execution benchmark and
 * compares Firecrawl /search permutations:
 *   - default source behaviour
 *   - explicit web
 *   - explicit news
 *   - web + news
 *   - recent web via tbs
 *   - optional LLM-adapted local-language query for a source country
 *
 * Required env:
 *   FIRECRAWL_API_KEY
 *
 * Optional env:
 *   OPENROUTER_API_KEY  enables translated country query variants
 *
 * Example:
 *   deno run --allow-env --allow-net scripts/audits/audit-beat-firecrawl-permutations.ts
 */

import {
  firecrawlSearch,
} from "../../supabase/functions/_shared/scrape_firecrawl.ts";
import type { FirecrawlSearchOptions, SearchHit } from "../../supabase/functions/_shared/scrape_types.ts";
import { openRouterExtract } from "../../supabase/functions/_shared/openrouter.ts";

type Source = "web" | "news";

interface Scenario {
  name: string;
  query: string;
  country?: string;
  location?: string;
  lang?: string;
  groups: string[][];
  forbidden?: string[];
}

interface Permutation {
  name: string;
  options: FirecrawlSearchOptions;
}

interface TranslationResult {
  query: string;
}

const DEFAULT_LIMIT = 5;

const AI_TERMS = [
  "ai",
  "artificial intelligence",
  "generative ai",
  "artificiell intelligens",
];
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
  "journalist",
  "journalister",
  "redaktion",
  "redaktioner",
  "reportrar",
  "medier",
  "nyhetsmedier",
];

const SCENARIOS: Scenario[] = [
  {
    name: "global:ai-journalism",
    query: "AI in journalism newsrooms reporters editors media organizations",
    lang: "en",
    groups: [AI_TERMS, JOURNALISM_TERMS],
    forbidden: [
      "pentagon",
      "oscars",
      "school board",
      "city council",
      "military",
    ],
  },
  {
    name: "country:sweden-ai-journalism",
    query:
      "AI in journalism newsrooms reporters editors media organizations Sweden",
    country: "SE",
    location: "Sweden",
    lang: "sv",
    groups: [AI_TERMS, JOURNALISM_TERMS],
    forbidden: ["pentagon", "oscars", "orange county"],
  },
];

function parseArgs() {
  let limit = DEFAULT_LIMIT;
  let includeTranslation = true;
  let simpleWeb = false;
  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg === "--limit") {
      limit = Math.max(
        1,
        Math.min(20, Number(Deno.args[++i] ?? DEFAULT_LIMIT)),
      );
    } else if (arg === "--no-translation") includeTranslation = false;
    else if (arg === "--simple-web") simpleWeb = true;
  }
  return { limit, includeTranslation, simpleWeb };
}

function permutations(
  limit: number,
  scenario: Scenario,
  simpleWeb = false,
): Permutation[] {
  const base = {
    limit,
    lang: scenario.lang,
    location: scenario.location,
    country: scenario.country,
    ignoreInvalidURLs: true,
  };
  const all = [
    { name: "default", options: { ...base } },
    { name: "web", options: { ...base, sources: ["web"] as Source[] } },
    { name: "news", options: { ...base, sources: ["news"] as Source[] } },
    {
      name: "web+news",
      options: { ...base, sources: ["web", "news"] as Source[] },
    },
    {
      name: "recent-web",
      options: { ...base, sources: ["web"] as Source[], tbs: "qdr:m,sbd:1" },
    },
    {
      name: "recent-web+news",
      options: {
        ...base,
        sources: ["web", "news"] as Source[],
        tbs: "qdr:m,sbd:1",
      },
    },
  ];
  if (!simpleWeb) return all;
  return all.filter((p) =>
    p.name === "default" || p.name === "web"
  );
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hitText(hit: SearchHit): string {
  return normalize(
    [hit.title, hit.description, hit.url].filter(Boolean).join(" "),
  );
}

function matchesAny(text: string, terms: string[]): string[] {
  return terms.filter((term) => text.includes(normalize(term)));
}

function auditHit(
  hit: SearchHit,
  scenario: Scenario,
): { relevant: boolean; notes: string[] } {
  const text = hitText(hit);
  const notes: string[] = [];
  for (const group of scenario.groups) {
    const matches = matchesAny(text, group);
    if (matches.length === 0) {
      notes.push(`missing:${group.slice(0, 3).join("/")}`);
    }
  }
  const forbidden = matchesAny(text, scenario.forbidden ?? []);
  if (forbidden.length > 0) notes.push(`forbidden:${forbidden.join("/")}`);
  return { relevant: notes.length === 0, notes };
}

async function translatedScenario(
  scenario: Scenario,
): Promise<Scenario | null> {
  if (!scenario.country || !scenario.lang || !Deno.env.get("OPENROUTER_API_KEY")) {
    return null;
  }
  const prompt = `Adapt this search query for local news search in ${
    scenario.location ?? scenario.country
  }.

Query: "${scenario.query}"

Rules:
- Preserve every topic concept, especially compound concepts like AI + journalism.
- Translate key terms into the main local language.
- Keep the country/location in the query.
- Return one concise search query, no operators, no quotes.`;

  const result = await openRouterExtract<TranslationResult>(
    prompt,
    {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    {
      systemInstruction:
        "You adapt search queries for local-language news retrieval. Output only JSON.",
    },
  );
  const query = result.query?.trim();
  if (!query) return null;
  return {
    ...scenario,
    name: `${scenario.name}:translated`,
    query,
  };
}

function printHits(hits: SearchHit[], scenario: Scenario) {
  hits.slice(0, 3).forEach((hit, idx) => {
    const audit = auditHit(hit, scenario);
    const status = audit.relevant ? "ok" : `bad ${audit.notes.join(",")}`;
    console.log(`    ${idx + 1}. [${status}] ${hit.title ?? "(untitled)"}`);
    console.log(`       ${hit.url}`);
  });
}

const { limit, includeTranslation, simpleWeb } = parseArgs();
if (!Deno.env.get("FIRECRAWL_API_KEY")) {
  throw new Error("Missing FIRECRAWL_API_KEY");
}

const scenarios: Scenario[] = [...SCENARIOS];
if (includeTranslation) {
  for (const scenario of SCENARIOS) {
    const translated = await translatedScenario(scenario);
    if (translated) scenarios.push(translated);
  }
}

console.log(
  `Beat Firecrawl permutation audit (${scenarios.length} scenarios, limit=${limit})`,
);

let failures = 0;
let warnings = 0;
for (const scenario of scenarios) {
  console.log(`\n## ${scenario.name}`);
  console.log(`query="${scenario.query}"`);
  for (const permutation of permutations(limit, scenario, simpleWeb)) {
    const hits = await firecrawlSearch(scenario.query, permutation.options);
    const audits = hits.map((hit) => auditHit(hit, scenario));
    const relevant = audits.filter((audit) => audit.relevant).length;
    const ratio = hits.length === 0 ? 0 : relevant / hits.length;
    const status = hits.length === 0 ? "WARN" : ratio >= 0.6 ? "PASS" : "FAIL";
    if (status === "FAIL") failures++;
    if (status === "WARN") warnings++;
    console.log(
      `  [${status}] ${permutation.name}: ${relevant}/${hits.length} relevant`,
    );
    printHits(hits, scenario);
  }
}

if (failures > 0) {
  console.error(
    `\nPermutation audit failed: ${failures} low-relevance permutation(s)`,
  );
  Deno.exit(1);
}
if (warnings > 0) {
  console.warn(
    `\nPermutation audit passed with ${warnings} zero-result warning(s)`,
  );
}
