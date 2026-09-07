/**
 * Council committee-system fingerprints and the listing resolver behind the
 * Civic Scout "detect" probe.
 *
 * Most government websites do not publish meeting documents one hop from the
 * root: UK councils link from `www.<council>.gov.uk` to a modern.gov
 * committee site on `democracy.<council>.gov.uk`, whose hierarchy is
 *
 *   mgListCommittees.aspx / mgCalendarMonthView.aspx        (entry)
 *     → ieListMeetings.aspx?CId=<n>  or ?CommitteeId=<n>     (listing)
 *       → ieListDocuments.aspx?CId=<n>&MId=<m>&Ver=<v>       (one meeting)
 *         → /documents/g<id>/Printed minutes ….pdf            (documents)
 *
 * (shape verified on democracy.leeds.gov.uk, 2026-09-07). The resolver walks
 * that hierarchy deterministically and only returns listing pages behind
 * which it has already seen meetings, so whatever a user or agent picks is
 * known to work. Sites without a fingerprint fall back to the generic
 * one-hop leaf-document count.
 */

import {
  type CivicLink,
  civicSiteBaseHost,
  extractCivicLinksFromHtml,
  isCivicScrapableUrl,
  keywordCivicMeetingDocumentLinks,
} from "./civic_links.ts";
import { scrape } from "./scrape.ts";

/**
 * Per-page budget for resolver fetches. modern.gov committee listings render
 * slowly (Leeds' Council and Executive Board listings need 40 s+); pages are
 * fetched concurrently, so this is per page, not additive. Every caller of
 * the resolver — discover, validate, and the create gate — must use the same
 * budget, or a page that resolves in one step fails in the next.
 */
export const CIVIC_RESOLVER_SCRAPE_TIMEOUT_MS = 45_000;

/** The resolver's page fetcher through the provider-agnostic scrape port. */
export function civicResolverFetcher(tenantKey: string): CivicPageFetcher {
  return async (url: string) => {
    const scraped = await scrape(url, {
      workloadClass: "utility",
      tenantKey,
      formats: ["rawHtml"],
      onlyMainContent: false,
      timeoutMs: CIVIC_RESOLVER_SCRAPE_TIMEOUT_MS,
    });
    return scraped.rawHtml ?? "";
  };
}

export type CivicSystem = "moderngov" | "legistar" | "generic";

export interface CivicListingCandidate {
  url: string;
  description: string;
  confidence: number;
  system: CivicSystem;
  documents_visible: number;
  recommended: boolean;
}

export interface CivicResolveDiagnostics {
  seeds: string[];
  /** Civic-looking pages one hop below the seeds, fetched as extra seeds. */
  second_level: string[];
  /** Well-known committee-system hosts probed (e.g. democracy.<council>). */
  probed: string[];
  /** Every listing fetched, with the meetings visible on it (0 = dropped). */
  listings_checked: Array<{ url: string; documents_visible: number }>;
  /** Listings that could not be fetched (timeout, error) — offered nowhere. */
  listings_failed: Array<{ url: string; description?: string; error: string }>;
}

export interface CivicResolveResult {
  system: CivicSystem;
  candidates: CivicListingCandidate[];
  /** Pages the resolver fetched; surfaced for logging and budget tests. */
  scraped: number;
  diagnostics: CivicResolveDiagnostics;
}

export type CivicPageFetcher = (url: string) => Promise<string>;

export interface CivicResolveOptions {
  fetchHtml: CivicPageFetcher;
  /** Seed pages to inspect (ranked discovery candidates, or tracked URLs). */
  maxSeeds?: number;
  /** modern.gov entry pages to expand when seeds hold no listing directly. */
  maxEntries?: number;
  /** Listing pages to verify per site. */
  maxListings?: number;
  /** Civic-looking links below the seeds to follow when seeds expose nothing. */
  maxSecondLevel?: number;
}

/**
 * Anchor/URL terms that mark a page worth one more hop from a council root.
 * Whole words about governance only — a bare "council" matched
 * "council-tax" and "how-to-pay-your-council-tax" on leeds.gov.uk.
 */
const CIVIC_HOP_TERMS =
  /\b(?:meetings?|committees?|democracy|minutes|agendas?|decisions?|your[- ]council|council[- ]and[- ]democracy|the[- ]council|councillors|protokoll|sitzung|gemeinderat|séance|seance|conseil|consiglio|raad)\b/i;
const CIVIC_HOP_EXCLUDE = /\b(?:tax|bins?|parking|benefits?|housing|jobs?)\b/i;

