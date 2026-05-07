/**
 * Offline Beat Scout retrieval benchmark.
 *
 * Deterministic, no network, no production writes. This benchmarks the
 * pre-scrape URL hygiene gates that protect Beat Scouts from ingesting weak
 * pages: sponsored packages, tag/category/listing pages, browser challenges,
 * homepages, and tourism/listing pollution.
 *
 * Run:
 *   deno run --allow-read scripts/benchmark-beat-offline.ts
 */

import {
  beatCandidateRejectReason,
  type BeatHit,
  filterUsableBeatCandidates,
  isAiJournalismCompoundMatch,
  isLikelyTourismContent,
} from "../supabase/functions/_shared/beat_pipeline.ts";
import { isCivicDirectDocumentUrl } from "../supabase/functions/_shared/civic_links.ts";

type ScenarioId =
  | "ai-journalism-global"
  | "sweden-energy-country-topic"
  | "pontresina-police-sparse-village"
  | "engadin-domain-priority"
  | "local-niche-anti-tourism"
  | "bad-ingestion-rejection";

interface Scenario {
  id: ScenarioId;
  label: string;
  candidates: BeatHit[];
  priorityDomains?: string[];
  tourismSensitive?: boolean;
  compoundTopic?: "ai_journalism";
  locality?: {
    placeTerms: string[];
    topicTerms: string[];
  };
}

interface Metrics {
  selected_url_count: number;
  rejected_url_count: number;
  locality_rejected_count: number;
  priority_domain_url_count: number;
  homepage_url_count: number;
  sponsored_page_count: number;
  tag_page_count: number;
  blocked_page_count: number;
  social_platform_count: number;
  tourism_page_count: number;
  tourism_rejected_count: number;
  compound_topic_selected_count: number;
  generic_ai_only_selected_count: number;
}

interface TargetCheck {
  scenario: ScenarioId;
  target: string;
  pass: boolean;
  observed: string;
}

function hit(
  url: string,
  title = "Story",
  description = "",
  date: string | null = "2026-05-01",
): BeatHit {
  return {
    url,
    title,
    description,
    date,
    _pass: "news",
  };
}

