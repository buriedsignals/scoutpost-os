/**
 * Manual live Firecrawl /map benchmark for Page Scout listing-page discovery.
 *
 * This spends real Firecrawl credits. It does not write Supabase data and is
 * intentionally not CI-safe.
 *
 * Run:
 *   set -a; source .env; set +a
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-firecrawl-map.ts
 *
 * Optional:
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-firecrawl-map.ts --set municipal
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-firecrawl-map.ts --set media
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-firecrawl-map.ts --scenario arlesheim
 *   deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-firecrawl-map.ts --strict
 */

import {
  firecrawlMap,
  firecrawlScrape,
} from "../../supabase/functions/_shared/scrape_firecrawl.ts";
import {
  filterSubpageUrls,
  hasDeterministicListingSignal,
  isLikelyArticleUrl,
} from "../../supabase/functions/_shared/subpage-filter.ts";

type Mode = "scrape-filter" | "map-filter" | "map-search-filter";
type ScenarioSet = "municipal" | "media";

interface Scenario {
  name: string;
  set: ScenarioSet;
  url: string;
  search: string;
  expected: RegExp[];
  avoidTop?: RegExp[];
  country?: string;
  languages?: string[];
}

interface Row {
  scenario: string;
  mode: Mode;
  raw_links: number;
  candidates: number;
  expected_rank: number | null;
  expected_within_cap: boolean;
  bad_top_count: number;
  article_like_top_count: number;
  deterministic_listing: boolean;
  status: "pass" | "warn" | "fail";
  top_urls: string[];
  error?: string;
}

const DEFAULT_LIMIT = 25;
const SUBPAGE_FETCH_CAP = 10;

