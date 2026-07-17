import { scrape } from "./scrape.ts";
import { openRouterExtract } from "./openrouter.ts";

export const CIVIC_DENYLIST_EXTENSIONS = [
  ".css",
  ".js",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".mp3",
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".map",
] as const;

export const CIVIC_DENYLIST_PREFIXES = [
  "mailto:",
  "javascript:",
  "tel:",
  "#",
] as const;

export const CIVIC_MEETING_KEYWORDS: readonly string[] = [
  "full minutes",
  "full protocol",
  "protokoll",
  "vollprotokoll",
  "wortprotokoll",
  "beschlussprotokoll",
  "tagesordnung",
  "geschaeftsverzeichnis",
  "sitzung",
  "niederschrift",
  "verhandlung",
  "ratssitzung",
  "gemeinderat",
  "proces-verbal",
  "procès-verbal",
  "ordre-du-jour",
  "délibération",
  "compte-rendu",
  "compte rendu",
  "séance",
  "seance",
  "minutes",
  "agenda",
  "proceedings",
  "transcript",
  "transcription",
  "meeting",
  "decision",
  "resolution",
  "motion",
  "verbale",
  "ordine-del-giorno",
  "delibera",
  "seduta",
  "acta",
  "orden del día",
  "orden-del-dia",
  "sesión",
  "sesion",
  "pleno",
  "deliberación",
  "ata",
  "ordem do dia",
  "deliberação",
  "sessão",
  "notulen",
  "vergadering",
  "raadsvergadering",
  "besluitenlijst",
  "protokół",
  "protokol",
  "porządek obrad",
  "sesja",
  "protocol",
  "session",
] as const;

const CIVIC_DOCUMENT_CLASS_TERMS = {
  record: [
    "full minutes",
    "full protocol",
    "vollprotokoll",
    "wortprotokoll",
    "minutes",
    "transcript",
    "transcription",
    "proceedings",
    "compte rendu",
    "compte-rendu",
    "proces verbal",
    "proces-verbal",
    "notulen",
    "verbale",
    "acta",
    "niederschrift",
    "protokoll",
    "protocol",
  ],
  decision: [
    "beschlussprotokoll",
    "resolution",
    "decision",
    "deliberation",
    "deliberacion",
    "deliberacao",
    "delibera",
    "besluitenlijst",
  ],
  agenda: [
    "agenda",
    "tagesordnung",
    "ordre du jour",
    "ordre-du-jour",
    "orden del dia",
    "orden-del-dia",
    "ordem do dia",
    "ordine del giorno",
    "ordine-del-giorno",
    "geschaeftsverzeichnis",
    "geschaftsverzeichnis",
    "business register",
    "order of business",
    "porzadek obrad",
  ],
} as const;

export interface CivicLink {
  url: string;
  anchorText: string;
}

export interface CivicTrackedPage {
  pageUrl: string;
  rawHtml?: string | null;
}

export interface CivicDiscoveryCandidate {
  url: string;
  description: string;
  confidence: number;
}

const MEETING_URL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    meeting_urls: {
      type: "array",
      items: { type: "integer" },
    },
  },
  required: ["meeting_urls"],
};

export function extractCivicLinksFromHtml(
  html: string,
  pageUrl: string,
): CivicLink[] {
  if (!html.trim()) return [];
  const allLinks: CivicLink[] = [];
  const seenUrls = new Set<string>();
  const pageParsed = new URL(pageUrl);
  const pageDomain = pageParsed.hostname.toLowerCase();
  const pageNoFragment = pageUrl.split("#")[0].replace(/\/+$/, "");
  const rawLinks = html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gims);

  for (const match of rawLinks) {
    const rawHref = (match[1] ?? "").trim();
    const rawAnchor = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
    if (!rawHref) continue;
    if (CIVIC_DENYLIST_PREFIXES.some((prefix) => rawHref.startsWith(prefix))) {
      continue;
    }
    if (hasDeniedCivicAssetExtension(rawHref)) continue;

    let absolute: URL;
    try {
      absolute = new URL(rawHref, pageUrl);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(absolute.protocol)) continue;
    if (absolute.hostname.toLowerCase() !== pageDomain) continue;

    const hrefNoFragment = absolute.toString().split("#")[0].replace(
      /\/+$/,
      "",
    );
    if (hrefNoFragment === pageNoFragment) continue;
    if (seenUrls.has(hrefNoFragment)) continue;
    seenUrls.add(hrefNoFragment);
    allLinks.push({ url: hrefNoFragment, anchorText: rawAnchor });
  }

  return allLinks;
}