const scenarios: Scenario[] = [
  {
    id: "ai-journalism-global",
    label: "AI Journalism Global",
    candidates: [
      hit("https://sponsored.bloomberg.com/arm/ai", "Sponsored AI package"),
      hit("https://techcrunch.com/tag/artificial-intelligence/"),
      hit(
        "https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1",
      ),
      hit(
        "https://reutersinstitute.politics.ox.ac.uk/ai-adoption-uk-journalists-and-their-newsrooms-surveying-applications-approaches-and-attitudes",
        "AI adoption by UK journalists and their newsrooms",
      ),
      hit(
        "https://www.journalism.cuny.edu/2026/01/meet-the-24-practitioners-selected-for-the-ai-journalism-lab-builders-cohort-in-partnership-with-nordic-ai/",
        "Meet the 24 Practitioners Selected for AI J Lab: Builders",
      ),
      hit(
        "https://www.niemanlab.org/2025/12/the-ai-winners-wont-be-the-biggest-newsrooms/",
        "The AI winners will not be the biggest newsrooms",
      ),
      hit(
        "https://www.reuters.com/technology/two-fed-officials-dont-see-major-upheavel-artificial-intelligence-2026-02-24/",
        "Two Fed officials do not see major upheavel from artificial intelligence",
      ),
      hit(
        "https://www.wsj.com/tech/ai",
        "Artificial Intelligence - Latest AI News and Analysis - WSJ.com",
      ),
      hit(
        "https://cloud.google.com/transform/101-real-world-generative-ai-use-cases-from-industry-leaders",
        "Real-world gen AI use cases from leading organizations",
      ),
      hit(
        "https://www.facebook.com/inma.newsmedia/posts/how-is-the-ai-era-impacting-news-media-companies",
        "How is the AI era impacting news media companies",
      ),
      hit(
        "https://www.youtube.com/watch?v=WR9VHZrBQYg",
        "What's Working? News Media Help Desk",
      ),
    ],
    compoundTopic: "ai_journalism",
  },
  {
    id: "sweden-energy-country-topic",
    label: "Sweden Energy Country Topic",
    locality: {
      placeTerms: ["sweden", "swedish", "sverige", "svensk"],
      topicTerms: [
        "energy",
        "energi",
        "grid",
        "elnat",
        "elnät",
        "wind",
        "vindkraft",
        "solar",
        "electricity",
      ],
    },
    candidates: [
      hit(
        "https://www.reuters.com/business/energy/sweden-grid-investment-2026-05-01/",
        "Sweden announces new grid investment package",
      ),
      hit(
        "https://www.energinyheter.se/20260501/sverige-satsar-pa-vindkraft",
        "Sverige satsar pa ny vindkraft och elnat",
      ),
      hit(
        "https://energy.example.com/denmark-offshore-wind",
        "Denmark approves offshore wind expansion",
      ),
      hit(
        "https://www.visitstockholm.com/energy-efficient-hotels",
        "Energy efficient hotels in Stockholm",
      ),
    ],
  },
  {
    id: "pontresina-police-sparse-village",
    label: "Pontresina Police Sparse Village",
    locality: {
      placeTerms: ["pontresina"],
      topicTerms: ["police", "polizei", "polizia"],
    },
    tourismSensitive: true,
    candidates: [
      hit(
        "https://www.gr.ch/DE/institutionen/verwaltung/djsg/kapo/aktuelles/medienmitteilungen/chur-unfall",
        "Kantonspolizei meldet Unfall in Chur",
      ),
      hit(
        "https://www.pontresina.ch/en/hotels",
        "Best hotels in Pontresina",
      ),
      hit(
        "https://www.engadinerpost.ch/2026/05/01/pontresina-gemeindeversammlung",
        "Pontresina Gemeindeversammlung genehmigt Budget",
      ),
    ],
  },
  {
    id: "engadin-domain-priority",
    label: "Engadin Domain Priority",
    priorityDomains: [
      "engadinerpost.ch",
      "engadin.online",
      "suedostschweiz.ch",
      "gr.ch",
    ],
    candidates: [
      hit("https://www.engadinerpost.ch/"),
      hit("https://www.engadinerpost.ch/news"),
      hit("https://www.engadinerpost.ch/news/kategorie/lapunt"),
      hit("https://info.engadin.online/news/seite/2"),
      hit(
        "https://www.suedostschweiz.ch/politik/2026-05-01/wohnraum-im-engadin",
        "Wohnraum im Engadin bleibt politisches Thema",
      ),
      hit(
        "https://www.engadinerpost.ch/2026/05/01/gemeinde-prueft-neuen-wohnraum",
        "Gemeinde prueft neuen Wohnraum",
      ),
      hit(
        "https://www.gr.ch/DE/institutionen/verwaltung/dvs/awt/dokumente/bericht.pdf",
        "Bericht zur regionalen Entwicklung",
      ),
    ],
  },
  {
    id: "local-niche-anti-tourism",
    label: "Local Niche Anti-Tourism",
    tourismSensitive: true,
    candidates: [
      hit(
        "https://www.engadin.com/en/hotels",
        "Best places to stay in the Engadin",
      ),
      hit(
        "https://travel.example/engadin-guide",
        "Travel guide: top attractions in the Engadin",
      ),
      hit(
        "https://www.engadinerpost.ch/news/2026/05/01/gemeinde-prueft-wohnraum",
        "Gemeinde prueft neuen Wohnraum",
      ),
    ],
  },
  {
    id: "bad-ingestion-rejection",
    label: "Bad Ingestion Rejection",
    tourismSensitive: true,
    candidates: [
      hit("https://www.example-news.com/"),
      hit("https://www.example-news.com/news"),
      hit("https://www.example-news.com/tag/police"),
      hit("https://sponsored.example.com/campaign/local-ai"),
      hit("https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate"),
      hit(
        "https://travel.example/pontresina-guide",
        "Travel guide: top attractions in Pontresina",
      ),
    ],
  },
];

function normalizeDomain(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.toLowerCase().replace(/^www\./, "");
  }
}

function urlMatchesDomain(rawUrl: string, domain: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    const expected = normalizeDomain(domain);
    return host === expected || host.endsWith("." + expected);
  } catch {
    return false;
  }
}

function countSelectedByReason(
  selected: BeatHit[],
  reason: ReturnType<typeof beatCandidateRejectReason>,
): number {
  return selected.filter((candidate) =>
    beatCandidateRejectReason(candidate) === reason
  ).length;
}

function normalized(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function candidateText(candidate: BeatHit): string {
  return normalized(
    [candidate.title, candidate.description, candidate.url].filter(Boolean)
      .join(" "),
  );
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(normalized(needle)));
}

function matchesLocality(candidate: BeatHit, scenario: Scenario): boolean {
  if (!scenario.locality) return true;
  const haystack = candidateText(candidate);
  return includesAny(haystack, scenario.locality.placeTerms) &&
    includesAny(haystack, scenario.locality.topicTerms);
}

