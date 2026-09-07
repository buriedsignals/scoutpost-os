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

/**
 * Public-suffix tails that carry a second label of their own, so the
 * registrable site is the LAST THREE labels, not the last two. Councils live
 * almost exclusively under these (`bristol.gov.uk`, `zermatt.ch`), and getting
 * this wrong in either direction is what makes or breaks link extraction.
 */
const CIVIC_MULTIPART_SUFFIXES: readonly string[] = [
  "gov.uk",
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.au",
  "com.au",
  "org.au",
  "govt.nz",
  "gov.br",
  "com.br",
  "gob.mx",
  "gov.za",
  "go.jp",
  "gov.in",
  "gov.ie",
  "gov.pl",
  "gov.it",
];

/**
 * The registrable site a host belongs to: `www.bristol.gov.uk` and
 * `democracy.bristol.gov.uk` both reduce to `bristol.gov.uk`.
 */
export function civicSiteBaseHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const keep = CIVIC_MULTIPART_SUFFIXES.includes(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/**
 * True when two hosts belong to the same council site, including sibling
 * subdomains. UK councils publish their meeting documents on a committee
 * management subdomain (`democracy.<council>.gov.uk`, modern.gov) linked from
 * the main `www.` site; an exact-hostname match dropped every one of those
 * links, so civic preview resolved zero documents and the UI's Test
 * Extraction step failed for effectively every UK council.
 */
export function isSameCivicSite(hostA: string, hostB: string): boolean {
  const a = hostA.toLowerCase();
  const b = hostB.toLowerCase();
  if (a === b) return true;
  const baseA = civicSiteBaseHost(a);
  const baseB = civicSiteBaseHost(b);
  // A bare public suffix (`gov.uk`) is not a site — refuse to treat every
  // council in the country as one domain.
  if (!baseA || !baseB || CIVIC_MULTIPART_SUFFIXES.includes(baseA)) {
    return false;
  }
  return baseA === baseB;
}

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
    // hrefs arrive HTML-escaped. modern.gov URLs are query-heavy
    // (`?GL=1&amp;bcr=1`); left undecoded the second parameter becomes
    // `amp;bcr` and the fetched page is not the one that was linked.
    const rawHref = decodeHtmlEntities((match[1] ?? "").trim());
    const rawAnchor = decodeHtmlEntities(
      (match[2] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    );
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
    if (!isSameCivicSite(absolute.hostname, pageDomain)) continue;

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

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#39);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity,
  );
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
  opts: { maxDocs?: number; tenantKey?: string } = {},
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
        workloadClass: "utility",
        tenantKey: opts.tenantKey,
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

/**
 * Deterministic stage of document classification: scrapable links that carry
 * a meeting keyword AND look like a leaf document. No model call. The
 * resolver uses this to count "documents visible" behind a candidate page.
 */
export function keywordCivicMeetingDocumentLinks(
  links: CivicLink[],
): CivicLink[] {
  return links
    .filter((link) => isCivicScrapableUrl(link.url))
    .filter((link) =>
      hasMeetingKeyword(civicMatchText(link)) ||
      isCivicRecordDocumentUrl(link.url)
    )
    .filter(isCivicMeetingDocumentLink)
    .sort(compareCivicLinks);
}

export async function classifyCivicMeetingUrls(
  links: CivicLink[],
): Promise<string[]> {
  const scrapableLinks = links.filter((link) => isCivicScrapableUrl(link.url));
  if (scrapableLinks.length === 0) return [];

  // A populated record-id URL (`ieListDocuments.aspx?…&MId=<n>`) names one
  // meeting whatever its anchor says ("9 Sep 2026 1.00 pm" carries no
  // keyword), so it joins the deterministic stage alongside keyword hits.
  const keywordMatches = scrapableLinks.filter((link) =>
    hasMeetingKeyword(civicMatchText(link)) ||
    isCivicRecordDocumentUrl(link.url)
  );

  const keywordDocumentLinks = keywordMatches.filter(
    isCivicMeetingDocumentLink,
  );
  // Only a keyword stage that actually produced leaf documents may skip the
  // model. A page whose keyword hits are all navigation ("Council meetings",
  // "How decisions are made") used to short-circuit to an empty result and
  // report "no documents"; fall through to the model instead.
  if (keywordDocumentLinks.length > 0) {
    return keywordDocumentLinks.sort(compareCivicLinks).map((link) => link.url);
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
        .filter(isCivicMeetingDocumentLink)
        .sort(compareCivicLinks);
    return classified.map((link) => link.url);
  } catch {
    return [];
  }
}

/**
 * A meeting keyword alone identifies both archive/listing pages and individual
 * papers. Only leaf documents may enter extraction: PDFs, populated record-ID
 * pages, or HTML links carrying a full date in their URL or label.
 * This rejects archive links such as Pontresina's bare
 * `/de/aktuelles/gemeindeversammlungen`, which previously produced meeting-date
 * summaries instead of accountability leads.
 */
export function isCivicMeetingDocumentLink(link: CivicLink): boolean {
  if (isModernGovNonDocumentPage(link.url)) return false;
  if (isPdfUrl(link.url) || isCivicRecordDetailUrl(link.url)) return true;
  const evidence = `${link.url} ${link.anchorText}`;
  if (
    /(?:^|\D)(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])(?:\D|$)/
      .test(
        evidence,
      ) ||
    /(?:^|\D)(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)\d{2}(?:\D|$)/
      .test(
        evidence,
      ) ||
    /(?:^|\D)(?:0?[1-9]|[12]\d|3[01])\.?\s+[\p{L}]{3,}\s+(?:19|20)\d{2}(?:\D|$)/u
      .test(evidence) ||
    /(?:^|\D)[\p{L}]{3,}\s+(?:0?[1-9]|[12]\d|3[01]),?\s+(?:19|20)\d{2}(?:\D|$)/u
      .test(evidence)
  ) return true;

  try {
    const leaf = decodeURIComponent(new URL(link.url).pathname).split("/")
      .filter(Boolean).at(-1) ?? "";
    if (
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(leaf) ||
      /^\d{4,}$/.test(leaf) && !/^(?:19|20)\d{2}$/.test(leaf)
    ) return true;
  } catch {
    return false;
  }
  return false;
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
  // modern.gov (UK): `ieListDocuments.aspx?CId=<committee>&MId=<meeting>` is
  // one meeting's document page. Shape verified on democracy.leeds.gov.uk,
  // 2026-09-07.
  "mid",
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

/**
 * modern.gov `mg*.aspx?ID=<n>` pages are committee, member and mailing-list
 * records — record ids, but never meeting documents. Only `ie*.aspx` pages
 * (`ieListDocuments.aspx?…MId=`) and `/documents/` files are. Verified on
 * democracy.leeds.gov.uk, 2026-09-07 (38 `mgCommitteeDetails.aspx?ID=` links
 * on the committee index were being counted as documents).
 */
export function isModernGovNonDocumentPage(url: string): boolean {
  try {
    return /\/mg[A-Za-z0-9]+\.aspx$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * A record-id URL that stands for one meeting document WITHOUT any meeting
 * keyword in its text: only modern.gov `ie*.aspx?…MId=` pages qualify. Any
 * other `?id=<n>` record (a consultation, a news item — Bristol's
 * `consultation-engagement?id=287` was counted as a meeting document on
 * 2026-09-07) still needs a keyword to enter the deterministic stage.
 */
export function isCivicRecordDocumentUrl(url: string): boolean {
  if (!isCivicRecordDetailUrl(url)) return false;
  try {
    const path = new URL(url).pathname;
    // modern.gov meeting pages; Legistar meeting pages and agenda/minutes
    // files (`View.ashx?M=A&ID=…`), verified on seattle.legistar.com.
    return /\/ie[A-Za-z0-9]+\.aspx$/i.test(path) ||
      /\/(?:MeetingDetail\.aspx|View\.ashx)$/i.test(path);
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