export function extractCivicLinksFromPages(
  pages: CivicTrackedPage[],
): CivicLink[] {
  const merged: CivicLink[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const rawHtml = page.rawHtml ?? "";
    if (!rawHtml.trim()) continue;
    const links = extractCivicLinksFromHtml(rawHtml, page.pageUrl);
    for (const link of links) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      merged.push(link);
    }
  }
  return merged;
}

export async function discoverCivicDocumentsFromTrackedPages(
  trackedUrls: string[],
  opts: { maxDocs?: number } = {},
): Promise<{ documentUrls: string[]; scrapedPages: number }> {
  const pages: CivicTrackedPage[] = [];
  let scrapedPages = 0;
  for (const trackedUrl of trackedUrls) {
    if (!isCivicScrapableUrl(trackedUrl)) continue;
    try {
      // Use the scrape() port, not firecrawlScrape directly: civic listing
      // pages are frequently JS-rendered (Zurich's Gemeinderat calendar builds
      // its per-meeting `index.php?gid=<N>` links client-side). A raw Firecrawl
      // fetch returns the pre-JS shell with zero meeting links → preview
      // resolves zero documents; crawl4ai's headless browser renders them.
      // production civic-execute already routes through the port — preview was
      // the last firecrawl-direct holdout (#233).
      const scraped = await scrape(trackedUrl, {
        formats: ["rawHtml"],
        onlyMainContent: false,
      });
      pages.push({
        pageUrl: trackedUrl,
        rawHtml: scraped.rawHtml ?? "",
      });
      if ((scraped.rawHtml ?? "").trim()) scrapedPages += 1;
    } catch {
      continue;
    }
  }

  const links = extractCivicLinksFromPages(pages);
  const documentUrls = await classifyCivicMeetingUrls(links);
  const maxDocs = Math.max(1, opts.maxDocs ?? 5);
  return {
    documentUrls: documentUrls.slice(0, maxDocs),
    scrapedPages,
  };
}

export async function classifyCivicMeetingUrls(
  links: CivicLink[],
): Promise<string[]> {
  const scrapableLinks = links.filter((link) => isCivicScrapableUrl(link.url));
  if (scrapableLinks.length === 0) return [];

  const keywordMatches = scrapableLinks.filter((link) =>
    hasMeetingKeyword(civicMatchText(link))
  );

  if (keywordMatches.length > 0) {
    const documentLinks = keywordMatches.filter((link) =>
      isPdfUrl(link.url) || urlPathDepth(link.url) > 2
    );
    return documentLinks.sort(compareCivicLinks).map((link) => link.url);
  }

  const numbered = scrapableLinks.slice(0, 2000).map((link, index) => {
    const parsed = new URL(link.url);
    const displayPath = parsed.search
      ? `${parsed.pathname}${parsed.search}`
      : parsed.pathname;
    const anchorDisplay = link.anchorText ? ` — ${link.anchorText}` : "";
    return `${index}. ${displayPath}${anchorDisplay}`;
  }).join("\n");
  const baseDomain = new URL(scrapableLinks[0].url).hostname;
  const prompt =
    "You are a civic data assistant. Below is a numbered list of links " +
    `from the website ${baseDomain}. Each line shows: index, URL path, and anchor text.\n\n` +
    "Identify which links point to meeting minutes, council protocols, agendas, or official proceedings documents.\n\n" +
    "Return ONLY a JSON object with a 'meeting_urls' key containing an array of integer indices.\n" +
    'Example: {"meeting_urls": [0, 3, 7]}\n' +
    'If none are meeting documents, return: {"meeting_urls": []}\n\n' +
    `Links:\n${numbered}`;

  try {
    const extraction = await openRouterExtract<{ meeting_urls: number[] }>(
      prompt,
      MEETING_URL_SCHEMA,
    );
    const seen = new Set<number>();
    const classified =
      (Array.isArray(extraction.meeting_urls) ? extraction.meeting_urls : [])
        .filter((idx): idx is number =>
          Number.isInteger(idx) && idx >= 0 && idx < scrapableLinks.length
        )
        .filter((idx) => {
          if (seen.has(idx)) return false;
          seen.add(idx);
          return true;
        })
        .map((idx) => scrapableLinks[idx])
        .sort(compareCivicLinks);
    return classified.map((link) => link.url);
  } catch {
    return [];
  }
}

/**
 * True for a URL whose query string is present but has ONLY empty-valued
 * params — a template/detail stub, not a real listing. Zurich's council site
 * exposes `.../sitzung/index.php?gid=` (an individual-meeting template needing
 * a real `gid=<N>`); with the param empty the page holds no documents, so
 * civic preview resolves zero and the scout is functionless (root cause of
 * the 2026-07-06 civic benchmark failure, #233). Populated params — `?all=1`,
 * `?page=1`, `?gid=42` — are kept; only fully-empty query strings are stubs.
 */