function metricsFor(scenario: Scenario): Metrics {
  const urlHygieneSelected = filterUsableBeatCandidates(scenario.candidates);
  const compoundSelected = scenario.compoundTopic === "ai_journalism"
    ? urlHygieneSelected.filter((candidate) =>
      isAiJournalismCompoundMatch(candidate)
    )
    : urlHygieneSelected;
  const tourismRejected = scenario.tourismSensitive
    ? compoundSelected.filter((candidate) => isLikelyTourismContent(candidate))
      .length
    : 0;
  const selectedBeforeLocality = scenario.tourismSensitive
    ? compoundSelected.filter((candidate) => !isLikelyTourismContent(candidate))
    : compoundSelected;
  const localityRejected =
    selectedBeforeLocality.filter((candidate) =>
      !matchesLocality(candidate, scenario)
    ).length;
  const selected = selectedBeforeLocality.filter((candidate) =>
    matchesLocality(candidate, scenario)
  );
  const rejected = scenario.candidates.length - selected.length;
  const priorityDomains = scenario.priorityDomains ?? [];

  return {
    selected_url_count: selected.length,
    rejected_url_count: rejected,
    locality_rejected_count: localityRejected,
    priority_domain_url_count:
      selected.filter((candidate) =>
        priorityDomains.some((domain) =>
          urlMatchesDomain(candidate.url, domain)
        )
      ).length,
    homepage_url_count: countSelectedByReason(selected, "homepage"),
    sponsored_page_count: countSelectedByReason(selected, "sponsored"),
    tag_page_count: countSelectedByReason(selected, "listing_page"),
    blocked_page_count: countSelectedByReason(selected, "browser_challenge"),
    social_platform_count: countSelectedByReason(selected, "social_platform"),
    tourism_page_count: scenario.tourismSensitive
      ? selected.filter((candidate) => isLikelyTourismContent(candidate)).length
      : 0,
    tourism_rejected_count: tourismRejected,
    compound_topic_selected_count: scenario.compoundTopic === "ai_journalism"
      ? selected.filter((candidate) => isAiJournalismCompoundMatch(candidate))
        .length
      : 0,
    generic_ai_only_selected_count: scenario.compoundTopic === "ai_journalism"
      ? selected.filter((candidate) => !isAiJournalismCompoundMatch(candidate))
        .length
      : 0,
  };
}

function buildTargets(results: Map<ScenarioId, Metrics>): TargetCheck[] {
  const ai = results.get("ai-journalism-global")!;
  const swedenEnergy = results.get("sweden-energy-country-topic")!;
  const pontresinaPolice = results.get("pontresina-police-sparse-village")!;
  const engadin = results.get("engadin-domain-priority")!;
  const tourism = results.get("local-niche-anti-tourism")!;
  const badIngestion = results.get("bad-ingestion-rejection")!;

  return [
    {
      scenario: "ai-journalism-global",
      target: "selected_url_count >= 3",
      pass: ai.selected_url_count >= 3,
      observed: String(ai.selected_url_count),
    },
    {
      scenario: "ai-journalism-global",
      target: "generic_ai_only_selected_count == 0",
      pass: ai.generic_ai_only_selected_count === 0,
      observed: String(ai.generic_ai_only_selected_count),
    },
    {
      scenario: "ai-journalism-global",
      target: "selected sponsored/tag/challenge pages == 0",
      pass: ai.sponsored_page_count === 0 &&
        ai.tag_page_count === 0 &&
        ai.blocked_page_count === 0 &&
        ai.social_platform_count === 0,
      observed:
        `sponsored=${ai.sponsored_page_count}, tag=${ai.tag_page_count}, blocked=${ai.blocked_page_count}, social=${ai.social_platform_count}`,
    },
    {
      scenario: "sweden-energy-country-topic",
      target: "country topic keeps at least 2 Sweden energy candidates",
      pass: swedenEnergy.selected_url_count >= 2,
      observed: String(swedenEnergy.selected_url_count),
    },
    {
      scenario: "sweden-energy-country-topic",
      target: "country topic rejects wrong-country/listing noise",
      pass: swedenEnergy.locality_rejected_count >= 2,
      observed:
        `locality=${swedenEnergy.locality_rejected_count}, tourism=${swedenEnergy.tourism_rejected_count}`,
    },
    {
      scenario: "pontresina-police-sparse-village",
      target: "sparse village topic may correctly select zero",
      pass: pontresinaPolice.selected_url_count === 0,
      observed: String(pontresinaPolice.selected_url_count),
    },
    {
      scenario: "pontresina-police-sparse-village",
      target: "sparse village zero is auditable via rejections",
      pass: pontresinaPolice.rejected_url_count >= 3,
      observed: String(pontresinaPolice.rejected_url_count),
    },
    {
      scenario: "engadin-domain-priority",
      target: "priority_domain_url_count >= 2",
      pass: engadin.priority_domain_url_count >= 2,
      observed: String(engadin.priority_domain_url_count),
    },
    {
      scenario: "engadin-domain-priority",
      target: "selected homepage/listing pages == 0",
      pass: engadin.homepage_url_count === 0 && engadin.tag_page_count === 0,
      observed:
        `homepage=${engadin.homepage_url_count}, listing=${engadin.tag_page_count}`,
    },
    {
      scenario: "local-niche-anti-tourism",
      target: "selected tourism pages == 0",
      pass: tourism.tourism_page_count === 0,
      observed: String(tourism.tourism_page_count),
    },
    {
      scenario: "local-niche-anti-tourism",
      target: "selected_url_count >= 1",
      pass: tourism.selected_url_count >= 1,
      observed: String(tourism.selected_url_count),
    },
    {
      scenario: "bad-ingestion-rejection",
      target: "bad ingestion selected_url_count == 0",
      pass: badIngestion.selected_url_count === 0,
      observed: String(badIngestion.selected_url_count),
    },
  ];
}

