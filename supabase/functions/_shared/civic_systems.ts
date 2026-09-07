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
  extractCivicLinksFromHtml,
  isCivicScrapableUrl,
  keywordCivicMeetingDocumentLinks,
} from "./civic_links.ts";

export type CivicSystem = "moderngov" | "generic";

export interface CivicListingCandidate {
  url: string;
  description: string;
  confidence: number;
  system: CivicSystem;
  documents_visible: number;
  recommended: boolean;
}

export interface CivicResolveResult {
  system: CivicSystem;
  candidates: CivicListingCandidate[];
  /** Pages the resolver fetched; surfaced for logging and budget tests. */
  scraped: number;
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
}

const MODERNGOV_PAGE = /\/(?:ie|mg)[A-Za-z0-9]+\.aspx$/i;
const MODERNGOV_LISTING = /\/ieListMeetings\.aspx$/i;
const MODERNGOV_MEETING = /\/ieListDocuments\.aspx$/i;
const MODERNGOV_ENTRY =
  /\/(?:mgListCommittees|mgCalendarMonthView|mgCommitteeDetails|mgWhatsNew)\.aspx$/i;

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

export function detectCivicSystem(urls: string[]): CivicSystem {
  return urls.some(isModernGovUrl) ? "moderngov" : "generic";
}

/**
 * Count the meeting documents visible one hop from a page, using the same
 * deterministic leaf test the scheduled run and the sample step use. For a
 * modern.gov listing this counts dated meeting pages; elsewhere, keyword
 * leaf documents.
 */
export function countVisibleMeetingDocuments(links: CivicLink[]): number {
  const moderngov = links.filter((link) => isModernGovMeetingUrl(link.url));
  if (moderngov.length > 0) return moderngov.length;
  return keywordCivicMeetingDocumentLinks(links).length;
}

interface FetchedPage {
  url: string;
  links: CivicLink[];
}

async function fetchPages(
  urls: string[],
  fetchHtml: CivicPageFetcher,
): Promise<FetchedPage[]> {
  const results = await Promise.all(urls.map(async (url) => {
    try {
      const html = await fetchHtml(url);
      return { url, links: extractCivicLinksFromHtml(html, url) };
    } catch {
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
  const seeds = dedupe(seedUrls).filter(isCivicScrapableUrl).slice(0, maxSeeds);
  let scraped = 0;

  const seedPages = await fetchPages(seeds, opts.fetchHtml);
  scraped += seedPages.length;
  const seenUrls = [
    ...seeds,
    ...knownUrls,
    ...seedPages.flatMap((page) => page.links.map((link) => link.url)),
  ];
  const system = detectCivicSystem(seenUrls);

  const candidates: CivicListingCandidate[] = [];
  const labels = new Map<string, string>();
  for (const page of seedPages) {
    for (const link of page.links) {
      if (link.anchorText && !labels.has(link.url)) {
        labels.set(link.url, link.anchorText);
      }
    }
  }

  // Generic rule applies to every seed, whichever system: a seed that already
  // exposes documents is itself a valid tracked page.
  for (const page of seedPages) {
    const visible = countVisibleMeetingDocuments(page.links);
    if (visible > 0) {
      candidates.push({
        url: page.url,
        description: isModernGovListingUrl(page.url)
          ? labels.get(page.url) ?? "Committee meetings listing"
          : "Page listing meeting documents",
        confidence: 0.9,
        system: isModernGovUrl(page.url) ? "moderngov" : "generic",
        documents_visible: visible,
        recommended: false,
      });
    }
  }

  if (system === "moderngov") {
    const verified = new Set(candidates.map((c) => c.url));
    let listings = dedupe(seenUrls.filter(isModernGovListingUrl))
      .filter((url) => !verified.has(url));

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
        listings = dedupe(
          page.links.map((link) => link.url).filter(isModernGovListingUrl),
        );
        if (listings.length > 0) break;
      }
    }

    const listingPages = await fetchPages(
      listings.slice(0, maxListings),
      opts.fetchHtml,
    );
    scraped += listingPages.length;
    for (const page of listingPages) {
      const visible = page.links.filter((link) =>
        isModernGovMeetingUrl(link.url)
      ).length;
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

  candidates.sort((a, b) =>
    b.documents_visible - a.documents_visible ||
    b.confidence - a.confidence || a.url.localeCompare(b.url)
  );
  if (candidates.length > 0) candidates[0].recommended = true;
  return { system, candidates, scraped };
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
    maxListings: 3,
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
  };
}