export function isEmptyQueryStubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const params = [...parsed.searchParams];
    return params.length > 0 &&
      params.every(([, value]) => value.trim() === "");
  } catch {
    return false;
  }
}

// Query params that select a SINGLE record (one meeting), making the URL a
// leaf detail page rather than a listing. Deliberately explicit, not
// "ends-with-id", so navigation params like `navid` (which point at a listing
// view) are NOT caught.
const CIVIC_RECORD_ID_PARAMS = new Set([
  "id",
  "gid",
  "sid",
  "oid",
  "uid",
  "docid",
  "recordid",
  "objectid",
  "entryid",
  "meetingid",
  "itemid",
  "aid",
]);

/**
 * True for an individual-record DETAIL page — a URL carrying a populated
 * record-id param (`index.php?gid=<hash>`). Such a page is a single meeting: a
 * static leaf that never gains new content, so it is useless as the *tracked*
 * URL of a civic scout, and civic preview finds no further documents inside
 * it. Zurich's Gemeinderat ranked these leaves above its `/sitzungen/termine/`
 * calendar (#233). They are excluded from DISCOVERY candidates only — they are
 * still extracted as documents when preview scrapes the listing.
 */
export function isCivicRecordDetailUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    for (const [name, value] of parsed.searchParams) {
      if (
        CIVIC_RECORD_ID_PARAMS.has(name.toLowerCase()) && value.trim() !== ""
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function filterCivicDiscoveryCandidates<T extends { url: string }>(
  candidates: T[],
): T[] {
  return candidates.filter((candidate) => {
    try {
      const parsed = new URL(candidate.url);
      const path = parsed.pathname.toLowerCase();
      if (hasDeniedCivicAssetExtension(candidate.url)) return false;
      if (path.endsWith(".pdf")) return false;
      if (path.startsWith("/pdf/")) return false;
      // Reject empty-query template stubs regardless of how they were
      // surfaced (deterministic ranker or OpenRouter ranking merged in).
      if (isEmptyQueryStubUrl(candidate.url)) return false;
      if (isCivicRecordDetailUrl(candidate.url)) return false;
      return true;
    } catch {
      return false;
    }
  });
}

export function rankCivicDiscoveryUrls(
  urls: string[],
  opts: { maxCandidates?: number } = {},
): CivicDiscoveryCandidate[] {
  const maxCandidates = Math.max(1, opts.maxCandidates ?? 5);
  const seen = new Set<string>();
  const scored: Array<CivicDiscoveryCandidate & { score: number }> = [];

  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }

    const normalizedUrl = parsed.toString().split("#")[0].replace(/\/+$/, "");
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);

    const path = parsed.pathname.toLowerCase();
    if (!isCivicScrapableUrl(normalizedUrl)) continue;
    if (path.endsWith(".pdf")) continue;
    if (path.startsWith("/pdf/")) continue;
    // Skip empty-query template stubs (e.g. `index.php?gid=`) — they preview
    // to zero documents and must never be selected as the listing candidate.
    if (isEmptyQueryStubUrl(normalizedUrl)) continue;
    // Skip single-record leaf detail pages (e.g. `index.php?gid=<hash>`): they
    // are static individual meetings, not a trackable listing. Still found as
    // documents when preview scrapes the chosen listing.
    if (isCivicRecordDetailUrl(normalizedUrl)) continue;

    const matchText = normalizeCivicText(`${parsed.pathname} ${parsed.search}`);
    const hasMeetingTerms = hasMeetingKeyword(matchText);
    const governmentContext = hasAnyTerm(matchText, [
      "gemeinderat",
      "urversammlung",
      "stadtrat",
      "conseil communal",
      "city council",
      "common council",
      "commission",
      "rat",
      "politik",
      "sitzungen",
      "seances",
      "meetings",
    ]);
    const archiveContext = hasAnyTerm(matchText, [
      "archiv",
      "archive",
      "protokolle",
      "protocols",
      "minutes",
      "pv",
    ]);

    if (!hasMeetingTerms && !governmentContext && !archiveContext) continue;

    const depth = parsed.pathname.split("/").filter(Boolean).length;
    const documentClass = civicDocumentClassPriority(matchText);
    const score = (hasMeetingTerms ? 0.62 : 0) +
      (documentClass > 1 ? documentClass * 0.08 : 0) +
      (governmentContext ? 0.22 : 0) +
      (archiveContext ? 0.1 : 0) +
      (depth > 0 && depth <= 3 ? 0.05 : 0) +
      (parsed.search ? 0.01 : 0);

    scored.push({
      url: normalizedUrl,
      description:
        "Likely civic listing page with meeting or decision documents.",
      confidence: Math.min(0.95, Math.max(0.55, Number(score.toFixed(2)))),
      score,
    });
  }

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.url.localeCompare(b.url);
    })
    .slice(0, maxCandidates)
    .map(({ score: _score, ...candidate }) => candidate);
}

