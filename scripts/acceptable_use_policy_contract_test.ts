import assert from "node:assert/strict";

const ROOT = new URL("../", import.meta.url);
const POLICY_PATH = "frontend/static/acceptable-use-policy.json";
const POLICY_URL = "/terms#acceptable-use";
const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const SEVERITY_LEVELS = ["medium", "high"] as const;
const RULE_IDS = [
  "AUP-PRIVATE-ACCESS",
  "AUP-STALKING-HARASSMENT-DOXXING",
  "AUP-COERCIVE-DISCRIMINATORY-SURVEILLANCE",
  "AUP-PROMPT-INJECTION",
  "AUP-RATE-LIMIT-ABUSE",
  "AUP-MISINFORMATION",
] as const;

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROOT));
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  assert.ok(typeof value === "string", `${label} must be a string`);
  assert.ok(value.trim().length > 0, `${label} must not be empty`);
  return value;
}

function confidence(value: unknown, label: string): void {
  assert.ok(
    CONFIDENCE_LEVELS.includes(value as typeof CONFIDENCE_LEVELS[number]),
    `${label} must be low, medium, or high`,
  );
}

Deno.test("machine-readable acceptable-use contract is stable and evidence-led", async () => {
  const contract = record(JSON.parse(await source(POLICY_PATH)), "policy");

  assert.equal(contract.schema_version, 1);
  assert.equal(contract.policy_url, POLICY_URL);
  assert.deepEqual(contract.confidence_levels, CONFIDENCE_LEVELS);
  assert.deepEqual(contract.severity_levels, SEVERITY_LEVELS);

  const highConfidence = record(
    contract.high_confidence,
    "policy.high_confidence",
  );
  assert.equal(highConfidence.requires_corroboration, true);
  assert.equal(highConfidence.minimum_evidence_items, 2);
  assert.equal(highConfidence.requires_published_rule_citation, true);
  assert.equal(highConfidence.model_output_alone_sufficient, false);

  const enforcement = record(contract.enforcement, "policy.enforcement");
  assert.equal(enforcement.mode, "operator-review-only");
  assert.equal(enforcement.automatic_action, false);

  assert.ok(Array.isArray(contract.rules), "policy.rules must be an array");
  const rules = contract.rules.map((value, index) =>
    record(value, `policy.rules[${index}]`)
  );
  assert.deepEqual(
    rules.map((rule) => rule.id).sort(),
    [...RULE_IDS].sort(),
  );

  for (const rule of rules) {
    const id = nonEmptyString(rule.id, "rule.id");
    assert.ok(
      SEVERITY_LEVELS.includes(rule.severity as typeof SEVERITY_LEVELS[number]),
      `${id}.severity must be medium or high`,
    );
    nonEmptyString(rule.public_summary, `${id}.public_summary`);

    assert.ok(
      Array.isArray(rule.required_evidence) &&
        rule.required_evidence.length > 0 &&
        rule.required_evidence.every((item) =>
          typeof item === "string" && item.trim().length > 0
        ),
      `${id}.required_evidence must contain concrete evidence requirements`,
    );

    const uncertainty = record(rule.uncertainty, `${id}.uncertainty`);
    assert.equal(uncertainty.missing_or_ambiguous_evidence, "low");
    assert.equal(uncertainty.conflicting_evidence, "medium");
  }

  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const promptEvidence = (ruleById.get("AUP-PROMPT-INJECTION")
    ?.required_evidence as string[]).join(" ");
  assert.match(promptEvidence, /account[^.\n]*(authored|configur)/i);
  assert.match(promptEvidence, /monitored[- ]source[^.\n]*not[^.\n]*(attribut|evidence)/i);
  const misinformationEvidence = (ruleById.get("AUP-MISINFORMATION")
    ?.required_evidence as string[]).join(" ");
  assert.match(misinformationEvidence, /account activity[^.\n]*generat/i);
  assert.match(misinformationEvidence, /distribut|amplif/i);
});