/**
 * Conventional committee-system hosts. modern.gov customers publish on
 * `democracy.<council>` (bristol.gov.uk and leeds.gov.uk verified 2026-09-07);
 * probing that host directly is one fetch and short-circuits sites whose main
 * navigation is JS-rendered or whose sitemap omits the subdomain.
 */
const WELL_KNOWN_COMMITTEE_HOSTS = ["democracy", "committees", "moderngov"];

function wellKnownEntryUrls(hosts: string[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const host of hosts) {
    const base = civicSiteBaseHost(host);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    if (base.endsWith(".gov.uk")) {
      for (const sub of WELL_KNOWN_COMMITTEE_HOSTS) {
        urls.push(`https://${sub}.${base}/mgListCommittees.aspx?bcr=1`);
      }
    } else if (/\.(?:gov|us|org)$/i.test(base)) {
      // Legistar tenants are named after the council: seattle.gov →
      // seattle.legistar.com (verified). One fetch; wrong guesses 404.
      const name = base.split(".")[0];
      if (name && name.length >= 3) {
        urls.push(`https://${name}.legistar.com/Calendar.aspx`);
      }
    }
  }
  return urls;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const MODERNGOV_PAGE = /\/(?:ie|mg)[A-Za-z0-9]+\.aspx$/i;

/**
 * Legistar (Granicus; US councils). Shape verified on seattle.legistar.com,
 * 2026-09-07:
 *   Calendar.aspx                          — all meetings (listing)
 *   DepartmentDetail.aspx?ID=<n>&GUID=<g>  — one committee (listing)
 *   MeetingDetail.aspx?ID=<n>&GUID=<g>     — one meeting (HTML page)
 *   View.ashx?M=A|M|…&ID=<n>&GUID=<g>      — agenda / minutes file
 */
const LEGISTAR_HOST = /(?:^|\.)legistar\.com$/i;
const LEGISTAR_PAGE =
  /\/(?:Calendar|DepartmentDetail|MeetingDetail|LegislationDetail|Legislation|Departments)\.aspx$|\/View\.ashx$/i;
const LEGISTAR_LISTING = /\/(?:Calendar|DepartmentDetail)\.aspx$/i;
const LEGISTAR_MEETING = /\/MeetingDetail\.aspx$/i;
const MODERNGOV_LISTING = /\/ieListMeetings\.aspx$/i;
const MODERNGOV_MEETING = /\/ieListDocuments\.aspx$/i;
const MODERNGOV_ENTRY =
  /\/(?:mgListCommittees|mgCalendarMonthView|mgCommitteeDetails|mgWhatsNew)\.aspx$/i;
const MODERNGOV_COMMITTEE = /\/mgCommitteeDetails\.aspx$/i;

/**
 * Anchor text that marks the bodies whose meetings matter most; their
 * listings are verified first when a committee index offers dozens.
 */
const PRIORITY_COMMITTEE_TERMS = [
  "full council",
  "cabinet",
  "executive board",
  "executive",
  "planning",
  "scrutiny",
  "council",
];

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function hasPopulatedParam(url: string, names: string[]): boolean {
  try {
    const params = new URL(url).searchParams;
    for (const [key, value] of params) {
      if (names.includes(key.toLowerCase()) && value.trim() !== "") return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isModernGovUrl(url: string): boolean {
  const path = pathOf(url);
  return path !== null && MODERNGOV_PAGE.test(path);
}

export function isLegistarUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LEGISTAR_HOST.test(parsed.hostname) ||
      LEGISTAR_PAGE.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** A Legistar calendar or committee page — the tracked URL for a scout. */
export function isLegistarListingUrl(url: string): boolean {
  const path = pathOf(url);
  if (path === null || !LEGISTAR_LISTING.test(path)) return false;
  return /\/Calendar\.aspx$/i.test(path) || hasPopulatedParam(url, ["id"]);
}

/** One meeting's page (carries `ID`). */
export function isLegistarMeetingUrl(url: string): boolean {
  const path = pathOf(url);
  return path !== null && LEGISTAR_MEETING.test(path) &&
    hasPopulatedParam(url, ["id"]);
}

/** A committee's meetings list — the ideal tracked URL for a Council scout. */
export function isModernGovListingUrl(url: string): boolean {
  const path = pathOf(url);
  return path !== null && MODERNGOV_LISTING.test(path) &&
    hasPopulatedParam(url, ["cid", "committeeid"]);
}

/** One meeting's document page (dated; carries `MId`). */
export function isModernGovMeetingUrl(url: string): boolean {
  const path = pathOf(url);
  return path !== null && MODERNGOV_MEETING.test(path) &&
    hasPopulatedParam(url, ["mid"]);
}

/** A page that links to committee listings. */
function modernGovEntryPriority(url: string): number {
  const path = pathOf(url) ?? "";
  if (/mgListCommittees\.aspx$/i.test(path)) return 0;
  if (/mgCommitteeDetails\.aspx$/i.test(path)) return 1;
  if (/mgCalendarMonthView\.aspx$/i.test(path)) return 2;
  return 3;
}

export function isModernGovEntryUrl(url: string): boolean {
  const path = pathOf(url);
  return path !== null && MODERNGOV_ENTRY.test(path);
}

/**
 * A committee record page `mgCommitteeDetails.aspx?ID=<n>` has a listing at
 * `ieListMeetings.aspx?CommitteeId=<n>` on the same host — derived without a
 * fetch (verified on democracy.leeds.gov.uk: committee 111 → CommitteeId=111).
 */
export function modernGovListingForCommittee(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!MODERNGOV_COMMITTEE.test(parsed.pathname)) return null;
    const id = [...parsed.searchParams].find(([k]) => k.toLowerCase() === "id")
      ?.[1]?.trim();
    if (!id || !/^\d+$/.test(id)) return null;
    return `${parsed.origin}/ieListMeetings.aspx?CommitteeId=${id}`;
  } catch {
    return null;
  }
}

function committeePriority(label: string | undefined): number {
  const text = (label ?? "").toLowerCase().trim();
  // The council itself is usually labelled just "Council" (Leeds) or
  // "Full Council" (Bristol); a scrutiny board that merely contains the word
  // must not outrank it.
  if (
    text === "council" || text === "full council" || text === "city council"
  ) {
    return 0;
  }
  const index = PRIORITY_COMMITTEE_TERMS.findIndex((term) =>
    new RegExp(`\\b${term}\\b`).test(text)
  );
  return index === -1 ? PRIORITY_COMMITTEE_TERMS.length : index;
}

export function detectCivicSystem(urls: string[]): CivicSystem {
  if (urls.some(isModernGovUrl)) return "moderngov";
  if (urls.some(isLegistarUrl)) return "legistar";
  return "generic";
}

/**
 * Count the meeting documents visible one hop from a page, using the same
 * deterministic leaf test the scheduled run and the sample step use. For a
 * modern.gov listing this counts dated meeting pages; elsewhere, keyword
 * leaf documents.
 */
export function countVisibleMeetingDocuments(links: CivicLink[]): number {
  const meetings = links.filter((link) =>
    isModernGovMeetingUrl(link.url) || isLegistarMeetingUrl(link.url)
  );
  if (meetings.length > 0) return meetings.length;
  // A committee-system page without meeting pages exposes committee/member
  // records at most — never documents — however many record ids it carries.
  if (
    links.some((link) => isModernGovUrl(link.url) || isLegistarUrl(link.url))
  ) {
    return 0;
  }
  return keywordCivicMeetingDocumentLinks(links).length;
}

interface FetchedPage {
  url: string;
  links: CivicLink[];
}

async function fetchPages(
  urls: string[],
  fetchHtml: CivicPageFetcher,
  onError?: (url: string, error: unknown) => void,
): Promise<FetchedPage[]> {
  const results = await Promise.all(urls.map(async (url) => {
    try {
      const html = await fetchHtml(url);
      return { url, links: extractCivicLinksFromHtml(html, url) };
    } catch (error) {
      onError?.(url, error);
      return null;
    }
  }));
  return results.filter((page): page is FetchedPage => page !== null);
}

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const key = url.split("#")[0].replace(/\/+$/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Resolve the pages worth tracking from a set of seeds.
 *
 * 1. Fetch the seeds; count documents visible behind each (generic rule).
 * 2. Detect the committee system from every URL seen.
 * 3. modern.gov: collect listing URLs from the seeds and the map; if none,
 *    expand entry pages one hop to find them; verify each listing by
 *    fetching it and counting dated meeting pages.
 * 4. Return only candidates with `documents_visible ≥ 1`, best first.
 */
export async function resolveCivicListings(
  seedUrls: string[],
  opts: CivicResolveOptions,
  knownUrls: string[] = [],
): Promise<CivicResolveResult> {
  const maxSeeds = Math.max(1, opts.maxSeeds ?? 3);
  const maxEntries = Math.max(0, opts.maxEntries ?? 2);
  const maxListings = Math.max(1, opts.maxListings ?? 5);
  const maxSecondLevel = Math.max(0, opts.maxSecondLevel ?? 3);
  const seeds = dedupe(seedUrls).filter(isCivicScrapableUrl).slice(0, maxSeeds);
  let scraped = 0;
  const diagnostics: CivicResolveDiagnostics = {
    seeds,
    second_level: [],
    probed: [],
    listings_checked: [],
    listings_failed: [],
  };

  const labels = new Map<string, string>();
  const remember = (pages: FetchedPage[]) => {
    for (const page of pages) {
      for (const link of page.links) {
        if (link.anchorText && !labels.has(link.url)) {
          labels.set(link.url, link.anchorText);
        }
      }
    }
  };

  const seedPages = await fetchPages(seeds, opts.fetchHtml);
  scraped += seedPages.length;
  remember(seedPages);
  const seenUrls = [
    ...seeds,
    ...knownUrls,
    ...seedPages.flatMap((page) => page.links.map((link) => link.url)),
  ];

  // A council root rarely exposes meetings itself: follow the civic-looking
  // links one hop ("Council and democracy", "Committees") when nothing
  // seeded is a committee system or a document listing.
  if (
    detectCivicSystem(seenUrls) === "generic" && maxSecondLevel > 0 &&
    !seedPages.some((page) => countVisibleMeetingDocuments(page.links) > 0)
  ) {
    const hop = dedupe(
      seedPages.flatMap((page) =>
        page.links
          .filter((link) => {
            const text = `${link.url} ${link.anchorText}`;
            return CIVIC_HOP_TERMS.test(text) && !CIVIC_HOP_EXCLUDE.test(text);
          })
          .map((link) => link.url)
      ),
    ).filter((url) => !seeds.includes(url)).slice(0, maxSecondLevel);
    if (hop.length > 0) {
      const hopPages = await fetchPages(hop, opts.fetchHtml);
      scraped += hopPages.length;
      remember(hopPages);
      diagnostics.second_level = hop;
      seedPages.push(...hopPages);
      seenUrls.push(
        ...hop,
        ...hopPages.flatMap((page) => page.links.map((link) => link.url)),
      );
    }
  }

  // Still no committee system in sight: try the conventional host directly.
  if (detectCivicSystem(seenUrls) === "generic") {
    const hosts = seeds.map(hostOf).filter((h): h is string => h !== null);
    for (const entry of wellKnownEntryUrls(hosts)) {
      const [page] = await fetchPages([entry], opts.fetchHtml);
      diagnostics.probed.push(entry);
      if (!page) continue;
      scraped += 1;
      const urls = page.links.map((link) => link.url);
      const hit = urls.some((u) => isModernGovUrl(u) || isLegistarUrl(u)) ||
        isModernGovUrl(entry) || isLegistarUrl(entry);
      if (!hit) continue;
      remember([page]);
      seenUrls.push(entry, ...urls);
      break;
    }
  }

  const system = detectCivicSystem(seenUrls);
  const candidates: CivicListingCandidate[] = [];

  // Generic rule applies to every seed, whichever system: a seed that already
  // exposes documents is itself a valid tracked page.
  for (const page of seedPages) {
    const visible = countVisibleMeetingDocuments(page.links);
    if (visible > 0) {
      candidates.push({
        url: page.url,
        description: isModernGovListingUrl(page.url) ||
            isLegistarListingUrl(page.url)
          ? labels.get(page.url) ?? "Meetings listing"
          : "Page listing meeting documents",
        confidence: 0.9,
        system: isModernGovUrl(page.url)
          ? "moderngov"
          : isLegistarUrl(page.url)
          ? "legistar"
          : "generic",
        documents_visible: visible,
        recommended: false,
      });
    }
  }

  if (system === "legistar") {
    const verified = new Set(candidates.map((c) => c.url));
    const listings = dedupe(seenUrls.filter(isLegistarListingUrl))
      .filter((url) => !verified.has(url))
      // The calendar (all bodies) first, then committees.
      .sort((a, b) =>
        Number(!/\/Calendar\.aspx$/i.test(a)) -
        Number(!/\/Calendar\.aspx$/i.test(b))
      )
      .slice(0, maxListings);
    const listingPages = await fetchPages(
      listings,
      opts.fetchHtml,
      (url, error) =>
        diagnostics.listings_failed.push({
          url,
          description: labels.get(url),
          error: String(error instanceof Error ? error.message : error)
            .slice(0, 160),
        }),
    );
    scraped += listingPages.length;
    for (const page of listingPages) {
      const visible = page.links.filter((link) =>
        isLegistarMeetingUrl(link.url)
      ).length;
      diagnostics.listings_checked.push({
        url: page.url,
        documents_visible: visible,
      });
      if (visible === 0) continue;
      candidates.push({
        url: page.url,
        description: /\/Calendar\.aspx$/i.test(page.url)
          ? "All meetings (calendar)"
          : labels.get(page.url) ?? "Committee meetings listing",
        confidence: 0.85,
        system: "legistar",
        documents_visible: visible,
        recommended: false,
      });
    }
  }

  if (system === "moderngov") {
    const verified = new Set(candidates.map((c) => c.url));
    const collectListings = (urls: string[]): string[] => {
      const direct = urls.filter(isModernGovListingUrl);
      const derived: string[] = [];
      for (const url of urls) {
        const listing = modernGovListingForCommittee(url);
        if (!listing) continue;
        if (!labels.has(listing) && labels.has(url)) {
          labels.set(listing, labels.get(url)!);
        }
        derived.push(listing);
      }
      return dedupe([...direct, ...derived])
        .filter((url) => !verified.has(url))
        .sort((a, b) =>
          committeePriority(labels.get(a)) - committeePriority(labels.get(b))
        );
    };
    let listings = collectListings(seenUrls);

    if (listings.length === 0 && maxEntries > 0) {
      // Expand entry pages in priority order and stop at the first that
      // yields listings: the committee index is the canonical one; the
      // calendar is a fallback.
      const entries = dedupe(seenUrls.filter(isModernGovEntryUrl))
        .filter((url) => !seeds.includes(url))
        .sort((a, b) => modernGovEntryPriority(a) - modernGovEntryPriority(b))
        .slice(0, maxEntries);
      for (const entry of entries) {
        const [page] = await fetchPages([entry], opts.fetchHtml);
        if (!page) continue;
        scraped += 1;
        for (const link of page.links) {
          if (link.anchorText && !labels.has(link.url)) {
            labels.set(link.url, link.anchorText);
          }
        }
        listings = collectListings(page.links.map((link) => link.url));
        if (listings.length > 0) break;
      }
    }

    const listingPages = await fetchPages(
      listings.slice(0, maxListings),
      opts.fetchHtml,
      (url, error) =>
        diagnostics.listings_failed.push({
          url,
          description: labels.get(url),
          error: String(error instanceof Error ? error.message : error)
            .slice(0, 160),
        }),
    );
    scraped += listingPages.length;
    for (const page of listingPages) {
      const visible = page.links.filter((link) =>
        isModernGovMeetingUrl(link.url)
      ).length;
      diagnostics.listings_checked.push({
        url: page.url,
        documents_visible: visible,
      });
      if (visible === 0) continue;
      candidates.push({
        url: page.url,
        description: labels.get(page.url) ?? "Committee meetings listing",
        confidence: 0.85,
        system: "moderngov",
        documents_visible: visible,
        recommended: false,
      });
    }
  }

  // Which body matters more than how many meetings it lists: the council
  // itself is the default recommendation, a busier scrutiny board is not.
  candidates.sort((a, b) =>
    committeePriority(a.description) - committeePriority(b.description) ||
    b.documents_visible - a.documents_visible ||
    b.confidence - a.confidence || a.url.localeCompare(b.url)
  );
  if (candidates.length > 0) candidates[0].recommended = true;
  return { system, candidates, scraped, diagnostics };
}

export interface CivicTrackedUrlValidation {
  ok: boolean;
  system: CivicSystem;
  /** Tracked URLs behind which meetings are visible. */
  validated: string[];
  /** Tracked URLs that expose no meetings. */
  invalid: string[];
  /** Listings the resolver found instead — offered as replacements. */
  candidates: CivicListingCandidate[];
  scraped: number;
  diagnostics: CivicResolveDiagnostics;
}

/**
 * Gate check for `POST /scouts` (type civic) and the CLI/MCP pre-flight: every
 * tracked URL must itself expose meetings. Alternatives are returned so a
 * client can offer them, but they never substitute silently.
 */
export async function validateCivicTrackedUrls(
  trackedUrls: string[],
  opts: CivicResolveOptions,
): Promise<CivicTrackedUrlValidation> {
  const normalized = dedupe(trackedUrls);
  const result = await resolveCivicListings(normalized, {
    maxEntries: 1,
    maxListings: 5,
    maxSecondLevel: 0,
    ...opts,
    maxSeeds: Math.max(normalized.length, 1),
  });
  const validated = normalized.filter((url) =>
    result.candidates.some((candidate) => candidate.url === url)
  );
  const invalid = normalized.filter((url) => !validated.includes(url));
  return {
    ok: invalid.length === 0 && validated.length > 0,
    system: result.system,
    validated,
    invalid,
    candidates: result.candidates.filter((candidate) =>
      !validated.includes(candidate.url)
    ),
    scraped: result.scraped,
    diagnostics: result.diagnostics,
  };
}