const results = new Map<ScenarioId, Metrics>();
for (const scenario of scenarios) {
  results.set(scenario.id, metricsFor(scenario));
}
const targets = buildTargets(results);
const failed = targets.filter((target) => !target.pass);
const civicPdfCases = [
  {
    country: "US",
    url: "https://www.cityofmadison.com/council/documents/meeting-minutes.pdf",
    expectedDirectPdf: true,
  },
  {
    country: "DE",
    url:
      "https://www.berlin.de/ba-mitte/politik-und-verwaltung/bezirksverordnetenversammlung/protokoll.pdf",
    expectedDirectPdf: true,
  },
  {
    country: "FR",
    url: "https://www.paris.fr/documents/proces-verbal-conseil-municipal.pdf",
    expectedDirectPdf: true,
  },
  {
    country: "CH",
    url:
      "https://www.gemeinde-pontresina.ch/fileadmin/user_upload/protokoll.pdf",
    expectedDirectPdf: true,
  },
  {
    country: "CH",
    url: "https://www.gemeinde-pontresina.ch/politik/gemeinderat",
    expectedDirectPdf: false,
  },
];
const civicPdfFailures = civicPdfCases.filter((entry) =>
  isCivicDirectDocumentUrl(entry.url) !== entry.expectedDirectPdf
);

console.log("# Beat Scout Offline Benchmark");
console.log(`Generated: ${new Date().toISOString()}`);
console.log("");
console.log(
  "| Scenario | Selected | Compound Selected | Generic AI Selected | Rejected | Locality Rejected | Priority URLs | Homepage | Sponsored | Listing/Tag | Blocked | Social | Tourism Selected | Tourism Rejected |",
);
console.log(
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
);
for (const scenario of scenarios) {
  const m = results.get(scenario.id)!;
  console.log(
    `| ${scenario.label} | ${m.selected_url_count} | ${m.compound_topic_selected_count} | ${m.generic_ai_only_selected_count} | ${m.rejected_url_count} | ${m.locality_rejected_count} | ${m.priority_domain_url_count} | ${m.homepage_url_count} | ${m.sponsored_page_count} | ${m.tag_page_count} | ${m.blocked_page_count} | ${m.social_platform_count} | ${m.tourism_page_count} | ${m.tourism_rejected_count} |`,
  );
}

console.log("");
console.log("## Civic Direct PDF Check");
console.log(
  `- Direct civic PDF matrix passed: ${
    civicPdfCases.length - civicPdfFailures.length
  }/${civicPdfCases.length}`,
);
for (const entry of civicPdfCases) {
  console.log(
    `- ${entry.country}: ${
      isCivicDirectDocumentUrl(entry.url) ? "direct-pdf" : "not-direct-pdf"
    } ${entry.url}`,
  );
}
console.log(
  "- Scope: Civic Scout only. Beat/Page/Social scouts do not enter the civic PDF extraction queue.",
);

console.log("");
console.log("## Target Checks");
for (const target of targets) {
  console.log(
    `- ${
      target.pass ? "PASS" : "FAIL"
    } ${target.scenario}: ${target.target} (${target.observed})`,
  );
}

console.log("");
console.log("## Coverage Gaps");
console.log(
  "- Does not call live search, Firecrawl scrape, Gemini filtering, or Gemini extraction.",
);
console.log(
  "- Does not yet score extraction fixtures for Broad OR Criteria or Hard Constraint Criteria.",
);
console.log(
  "- Use this as the deterministic retrieval hygiene baseline; pair with the existing live benchmark before release.",
);

if (failed.length > 0 || civicPdfFailures.length > 0) {
  Deno.exit(1);
}
