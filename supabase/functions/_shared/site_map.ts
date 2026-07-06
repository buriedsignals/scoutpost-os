/**
 * In-house site mapper (SCRAPING-MIGRATION-PRD U5) — replaces Firecrawl /map.
 *
 * Enumerates candidate URLs for a domain without scraping each:
 *   1. robots.txt `Sitemap:` directives → sitemap.xml (index or urlset),
 *      recursing one level into sitemap indexes, handling .gz sitemaps.
 *   2. Fallback: harvest links from the root page via the scrape port.
 *
 * Output is `string[]` (≤ limit), same-registrable-domain filtered (subdomains
 * included by default) — the shape civic/index.ts's Gemini ranking consumes.
 * The ranking tolerates noise, so precision is secondary to recall here.
 */

import { scrape } from "./scrape.ts";

export interface SiteMapOptions {
  limit?: number;
  includeSubdomains?: boolean;
  /** Client-side fetch fuse per request (ms). Default 15_000. */
  timeoutMs?: number;
  /**
   * Overall wall-clock budget across all fetches (ms). Default 40_000 — real
   * council sitemaps resolve in 1–10s; this caps a pathological case (many
   * dead robots Sitemap: entries or a huge sitemap index) so the user-facing
   * civic discover request can't hang past the edge-function deadline.
   */
  overallDeadlineMs?: number;
}

const UA = "scoutpost-sitemap/1.0";

function registrableDomain(hostname: string): string {
  const labels = hostname.split(".");
  if (labels.length <= 2) return hostname;
  // Handle common two-label public suffixes (co.uk, gov.uk, com.au, gc.ca…)
  // heuristically — good enough for civic gov domains; the Gemini ranker
  // tolerates the occasional over-broad match.
  const secondLevel = labels[labels.length - 2];
  const twoLabelSuffix = new Set(["co", "com", "org", "gov", "net", "ac", "gc"]);
  const take = twoLabelSuffix.has(secondLevel) ? 3 : 2;
  return labels.slice(-take).join(".");
}

function sameSite(
  candidate: string,
  base: string,
  includeSubdomains: boolean,
): boolean {
  let host: string;
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return false;
  }
  const baseHost = base.toLowerCase();
  if (host === baseHost) return true;
  if (!includeSubdomains) return false;
  const baseReg = registrableDomain(baseHost);
  return host === baseReg || host.endsWith("." + baseReg);
}

async function fetchText(
  url: string,
  timeoutMs: number,
): Promise<{ text: string; contentType: string } | null> {
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: ac.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (url.endsWith(".gz") || contentType.includes("gzip")) {
      const stream = res.body?.pipeThrough(new DecompressionStream("gzip"));
      const text = stream
        ? await new Response(stream).text()
        : await res.text();
      return { text, contentType };
    }
    return { text: await res.text(), contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(fuse);
  }
}

function extractTag(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>\\s*([^<]+?)\\s*</${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].trim().replace(/&amp;/g, "&"));
  }
  return out;
}

function sitemapUrlsFromRobots(robots: string, origin: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap:\s*(\S+)/i);
    if (m) {
      try {
        out.push(new URL(m[1], origin).toString());
      } catch { /* skip malformed */ }
    }
  }
  return out;
}

/** Enumerate candidate URLs for a domain. Never throws — returns [] on failure
 * so the caller (civic discover) degrades to an empty candidate set. */
export async function mapSite(
  target: string,
  opts: SiteMapOptions = {},
): Promise<string[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 5_000);
  const includeSubdomains = opts.includeSubdomains ?? true;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + (opts.overallDeadlineMs ?? 40_000);

  let base: URL;
  try {
    base = new URL(target);
  } catch {
    return [];
  }
  const baseHost = base.hostname;
  const found = new Set<string>();

  // 1. robots.txt → sitemap URLs (fall back to the conventional location).
  const robots = await fetchText(new URL("/robots.txt", base).toString(), timeoutMs);
  let sitemapUrls = robots
    ? sitemapUrlsFromRobots(robots.text, base.origin)
    : [];
  if (sitemapUrls.length === 0) {
    sitemapUrls = [new URL("/sitemap.xml", base).toString()];
  }

  // 2. Parse sitemaps, recursing one level into sitemap indexes.
  const visited = new Set<string>();
  const queue = [...sitemapUrls];
  let recursions = 0;
  while (
    queue.length > 0 && found.size < limit && recursions < 50 &&
    Date.now() < deadline
  ) {
    const smUrl = queue.shift()!;
    if (visited.has(smUrl)) continue;
    visited.add(smUrl);
    recursions++;
    const doc = await fetchText(smUrl, timeoutMs);
    if (!doc) continue;
    // A <sitemapindex> lists child sitemaps; a <urlset> lists page <loc>s.
    // Both use <loc>; distinguish by the wrapper element.
    const isIndex = /<sitemapindex[\s>]/i.test(doc.text);
    const locs = extractTag(doc.text, "loc");
    if (isIndex) {
      for (const child of locs) {
        if (!visited.has(child)) queue.push(child);
      }
    } else {
      for (const loc of locs) {
        if (sameSite(loc, baseHost, includeSubdomains)) found.add(loc);
        if (found.size >= limit) break;
      }
    }
  }

  if (found.size > 0) return [...found].slice(0, limit);

  // 3. Fallback: harvest links from the root page via the scrape port.
  try {
    const page = await scrape(target, { formats: ["rawHtml"], timeoutMs });
    const html = page.rawHtml ?? "";
    const hrefRe = /href\s*=\s*["']([^"'#]+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(html)) !== null && found.size < limit) {
      let abs: string;
      try {
        abs = new URL(m[1], base).toString();
      } catch {
        continue;
      }
      if (sameSite(abs, baseHost, includeSubdomains)) found.add(abs);
    }
  } catch {
    /* scrape failed → return whatever we have (possibly empty) */
  }

  return [...found].slice(0, limit);
}
