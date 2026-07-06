# Scraping Migration: Firecrawl → Crawl4AI (self-hosted API)

Status: proposal (2026-07-03). Implementation is a separate session; this file records the
decision, the evidence, and the required test-suite fixes.

## Recommendation

**Replace Firecrawl with [Crawl4AI](https://github.com/unclecode/crawl4ai) run as a
self-hosted Docker REST service.** Decisive constraint: this repo's scraping runs inside
Supabase Edge Functions (`civic-execute`, `civic-extract-worker`, `ingest` call
`firecrawlScrape()` over HTTP and consume markdown) — the replacement must be an HTTP
endpoint, not a local library. Crawl4AI ships an official Docker server with a REST API
returning markdown (an architectural drop-in for the Firecrawl calls); Scrapling is a
Python library/CLI with no hardened scrape server, so despite tying Crawl4AI at 100% in
the benchmark it does not fit the edge-function architecture. Change-tracking (the one
Firecrawl feature Crawl4AI lacks) can move in-house — `00060_web_canonical_hash_baselines`
shows content-hash baselines already exist in this schema.

## Why

Benchmarked 2026-07-03 in `tools/benchmarks` (report: `public/index.html`, data:
`results/combined-current.json`) across 8 civic/registry cases — the 4 original benchmark
sources plus 4 taken from this repo's own `scripts/benchmarks/benchmark-civic.ts` suite
(Bern Stadtrat, Bozeman City Commission, Madison Common Council, Zermatt Gemeinde):

| Tool | Coverage (8 cases) | Notes |
|---|---|---|
| Scrapling stealthy fetch | **100%** | Only tool besides Crawl4AI to clear the Bozeman CivicPlus bot wall, both Swiss cookie walls, and the Zurich cookie-check redirect. 1.4–5.6s/case. BSD-3, free, local (Camoufox). |
| Crawl4AI | **100%** | Same coverage; Playwright-based, slower startup (4–25s/case). Native Markdown output. |
| Scrapy (generic spider) | 88% | Fastest, but plain HTTP — refused by Bozeman's bot-protected CMS. Bulk server-rendered fetching only. |
| Firecrawl scrape | 79% | Missed probes on Basel and Madison, and returned 437 bytes of image-only markdown on the Zermatt homepage (`--only-main-content` stripped all text). Paid credits per scrape. |

Key points:

- Scrapling strictly dominates Firecrawl on this workload at zero marginal cost, including
  sources where Firecrawl's main-content extraction actively destroys the page.
- Caveats: no managed proxy pool (fetches come from our IP — set per-fetcher proxies if a
  source starts rate-limiting), and Firecrawl's `map`/`search` endpoints are separate
  products not covered by this recommendation (`benchmark-firecrawl-map.ts` keeps its own
  rationale until crawling needs are re-evaluated).

## Firecrawl touchpoints in this repo (audit in the implementation session)

- `frontend/src/lib/setup/setup-generator.ts` and associated tests
  (`frontend/src/tests/…`) reference Firecrawl in generated setups.
- `README.md`, `CLAUDE.md`/`AGENTS.md`, `TRANSPORT-SCOUT-PRD.md` document Firecrawl as the
  fetch layer.
- `scripts/benchmarks/benchmark-firecrawl-map.ts` (map endpoint — out of scope, see above).

## Test-suite rot: fix regardless of migration

`scripts/benchmarks/benchmark-civic.ts` contains 3 dead URLs (verified 2026-07-03). Two
have been 404 since at least 2026-06-01, which silently degraded any scenario built on them:

| Current (dead) | Replacement (live, verified) |
|---|---|
| `https://www.gemeinderat-zuerich.ch/protokolle` (404; also the `DEFAULT_URL` constant, line ~54) | `https://www.gemeinderat-zuerich.ch/sitzungen/termine/` |
| `https://www.lausanne.ch/officiel/autorites/conseil-communal/seances-et-pv.html` (404) | `https://www.lausanne.ch/officiel/conseil-communal/seances/seances-et-ordres-du-jour.html` |
| `https://www.bern.ch/politik-und-verwaltung/stadtrat/sitzungen` (redirect loop, defeats even stealth browsers) | `https://stadtrat.bern.ch/de/sitzungen/` |

Also recommended: add a liveness guard to the suite (fail a scenario on 404/redirect-loop
instead of scoring whatever the error page returns) — the benchmarks repo found that 404
pages can pass keyword checks via nav chrome and URL echoes.