const SCENARIOS: Scenario[] = [
  {
    name: "arlesheim-aktuelles",
    set: "municipal",
    url: "https://www.arlesheim.ch/de/aktuelles/",
    search: "Saison Abo Badi",
    expected: [/Saison-Abo-fuer-unsere-Badi-zu-gewinnen\.php/i],
    avoidTop: [/\/(?:verwaltung|politik)\//i, /\/(?:ical|rss)\.php/i],
    country: "CH",
    languages: ["de-CH", "de"],
  },
  {
    name: "arlesheim-veranstaltungen",
    set: "municipal",
    url: "https://www.arlesheim.ch/de/veranstaltungen/",
    search: "Workshop Fruehlings Kranz Arlesheim Kreativ",
    expected: [
      /\/de\/veranstaltungen\/\d+_.*(?:workshop|kranz|arlesheim-kreativ)/i,
    ],
    avoidTop: [/\/(?:ical|rss)\.php/i, /\/(?:verwaltung|politik)\//i],
    country: "CH",
    languages: ["de-CH", "de"],
  },
  {
    name: "baselland-medienmitteilungen",
    set: "municipal",
    url:
      "https://www.baselland.ch/politik-und-behorden/regierungsrat/medienmitteilungen/",
    search: "Regierungsrat Medienmitteilungen Baselland",
    expected: [
      /\/politik-und-behorden\/regierungsrat\/medienmitteilungen\/[^/?#]+/i,
    ],
    avoidTop: [/\.(?:jpg|jpeg|png|gif|svg|css|js)(?:$|[?#])/i],
    country: "CH",
    languages: ["de-CH", "de"],
  },
  {
    name: "neunkirch-veranstaltungen",
    set: "municipal",
    url: "https://www.neunkirch.ch/freizeit/veranstaltungen.html/23",
    search: "Neunkirch Veranstaltungen Termine",
    expected: [/\/veranstaltungen\.html\/23\/event\//i],
    avoidTop: [
      /\b(?:myEvents|eventAction|ec_month|ec_day|ec_year)\b/i,
      /\.(?:jpg|jpeg|png|gif|svg|css|js)(?:$|[?#])/i,
    ],
    country: "CH",
    languages: ["de-CH", "de"],
  },
  {
    name: "bzbasel-arlesheim",
    set: "municipal",
    url: "https://www.bzbasel.ch/gemeinde/arlesheim-4144",
    search: "Arlesheim",
    expected: [/ld\.\d+/i],
    avoidTop: [/\/gemeinde\/arlesheim-4144\/?$/i],
    country: "CH",
    languages: ["de-CH", "de"],
  },
  {
    name: "media-ch-engadinerpost-home",
    set: "media",
    url: "https://www.engadinerpost.ch/",
    search: "Engadin local news",
    expected: [/\/news\/\d{4}\/\d{2}\/\d{2}\//i],
    avoidTop: [
      /\/(?:abo|archiv|login|registrieren|inserate|veranstaltungen)(?:\/|$)/i,
    ],
    country: "CH",
    languages: ["de-CH", "de", "rm"],
  },
  {
    name: "media-ch-engadinerpost-news",
    set: "media",
    url: "https://www.engadinerpost.ch/news",
    search: "Engadin local news",
    expected: [/\/news\/\d{4}\/\d{2}\/\d{2}\//i],
    avoidTop: [
      /\/(?:abo|archiv|login|registrieren|inserate|veranstaltungen)(?:\/|$)/i,
    ],
    country: "CH",
    languages: ["de-CH", "de", "rm"],
  },
  {
    name: "media-de-merkur-muenchen",
    set: "media",
    url: "https://www.merkur.de/lokales/muenchen/",
    search: "Muenchen lokale Nachrichten",
    expected: [/\/lokales\/muenchen\/.*\.(?:html|htm)$/i],
    avoidTop: [
      /\/(?:abo|anzeigen|kontakt|newsletter|tag|thema|suche)(?:\/|$)/i,
    ],
    country: "DE",
    languages: ["de-DE", "de"],
  },
  {
    name: "media-fr-ouest-france-rennes",
    set: "media",
    url: "https://www.ouest-france.fr/bretagne/rennes-35000/",
    search: "Rennes actualites locales",
    expected: [/\/bretagne\/rennes-35000\/.+-[a-f0-9-]{24,}/i],
    avoidTop: [
      /\/(?:abonnement|archives|connexion|newsletter|recherche|annonces)(?:\/|$)/i,
    ],
    country: "FR",
    languages: ["fr-FR", "fr"],
  },
  {
    name: "media-fr-la-voix-du-nord-lille",
    set: "media",
    url: "https://www.lavoixdunord.fr/region/lille-et-sa-metropole",
    search: "Lille actualites locales",
    expected: [/\/\d+\/article\/\d{4}-\d{2}-\d{2}\//i],
    avoidTop: [
      /\/(?:abonnement|connexion|newsletter|recherche|annonces)(?:\/|$)/i,
    ],
    country: "FR",
    languages: ["fr-FR", "fr"],
  },
  {
    name: "media-uk-manchester-evening-news",
    set: "media",
    url:
      "https://www.manchestereveningnews.co.uk/news/greater-manchester-news/",
    search: "Greater Manchester local news",
    expected: [/\/news\/greater-manchester-news\/.+-\d+$/i],
    avoidTop: [
      /\/(?:all-about|auth|login|newsletter|advertising|contact-us)(?:\/|$)/i,
    ],
    country: "GB",
    languages: ["en-GB", "en"],
  },
  {
    name: "media-uk-bristol-live",
    set: "media",
    url: "https://www.bristolpost.co.uk/news/bristol-news/",
    search: "Bristol local news",
    expected: [/\/news\/bristol-news\/.+-\d+$/i],
    avoidTop: [
      /\/(?:all-about|auth|login|newsletter|advertising|contact-us)(?:\/|$)/i,
    ],
    country: "GB",
    languages: ["en-GB", "en"],
  },
];

function valueAfter(flag: string): string | null {
  const index = Deno.args.indexOf(flag);
  if (index === -1) return null;
  const value = Deno.args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function selectedScenarios(): Scenario[] {
  const set = valueAfter("--set") as ScenarioSet | null;
  const scenario = valueAfter("--scenario")?.toLowerCase() ?? null;
  return SCENARIOS.filter((s) => {
    if (set && s.set !== set) return false;
    if (scenario && !s.name.toLowerCase().includes(scenario)) return false;
    return true;
  });
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function extractLinksFromHtml(html: string, pageUrl: string): string[] {
  const parsed = new URL(pageUrl);
  const pageHost = normalizeHost(parsed.hostname);
  const seen = new Set<string>();
  const urls: string[] = [];
  const regex =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const rawHref = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const href = normalizeHref(rawHref, parsed);
    if (!href) continue;
    try {
      const link = new URL(href);
      if (normalizeHost(link.hostname) !== pageHost) continue;
      link.hash = "";
      const clean = link.toString().replace(/\/+$/, "");
      if (clean === pageUrl.replace(/\/+$/, "")) continue;
      if (!seen.has(clean)) {
        seen.add(clean);
        urls.push(clean);
      }
    } catch {
      // Ignore malformed hrefs from scraped HTML.
    }
  }
  return urls;
}

function extractLinksFromMarkdown(markdown: string, pageUrl: string): string[] {
  const parsed = new URL(pageUrl);
  const pageHost = normalizeHost(parsed.hostname);
  const seen = new Set<string>();
  const urls: string[] = [];
  const regex = /\[[^\]]{0,240}\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const href = normalizeHref((match[1] ?? "").trim(), parsed);
    if (!href) continue;
    try {
      const link = new URL(href);
      if (normalizeHost(link.hostname) !== pageHost) continue;
      link.hash = "";
      const clean = link.toString().replace(/\/+$/, "");
      if (clean === pageUrl.replace(/\/+$/, "")) continue;
      if (!seen.has(clean)) {
        seen.add(clean);
        urls.push(clean);
      }
    } catch {
      // Ignore malformed links from scraped markdown.
    }
  }
  return urls;
}

function normalizeHref(rawHref: string, page: URL): string | null {
  if (
    !rawHref || rawHref.startsWith("#") || rawHref.startsWith("mailto:") ||
    rawHref.startsWith("javascript:")
  ) return null;
  if (rawHref.startsWith("/")) {
    return `${page.protocol}//${page.host}${rawHref}`;
  }
  if (rawHref.startsWith("http://") || rawHref.startsWith("https://")) {
    return rawHref;
  }
  return null;
}

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function expectedRank(urls: string[], expected: RegExp[]): number | null {
  const index = urls.findIndex((url) => expected.some((re) => re.test(url)));
  return index === -1 ? null : index + 1;
}

function countBadTop(urls: string[], avoidTop: RegExp[] = []): number {
  return urls.slice(0, SUBPAGE_FETCH_CAP)
    .filter((url) => avoidTop.some((re) => re.test(url))).length;
}

function summarize(
  scenario: Scenario,
  mode: Mode,
  rawLinks: string[],
): Row {
  const raw = dedupe(rawLinks);
  const candidates = filterSubpageUrls(raw, scenario.url);
  const rank = expectedRank(candidates, scenario.expected);
  const badTop = countBadTop(candidates, scenario.avoidTop);
  const withinCap = rank !== null && rank <= SUBPAGE_FETCH_CAP;
  const deterministic = hasDeterministicListingSignal(
    scenario.url,
    candidates,
  );
  const status: Row["status"] = withinCap && badTop === 0
    ? "pass"
    : rank !== null && badTop <= 1
    ? "warn"
    : "fail";
  return {
    scenario: scenario.name,
    mode,
    raw_links: raw.length,
    candidates: candidates.length,
    expected_rank: rank,
    expected_within_cap: withinCap,
    bad_top_count: badTop,
    article_like_top_count: candidates.slice(0, SUBPAGE_FETCH_CAP)
      .filter(isLikelyArticleUrl).length,
    deterministic_listing: deterministic,
    status,
    top_urls: candidates.slice(0, 5),
  };
}

async function scrapeLinks(scenario: Scenario): Promise<string[]> {
  const scrape = await firecrawlScrape(scenario.url, {
    formats: ["markdown", "rawHtml"],
    timeoutMs: 60_000,
    abortAfterMs: 70_000,
  });
  const htmlLinks = scrape.rawHtml?.trim()
    ? extractLinksFromHtml(scrape.rawHtml, scenario.url)
    : [];
  if (htmlLinks.length > 0) return htmlLinks;
  return extractLinksFromMarkdown(scrape.markdown, scenario.url);
}

async function benchmarkScenario(scenario: Scenario): Promise<Row[]> {
  const rows: Row[] = [];
  for (
    const mode of [
      "scrape-filter",
      "map-filter",
      "map-search-filter",
    ] as const
  ) {
    try {
      const links = mode === "scrape-filter"
        ? await scrapeLinks(scenario)
        : await firecrawlMap(scenario.url, {
          limit: DEFAULT_LIMIT,
          search: mode === "map-search-filter" ? scenario.search : undefined,
          sitemap: "skip",
          ignoreQueryParameters: true,
          country: scenario.country,
          languages: scenario.languages,
          timeoutMs: 60_000,
        });
      rows.push(summarize(scenario, mode, links));
    } catch (e) {
      rows.push({
        scenario: scenario.name,
        mode,
        raw_links: 0,
        candidates: 0,
        expected_rank: null,
        expected_within_cap: false,
        bad_top_count: 0,
        article_like_top_count: 0,
        deterministic_listing: false,
        status: "fail",
        top_urls: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows;
}

function printRows(rows: Row[]): void {
  console.log("# Firecrawl Map Benchmark");
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Subpage fetch cap: ${SUBPAGE_FETCH_CAP}`);
  console.log("");
  console.log(
    "| Scenario | Mode | Status | Raw Links | Candidates | Expected Rank | Bad Top | Article-like Top | Deterministic Listing |",
  );
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of rows) {
    console.log(
      `| ${row.scenario} | ${row.mode} | ${row.status} | ${row.raw_links} | ${row.candidates} | ${
        row.expected_rank ?? "-"
      } | ${row.bad_top_count} | ${row.article_like_top_count} | ${
        row.deterministic_listing ? "yes" : "no"
      } |`,
    );
  }
  console.log("");
  console.log("## Top URLs");
  for (const row of rows) {
    console.log(`### ${row.scenario} / ${row.mode} / ${row.status}`);
    if (row.error) console.log(`Error: ${row.error}`);
    for (const url of row.top_urls) console.log(`- ${url}`);
    if (row.top_urls.length === 0 && !row.error) console.log("- none");
    console.log("");
  }
}

if (!Deno.env.get("FIRECRAWL_API_KEY")) {
  throw new Error("Missing FIRECRAWL_API_KEY");
}

const scenarios = selectedScenarios();
if (scenarios.length === 0) {
  throw new Error("No scenarios matched --set/--scenario filters");
}

const rows: Row[] = [];
for (const scenario of scenarios) {
  rows.push(...await benchmarkScenario(scenario));
}
printRows(rows);

if (
  Deno.args.includes("--strict") && rows.some((row) => row.status === "fail")
) {
  Deno.exit(1);
}
