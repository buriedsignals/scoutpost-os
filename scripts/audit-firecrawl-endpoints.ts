/**
 * Live Firecrawl endpoint audit for scout retrieval optimization.
 *
 * This spends real Firecrawl credits. It does not write production data.
 *
 * Run:
 *   set -a; source .env; set +a
 *   deno run --allow-env --allow-net scripts/audit-firecrawl-endpoints.ts
 */

import {
  firecrawlMap,
  firecrawlSearch,
  type SearchHit,
} from "../supabase/functions/_shared/firecrawl.ts";
import { beatCandidateRejectReason } from "../supabase/functions/_shared/beat_pipeline.ts";
import { isCivicDirectDocumentUrl } from "../supabase/functions/_shared/civic_links.ts";

interface AuditRow {
  scenario: string;
  endpoint: string;
  total: number;
  usable: number;
  pdfs: number;
  direct_civic_pdfs: number;
  priority_domain_hits: number;
  weak_rejections: number;
  top_urls: string[];
}

const PRIORITY_DOMAINS = [
  "engadinerpost.ch",
  "engadin.online",
  "suedostschweiz.ch",
  "gr.ch",
];
const ENGADIN_PRIORITY_QUERIES = [
  "Engadin Wohnraum Gemeinde",
  "Oberengadin Wohnraum",
];

function normalizeDomain(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.toLowerCase().replace(/^www\./, "");
  }
}

function matchesDomain(rawUrl: string, domain: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    const expected = normalizeDomain(domain);
    return host === expected || host.endsWith("." + expected);
  } catch {
    return false;
  }
}

function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return /\.pdf(?:$|[?#])/i.test(url);
  }
}

function summarizeHits(
  scenario: string,
  endpoint: string,
  hits: SearchHit[],
): AuditRow {
  const weakRejections =
    hits.filter((hit) => beatCandidateRejectReason(hit) !== null).length;
  return {
    scenario,
    endpoint,
    total: hits.length,
    usable: hits.length - weakRejections,
    pdfs: hits.filter((hit) => isPdfUrl(hit.url)).length,
    direct_civic_pdfs:
      hits.filter((hit) => isCivicDirectDocumentUrl(hit.url)).length,
    priority_domain_hits:
      hits.filter((hit) =>
        PRIORITY_DOMAINS.some((domain) => matchesDomain(hit.url, domain))
      ).length,
    weak_rejections: weakRejections,
    top_urls: hits.slice(0, 5).map((hit) => hit.url),
  };
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (!hit.url || seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push(hit);
  }
  return out;
}

function summarizeUrls(
  scenario: string,
  endpoint: string,
  urls: string[],
): AuditRow {
  const hits = urls.map((url) => ({ url }));
  return summarizeHits(scenario, endpoint, hits);
}

function printRows(rows: AuditRow[]): void {
  console.log("# Firecrawl Endpoint Audit");
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log("");
  console.log(
    "| Scenario | Endpoint | Total | Usable | PDFs | Direct Civic PDFs | Priority Domains | Weak Rejections |",
  );
  console.log("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const row of rows) {
    console.log(
      `| ${row.scenario} | ${row.endpoint} | ${row.total} | ${row.usable} | ${row.pdfs} | ${row.direct_civic_pdfs} | ${row.priority_domain_hits} | ${row.weak_rejections} |`,
    );
  }
  console.log("");
  console.log("## Top URLs");
  for (const row of rows) {
    console.log(`### ${row.scenario} / ${row.endpoint}`);
    for (const url of row.top_urls) {
      console.log(`- ${url}`);
    }
    if (row.top_urls.length === 0) console.log("- none");
    console.log("");
  }
}

if (!Deno.env.get("FIRECRAWL_API_KEY")) {
  throw new Error("Missing FIRECRAWL_API_KEY");
}

const rows: AuditRow[] = [];

const engadinIncludeDomains = dedupeHits(
  (await Promise.all(
    ENGADIN_PRIORITY_QUERIES.map((query) =>
      firecrawlSearch(query, {
        limit: 10,
        sources: ["web"],
        includeDomains: PRIORITY_DOMAINS,
        country: "CH",
        location: "Engadin, Graubunden, Switzerland",
        ignoreInvalidURLs: true,
      })
    ),
  )).flat(),
);
rows.push(
  summarizeHits(
    "engadin-priority-domains",
    "search includeDomains",
    engadinIncludeDomains,
  ),
);

const engadinSiteQueries = await Promise.all(
  PRIORITY_DOMAINS.map((domain) =>
    firecrawlSearch(
      `site:${domain} ${ENGADIN_PRIORITY_QUERIES[0]}`,
      {
        limit: 5,
        sources: ["web"],
        country: "CH",
        location: "Engadin, Graubunden, Switzerland",
        ignoreInvalidURLs: true,
      },
    )
  ),
);
rows.push(
  summarizeHits(
    "engadin-priority-domains",
    "search site queries",
    engadinSiteQueries.flat(),
  ),
);

const civicPdfSearch = await firecrawlSearch(
  "Pontresina Gemeinderat Protokoll PDF Sitzung",
  {
    limit: 10,
    sources: ["web"],
    categories: ["pdf"],
    country: "CH",
    location: "Pontresina, Graubunden, Switzerland",
    ignoreInvalidURLs: true,
  },
);
rows.push(
  summarizeHits("pontresina-civic", "search pdf category", civicPdfSearch),
);

const civicMap = await firecrawlMap("https://www.gemeinde-pontresina.ch", {
  limit: 100,
  includeSubdomains: true,
  search: "protokoll gemeinderat sitzung pdf",
  sitemap: "include",
  ignoreQueryParameters: true,
  country: "CH",
  languages: ["de-CH"],
  timeoutMs: 60_000,
});
rows.push(summarizeUrls("pontresina-civic", "map search", civicMap));

printRows(rows);