Deno.test("Terms publish the complete acceptable-use and review contract", async () => {
  const termsDocument = await source("frontend/src/routes/terms/+page.svelte");
  const terms = termsDocument.toLowerCase();

  assert.match(terms, /id=["']acceptable-use["']/);
  assert.match(terms, /acceptable-use-policy\.json/);
  assert.match(terms, /investigative[^.\n]*public-service|public-service[^.\n]*investigative/);
  assert.match(terms, /personal surveillance/);
  assert.match(terms, /unauthorized[^.\n]*(private content|private-content)[^.\n]*circumvent/);
  assert.match(terms, /stalking[^.\n]*harassment[^.\n]*doxxing/);
  assert.match(terms, /coercive[^.\n]*discriminatory[^.\n]*surveillance/);
  assert.match(terms, /coercive[^.\n]*employee monitoring/);
  assert.match(terms, /retaliation/);
  assert.match(terms, /prompt injection/);
  assert.match(terms, /rate-limit abuse|abuse rate limits/);
  assert.match(terms, /generate or amplify misinformation/);
  assert.match(
    terms,
    /publicly accessible personal profile[^.\n]*public-interest[^.\n]*not[^.\n]*violation/,
  );
  assert.match(terms, /private content[^.\n]*(prohibited|violation)/);
  assert.match(terms, /operator review/);
  assert.match(terms, /terminate[^.\n]*after review/);
  assert.match(terms, /logs[^.\n]*(appropriate and lawful|lawful and appropriate)/);
  assert.doesNotMatch(terms, /automatic[^.\n]*(pause|suspend|ban|terminat)/);

  const publishedRules = new Map(
    [...termsDocument.matchAll(
      /<li>\s*<strong>(AUP-[A-Z-]+)<\/strong>\s*(?:&mdash;|—|-)\s*([\s\S]*?)<\/li>/g,
    )].map(([, id, summary]) => [
      id,
      summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase(),
    ]),
  );
  const contract = record(JSON.parse(await source(POLICY_PATH)), "policy");
  const rules = contract.rules as Record<string, unknown>[];
  assert.deepEqual([...publishedRules.keys()].sort(), [...RULE_IDS].sort());
  for (const rule of rules) {
    const id = nonEmptyString(rule.id, "rule.id");
    assert.equal(
      publishedRules.get(id),
      nonEmptyString(rule.public_summary, `${id}.public_summary`).toLowerCase(),
      `${id} must mean the same thing in Terms and the machine contract`,
    );
  }
});

Deno.test("verified source-service constraints are linked from public policy surfaces", async () => {
  const authority = record(
    JSON.parse(await source("frontend/static/source-service-constraints.json")),
    "source constraints",
  );
  assert.equal(authority.schema_version, 1);
  assert.equal(authority.authority_url, "/source-service-constraints.json");
  const services = authority.services as Record<string, unknown>[];
  assert.deepEqual(services.map((service) => service.id).sort(), ["apify", "firecrawl"]);
  const officialSources = services.flatMap((service) =>
    service.official_sources as string[]
  );
  for (const expected of [
    "https://docs.apify.com/legal/general-terms-and-conditions",
    "https://docs.apify.com/legal/acceptable-use-policy",
    "https://docs.apify.com/legal/actor-terms-and-conditions",
    "https://www.firecrawl.dev/terms-of-service",
    "https://docs.firecrawl.dev/api-reference/endpoint/crawl-post",
  ]) {
    assert.ok(officialSources.includes(expected), `missing official source ${expected}`);
  }
  for (const path of [
    "frontend/src/routes/terms/+page.svelte",
    "frontend/src/routes/faq/+page.svelte",
    "frontend/static/faq.txt",
  ]) {
    assert.match(await source(path), /source-service-constraints\.json/);
  }
});

Deno.test("public FAQ surfaces state the anti-stalkerware boundary and link the policy", async (t) => {
  const surfaces = [
    ["web FAQ", "frontend/src/routes/faq/+page.svelte"],
    ["plain-text FAQ", "frontend/static/faq.txt"],
  ] as const;

  for (const [name, path] of surfaces) {
    await t.step(name, async () => {
      const document = (await source(path)).toLowerCase();
      assert.match(document, /public-service purpose/);
      assert.match(document, /personal surveillance/);
      assert.match(document, /stalking/);
      assert.match(document, /harassment/);
      assert.match(document, /coercive[^.\n]*employee monitoring/);
      assert.match(document, /retaliation/);
      assert.match(document, /terms#acceptable-use/);
    });
  }
});

Deno.test("UI, CLI, MCP, and public skill give matching Social Scout policy guidance", async (t) => {
  const surfaces = [
    ["Social Scout UI", "frontend/src/lib/components/news/SocialScoutView.svelte"],
    ["scout CLI", "cli/commands/scouts.ts"],
    ["MCP create_scout", "supabase/functions/mcp-server/rpc.ts"],
    ["public Scoutpost skill", "frontend/static/skills/scoutpost.md"],
  ] as const;

  for (const [name, path] of surfaces) {
    await t.step(name, async () => {
      const document = (await source(path)).toLowerCase();
      assert.match(document, /public[^.\n]*(profile|source)/);
      assert.match(document, /public-interest|public interest/);
      assert.match(document, /terms#acceptable-use/);
      if (name === "scout CLI" || name === "MCP create_scout") {
        assert.match(
          document,
          /https:\/\/(?:www\.)?scoutpost\.ai\/terms#acceptable-use/,
        );
      }
    });
  }
});

Deno.test("Terms avoid material privacy and retention promises the service does not meet", async () => {
  const terms = (await source("frontend/src/routes/terms/+page.svelte"))
    .toLowerCase();

  assert.doesNotMatch(
    terms,
    /full article content[^\n]*only extracted facts are kept/,
  );
  assert.doesNotMatch(terms, /user profile[^\n]*2 years of inactivity/);

  const processors = terms.split("<h2>third-party processors</h2>")[1] ?? "";
  assert.match(
    processors,
    /openrouter[\s\S]{0,400}(social post|post text|social content)/,
  );
});