function hasMeetingKeyword(text: string): boolean {
  return CIVIC_MEETING_KEYWORDS.some((keyword) =>
    text.includes(normalizeCivicText(keyword))
  );
}

function civicMatchText(link: CivicLink): string {
  return normalizeCivicText(`${link.url} ${link.anchorText}`);
}

function normalizeCivicText(text: string): string {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // Keep the original text if a URL contains malformed percent escapes.
  }
  return decoded
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * CMS utility/export endpoints that are not civic documents: content-management
 * export scripts and internal module routes (Zurich's Axioma CMS exposes
 * `/format/module/.../sitzungen_exports.php`). They carry no meeting text, and
 * the headless browser errors on them (observed 2026-07-06: crawl4ai 502
 * "Unexpected error in _crawl_web"). Queuing one wastes a MAX_DOCS_PER_RUN slot
 * and burns the retry budget, starving real meeting pages (#233).
 */
function isCivicUtilityEndpoint(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.includes("/format/module/") ||
      path.includes("/module/") && path.endsWith(".php") ||
      /_exports?\.php$/.test(path) ||
      path.endsWith("/export.php");
  } catch {
    return false;
  }
}

export function isCivicScrapableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (isCivicUtilityEndpoint(url)) return false;
    return !hasDeniedCivicAssetExtension(url);
  } catch {
    return false;
  }
}

export function isCivicDirectDocumentUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function hasDeniedCivicAssetExtension(urlOrHref: string): boolean {
  const withoutQuery = urlOrHref.split(/[?#]/)[0].toLowerCase();
  return CIVIC_DENYLIST_EXTENSIONS.some((ext) => withoutQuery.endsWith(ext));
}

function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return url.split(/[?#]/)[0].toLowerCase().endsWith(".pdf");
  }
}

function urlPathDepth(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function compareCivicLinks(a: CivicLink, b: CivicLink): number {
  const keyA = civicSortKey(a);
  const keyB = civicSortKey(b);
  if (keyA.classPriority !== keyB.classPriority) {
    return keyB.classPriority - keyA.classPriority;
  }
  if (keyA.date !== keyB.date) return keyB.date.localeCompare(keyA.date);
  if (keyA.pdfPriority !== keyB.pdfPriority) {
    return keyB.pdfPriority - keyA.pdfPriority;
  }
  return a.url.localeCompare(b.url);
}

function civicSortKey(link: CivicLink): {
  classPriority: number;
  date: string;
  pdfPriority: number;
} {
  const matchText = civicDocumentClassText(link);
  return {
    classPriority: civicDocumentClassPriority(matchText),
    date: newestDateInText(link.url),
    pdfPriority: isPdfUrl(link.url) ? 1 : 0,
  };
}

function civicDocumentClassText(link: CivicLink): string {
  try {
    const parsed = new URL(link.url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const leaf = segments.at(-1) ?? parsed.pathname;
    if (isPdfUrl(link.url) || /\.[a-z0-9]+$/i.test(leaf)) {
      return normalizeCivicText(`${leaf} ${link.anchorText}`);
    }
    return normalizeCivicText(`${parsed.pathname} ${link.anchorText}`);
  } catch {
    return civicMatchText(link);
  }
}

function civicDocumentClassPriority(text: string): number {
  if (hasAnyTerm(text, CIVIC_DOCUMENT_CLASS_TERMS.record)) return 4;
  if (hasAnyTerm(text, CIVIC_DOCUMENT_CLASS_TERMS.decision)) return 4;
  if (hasAnyTerm(text, CIVIC_DOCUMENT_CLASS_TERMS.agenda)) return 2;
  return 1;
}

function hasAnyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function newestDateInText(text: string): string {
  const dates: string[] = [];
  for (
    const match of text.matchAll(/(\d{4})[-_.\/](\d{1,2})[-_.\/](\d{1,2})/g)
  ) {
    const date = normalizeDateParts(match[1], match[2], match[3]);
    if (date) dates.push(date);
  }
  for (
    const match of text.matchAll(/(\d{1,2})[-_.\/](\d{1,2})[-_.\/](\d{4})/g)
  ) {
    const date = normalizeDateParts(match[3], match[2], match[1]);
    if (date) dates.push(date);
  }
  return dates.sort().at(-1) ?? "0000-00-00";
}

function normalizeDateParts(
  year: string,
  month: string,
  day: string,
): string | null {
  const yyyy = Number(year);
  const mm = Number(month);
  const dd = Number(day);
  if (yyyy < 1900 || yyyy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    return null;
  }
  return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${
    String(dd).padStart(2, "0")
  }`;
}
