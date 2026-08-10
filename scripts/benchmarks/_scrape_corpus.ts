export interface ScrapeProbe {
  kind: "contains" | "min_chars";
  value: string;
  weight: number;
}

export interface ScrapeCorpusCase {
  id: string;
  url: string;
  probes: ScrapeProbe[];
}

// Maintained from tools/benchmarks cases/scraping.json and
// cases/scraping-scoutpost.json. The 2026-08-10 Vaud case replaces Lausanne,
// whose WAF made repeated same-load release checks nondeterministic.
export const SCRAPE_CORPUS_CASES: ScrapeCorpusCase[] = [
  {
    id: "companies_house_openai_results_scrape",
    url:
      "https://find-and-update.company-information.service.gov.uk/search/companies?q=OPENAI",
    probes: [
      { kind: "contains", value: "OPENAI UK LTD", weight: 2 },
      { kind: "contains", value: "14367667", weight: 2 },
      {
        kind: "contains",
        value: "Incorporated on 21 September 2022",
        weight: 1,
      },
      { kind: "contains", value: "50 Broadway", weight: 1 },
    ],
  },
  {
    id: "basel_grosser_rat_protocols",
    url: "https://grosserrat.bs.ch/ratsbetrieb/ratsprotokolle?all=1",
    probes: [
      { kind: "contains", value: "Grosser Rat", weight: 2 },
      { kind: "contains", value: "Ratsprotokolle", weight: 2 },
      { kind: "contains", value: "PDF", weight: 1 },
      { kind: "min_chars", value: "1000", weight: 1 },
    ],
  },
  {
    id: "zurich_gemeinderat_protocols",
    url: "https://www.gemeinderat-zuerich.ch/sitzungen/termine/",
    probes: [
      { kind: "contains", value: "Sitzungskalender", weight: 2 },
      { kind: "contains", value: "Traktanden", weight: 2 },
      { kind: "contains", value: "Protokoll", weight: 1 },
      { kind: "min_chars", value: "1000", weight: 1 },
    ],
  },
  {
    id: "vaud_grand_conseil_sessions",
    url: "https://www.vd.ch/gc/seances-du-grand-conseil",
    probes: [
      { kind: "contains", value: "Grand Conseil", weight: 2 },
      {
        kind: "contains",
        value: "Calendrier des séances du Grand Conseil",
        weight: 2,
      },
      { kind: "contains", value: "décisions et commentaires", weight: 1 },
      { kind: "min_chars", value: "1000", weight: 1 },
    ],
  },
  {
    id: "bern_stadtrat_sitzungen",
    url: "https://stadtrat.bern.ch/de/sitzungen/",
    probes: [
      { kind: "contains", value: "Unterlagen", weight: 2 },
      { kind: "contains", value: "Gremien", weight: 2 },
      { kind: "contains", value: "Finanzkommission", weight: 1 },
      { kind: "min_chars", value: "1000", weight: 1 },
    ],
  },
  {
    id: "bozeman_city_commission",
    url: "https://www.bozeman.net/departments/city-commission",
    probes: [
      { kind: "contains", value: "City Commission", weight: 2 },
      { kind: "contains", value: "Agenda", weight: 2 },
      { kind: "contains", value: "Commissioner", weight: 1 },
      { kind: "min_chars", value: "1000", weight: 1 },
    ],
  },
  {
    id: "madison_common_council",
    url: "https://www.cityofmadison.com/council",
    probes: [
      { kind: "contains", value: "Common Council", weight: 2 },
      { kind: "contains", value: "Alder", weight: 2 },
      { kind: "contains", value: "Meeting Schedule", weight: 1 },
      { kind: "min_chars", value: "1000", weight: 1 },
    ],
  },
  {
    id: "zermatt_gemeinde_home",
    url: "https://gemeinde.zermatt.ch",
    probes: [
      { kind: "contains", value: "Einwohner", weight: 2 },
      { kind: "contains", value: "Verwaltung", weight: 2 },
      { kind: "contains", value: "Gemeinderat", weight: 1 },
      { kind: "min_chars", value: "1000", weight: 1 },
    ],
  },
];

export function scoreScrapeProbes(
  markdown: string,
  probes: ScrapeProbe[],
): { matched: number; possible: number; missed: string[] } {
  const haystack = markdown.toLowerCase();
  let matched = 0;
  let possible = 0;
  const missed: string[] = [];
  for (const probe of probes) {
    possible += probe.weight;
    const hit = probe.kind === "contains"
      ? haystack.includes(probe.value.toLowerCase())
      : markdown.length >= parseInt(probe.value, 10);
    if (hit) matched += probe.weight;
    else missed.push(`${probe.kind}:${probe.value}`);
  }
  return { matched, possible, missed };
}
