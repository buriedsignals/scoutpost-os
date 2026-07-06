# Scraping Migration PRD — Firecrawl → Crawl4AI + pdftotext (self-hosted scrape-service)

**STATUS: APPROVED (Tom, 2026-07-03, via `/loop` launch). Executing under the Loop Execution Contract.**

Companion decision record: `SCRAPING_MIGRATION.md` (2026-07-03). This PRD is the loop-executable
work order that implements it. Audit evidence gathered 2026-07-03 (repo sweep + production DB +
`tools/benchmarks` results); every file:line below was verified in that audit.

---

## Summary

Remove Firecrawl as a dependency across Scoutpost. Web/HTML scraping and civic PDF parsing move
to **one self-hosted `scrape-service`**: a thin in-repo FastAPI container bundling the
**Crawl4AI** library (Playwright render → markdown/html, `POST /scrape`) and **poppler
`pdftotext`** (embedded-text PDF extraction, `POST /parse` — parity with Firecrawl's production
`pdfMode:"fast"`, which never OCR'd), deployed as a single Render Standard service. Docling is
NOT in v1: on every benchmark case both ran it tied pdftotext at 100% while costing a PyTorch
stack; it remains the evidence-gated upgrade path if U3's real-fixture gate fails. Remote
changeTracking is retired in favor of the in-house canonical-hash baselines that already exist
(migration `00060`, `_shared/web_content_canonical.ts`) — extended from per-scout (web) to
per-(scout, URL) (civic). Firecrawl `search` is retired (Exa is already Beat's default retrieval
port); Firecrawl `map` is replaced by an in-house sitemap + link-harvest mapper. The final unit
deletes `FIRECRAWL_API_KEY` from every runtime, config, and doc surface.

Benchmarked motivation (`tools/benchmarks`, 2026-07-03, 8 civic/registry cases): Crawl4AI 100%
coverage vs Firecrawl 79% (Firecrawl misses Basel and Madison probes and strips Zermatt to 437
bytes of image-only markdown via `onlyMainContent`). PDF: pdftotext and Docling both 100%, local
and free, vs paid Fireparse 100%. Firecrawl costs paid credits per scrape and forces OSS
self-hosters to buy a key; the replacement stack is fully open-source (Apache-2.0 / MIT / GPL
binary via subprocess).

---

## Audit Baseline (verified 2026-07-03)

**Architecture facts:**
- Exactly ONE production Firecrawl client: `supabase/functions/_shared/firecrawl.ts` (640 lines).
  All 13 production call sites across 8 edge functions + 3 shared helpers route through it.
- `supabase/functions/scouts/_bundled.ts` is auto-generated (`scripts/ops/bundle-ef.ts`), git-ignored.
  Migrate the source, re-bundle — never edit it.
- The FastAPI backend has **no** Firecrawl HTTP client (CLAUDE.md:283's `firecrawl_client.py` /
  `data_extractor.py` mapping is stale upstream-cojournalist doc rot — those files do not exist).
  Backend footprint: `config.py:78-79` (key), `models/responses.py:86` (provider regex),
  `routers/v1.py:358` (provider default), 2 standalone diagnostic scripts.
- `cli/` and `mcp/`: zero Firecrawl references.

**Production state (prod DB, 2026-07-03):**
- All 61 web scouts are `provider='firecrawl_plain'` (in-house hash baselines). **Zero** legacy
  `provider='firecrawl'` scouts remain — web changeTracking retirement is already complete in data.
- 19 civic scouts (17 active) still depend on remote changeTracking per tracked URL
  (`civic-execute/index.ts:241`, tag `civic-${scout.id}-${shortHash(url)}`).
- Volume is small: 264 scout runs/7 days (web 182, beat 39, social 26, civic 17). Even with
  subpage/document fan-out this is well under ~200 scrapes/day — a single small instance suffices.

**Test/coverage state:**
- Backend pytest: 436 passed / 2 skipped. Frontend vitest: 265 passed. Deno CI set
  (`_shared/` + `scout-transport-execute/`): 326 passed.
- `_shared/firecrawl.ts` coverage: **44.8% line / 57.5% branch** — the module being replaced is
  the worst-covered critical path. Replacement modules get a 100% bar (they are pure HTTP
  clients, fully stubbable).
- `civic-execute`, `civic-extract-worker`, `ingest` `_test.ts` are integration tests gated on a
  live Supabase stack (`_shared/_testing.ts:23-27` throws without `SUPABASE_URL`/`API_URL`).
  **No CI job runs them today.**
- Benchmark rot: `scripts/benchmarks/benchmark-civic.ts` has 3 dead URLs (Zurich `DEFAULT_URL`,
  Lausanne, Bern — see `SCRAPING_MIGRATION.md` for verified replacements). Dead since ≤2026-06-01;
  404 chrome can pass loose keyword probes.

**Benchmark evidence** (`tools/benchmarks/results/combined-current.json`, report `public/index.html`):

| Category | Winner (open-source) | Score | Firecrawl | Notes |
|---|---|---|---|---|
| Scraping (8 civic/registry cases) | Crawl4AI | 100% | 79% | Crawl4AI clears Bozeman CivicPlus bot wall + both Swiss cookie walls; 4–25s/case (cold CLI starts — server keeps warm pool) |
| Scraping (runner-up) | Scrapling stealthy fetch | 100% | — | Rejected: Python lib/CLI, no hardened HTTP server → doesn't fit edge-function architecture |
| PDF extraction (3 cases) | Poppler pdftotext & Docling (tie) | 100% | 100% (paid Fireparse) | pdftotext ~34–190ms/doc, 10MB binary; Docling 21–37s/PDF + PyTorch. liteparse (head-to-head 2026-07-03): 6/6 probes, 1.6–5.3s |
| PDF (rejected) | Marker 0% (timeout), Surya OCR 83% (194s), LangExtract 83%, LlamaParse (paid, 131s) | | | |
| Reference | Tow Center Scraper Factory | 29% | — | LLM-generates per-source Playwright scrapers; strong *structured* output, weak *content preservation*. Its test→refine loop pattern informs our parity harness; the architecture (per-source generated scrapers + MongoDB registry) does not fit Scoutpost's generic-scrape edge runtime. Not adopted. |

**PDF evidence caveat:** the benchmark PDF set is 3 born-digital manuals, not council minutes —
and on it, pdftotext tied Docling at 100% while being 200-400× faster with no ML runtime. More
decisive: production already stores Firecrawl's historical markdown for every processed civic doc
(`raw_captures.content_md`), so U3 scores the replacement against *actual production output* on
real council PDFs before cutover. That is the honest path to "100% confidence", not the 3-case set.

---

## Requirements

- **R1 — Scrape port.** All production scraping routes through a provider-agnostic port in
  `_shared/` preserving the existing contract: `ScrapeResult { markdown, html?, rawHtml?, title?,
  metadata?, requested_url?, source_url, fetched_at }` (`firecrawl.ts:18-27`), the
  `scrapePrimaryPageResilient` strategy ladder (`:490-594`), and the transient-error taxonomy
  (`:614-630`). Follow the established retrieval-port pattern (`docs/architecture/retrieval-ports.md`,
  `_shared/exa.ts:235-249`).
- **R2 — Crawl4AI provider.** Default scrape provider is the self-hosted scrape-service
  (`POST /scrape`, Crawl4AI lib inside). Env: `SCRAPE_PROVIDER=crawl4ai|firecrawl` (kill-switch
  during bake), `SCRAPE_SERVICE_URL`, `SCRAPE_SERVICE_TOKEN` (bearer auth mandatory — the service
  fetches arbitrary URLs and must not be an open proxy).
- **R3 — PDF port.** Civic document parsing routes through a doc-parse port targeting the
  scrape-service's `POST /parse` (poppler `pdftotext -layout`, URL in → text/markdown out, plus a
  text-density guard returning a structured `needs_ocr` error for bitmap-only documents). A
  content-type dispatcher (HEAD/sniff) routes PDF → `/parse`, HTML → `/scrape`, replacing
  Firecrawl's transparent `parsers:[{type:"pdf",mode:"fast"}]` default (`firecrawl.ts:63-66`).
  This is deliberate parity: production has always used embedded-text extraction, never OCR
  (the `pdfMode:"fast"` comment documents the anti-hallucination choice). The OCR/layout upgrade
  (Docling sidecar or Gemini native PDF ingestion) is gated on U3's real-fixture evidence, not
  assumed.
- **R4 — changeTracking retirement.** Civic change detection moves to per-(scout_id, source_url)
  canonical-hash baselines on `raw_captures` (schema already fits: `scout_id`, `source_url`,
  `canonical_content_sha256`, `canonicalizer_version`). `firecrawlChangeTrackingScrape`,
  `doubleProbe`, and `change_status` consumption from remote are deleted. The civic "removed"
  signal (`civic-execute/index.ts:261-269`) is re-derived from HTTP status (404/410), not provider
  change_status.
- **R5 — map replacement.** Civic discover (`civic/index.ts:147`, the only production `map` user)
  moves to an in-house mapper: sitemap.xml (+ robots.txt Sitemap:) parse, falling back to a
  root-page link harvest via the scrape port. Output stays `string[]` (≤200, includeSubdomains
  semantics preserved) feeding the existing Gemini ranking, which tolerates noisy candidates.
- **R6 — search retirement.** `firecrawlSearch` is deleted. `beat-search/index.ts:164` ports to
  the existing Exa client (`_shared/exa.ts` already models `SearchHit` as a superset). The Beat
  retrieval-port fallback `BEAT_RETRIEVAL=firecrawl` (`beat_pipeline.ts:570,590-614`,
  `scout-beat-execute:178-180,439,641-646`) is removed; Exa becomes the only Beat retrieval port.
- **R7 — kill-switch + bake.** Units land dark (default provider stays `firecrawl`) until U7 flips
  the default in production. Firecrawl code and key survive through the bake window and are deleted
  only in U8 after the parity gate passes.
- **R8 — coverage bar.** New `_shared` adapter modules (scrape port, crawl4ai client, docparse
  client, mapper, dispatcher): **100% line coverage** via `deno coverage` (enforced in CI for
  those files). The existing contract test `_shared/firecrawl_test.ts` (stubbed `globalThis.fetch`)
  is generalized to run against BOTH providers. All env-gated function integration tests
  (`civic-execute`, `civic-extract-worker`, `ingest`, `scout-web-execute`, `scout-beat-execute`,
  `scouts`) get a CI job backed by `supabase start` (supabase/setup-cli action) so the
  firecrawl-touching functions are exercised in CI for the first time.
- **R9 — live parity gate.** Before U7's flip: repaired `scripts/benchmarks/benchmark-civic.ts` +
  `benchmark-web.ts` + the 8-case `tools/benchmarks` scraping set run against the deployed
  scrape-service path and must score ≥ the recorded Firecrawl baseline per case. PDF: `/parse`
  ≥ recorded Firecrawl markdown quality on the real-council-PDF fixture set (U3). Benchmarks run
  through the user-authenticated product path per
  `docs/solutions/workflow-issues/benchmark-auth-model.md`.
- **R10 — OSS/self-host.** `deploy/docker/docker-compose.yml` gains the `scrape-service`
  container (removing the paid-key requirement — a headline OSS win); `selfhost/setup*.sh`,
  `deploy/installer/*`, `deploy/SETUP.md`, `frontend/src/lib/setup/setup-generator.ts:25-149` and
  its tests drop the Firecrawl key prompt; `scripts/ops/strip-oss.sh:164` (`.firecrawl/` cleanup)
  updated. OSS mirror validation must stay green.
- **R11 — semantics preserved.** Credits decremented before scrape work and refunded on failure
  (unchanged — credits are per-run, not per-scrape); error classes still map to
  `errorClass:"provider"` (`run_lifecycle.ts:286` string match generalized); civic diagnostics
  upstream-status parsing (`civic_diagnostics.ts:19-26`) generalized; timeout constants preserved
  (`PRIMARY_SCRAPE_TIMEOUT_MS=25_000`, `SUBPAGE_SCRAPE_TIMEOUT_MS=12_000`, stagger 2000ms).
- **R12 — docs truth.** All 40+ doc references (§10 of the audit, listed in Sources) updated in
  the unit that changes the behavior they describe, not in a big-bang doc pass; U8 does the final
  sweep + fixes the stale CLAUDE.md:283 backend mapping.

---

## Key Technical Decisions

- **KTD1 — Refactor in place, don't parallel-build.** `_shared/firecrawl.ts` becomes
  `_shared/scrape.ts` (port + types + resilient orchestrator + error taxonomy) with two provider
  modules: `_shared/scrape_firecrawl.ts` (moved code, deleted in U8) and `_shared/scrape_crawl4ai.ts`
  (new). Exported names generalize (`scrape()`, `isTransientScrapeError()`) with deprecated
  re-export aliases kept until U8 so the 13 call sites migrate incrementally, not atomically.
- **KTD2 — Response mapping happens server-side.** The scrape-service maps Crawl4AI's CrawlResult
  to the `ScrapeResult` JSON shape before returning: `markdown.raw_markdown → markdown` (never
  fit_markdown — the Zermatt failure is exactly what main-content filtering does), `html → rawHtml`,
  `cleaned_html → html`, `metadata.title → title`, `metadata → metadata` (keep `sourceURL`-equivalent
  keys so `atomic_extract.ts:280+` publication-date fallback keeps working), plus `status_code` for
  4xx/removed semantics. The Deno adapter stays a thin authenticated HTTP client. Non-OK /
  `success:false` → `ApiError(502)`; timeout/abort → `ApiError(504)` — identical taxonomy so
  `isTransientScrapeError` logic transfers verbatim. The API contract is ours and versioned in-repo,
  which removes upstream-API-drift risk from the adapter side.
- **KTD3 — Civic per-URL hash baselines.** Reuse `canonicalizeWebMarkdown`/`webCanonicalHash`
  (`web_content_canonical.ts`) — bump nothing; civic pages are ordinary web pages. New
  `hashChangeStatusForUrl(svc, scoutId, sourceUrl, markdown)` generalizing
  `scout-web-execute/index.ts:1454-1540` to filter baselines by `source_url`. Baseline established
  at scout creation (replacing `scouts/index.ts:665`) and advanced on successful runs, mirroring
  web semantics. Migration adds index on `raw_captures(scout_id, source_url, captured_at)` partial
  on `canonical_content_sha256 IS NOT NULL`. First post-cutover civic run per URL is a silent
  baseline (no change fired) — same discipline as web.
- **KTD4 — pdftotext for PDFs; Docling deferred on evidence.** `civic-extract-worker/index.ts:275`
  and `civic_preview.ts:73` keep calling one `parseDocument(url)` function; inside, HEAD
  content-type (fallback: GET sniff of magic bytes `%PDF`) routes to `/parse` or `/scrape`.
  The parser is poppler `pdftotext -layout` — exactly the benchmarked tool (100% on every case,
  ~100ms/doc) and functionally equivalent to Firecrawl's production `pdfMode:"fast"`. Rationale
  against Docling in v1: (a) zero benchmark evidence of superiority — they tied on every shared
  case; (b) torch adds ~2-3GB image + 1-2GB resident RAM, which is what made a single 2GB Render
  service risky; (c) production civic scouts have never had OCR, so scanned docs are already
  unparsed today — not a regression. Determinism also matters: civic dedup keys on content hashes
  (`content_sha256`), so the stored text must be reproducible — which rules out LLM transcription
  as the primary parser. A text-density guard (`chars/page` threshold) surfaces scanned docs as
  structured `needs_ocr` failures so U3/production *measure* the real scanned share. Upgrade
  paths if the gate fails: Docling sidecar service, or Gemini native PDF ingestion (already a
  platform dependency, suitable for the OCR-fallback tier only) — decision deferred to that evidence.
- **KTD5 — Hosting: one custom scrape service on Render (decided 2026-07-03).** A single new
  Render Standard web service (~$25/mo, 2GB, Frankfurt) running a thin FastAPI app bundling the
  **Crawl4AI Python library** (Playwright pool capped at 2 for our volume) and **poppler-utils**,
  exposing `POST /scrape` and `POST /parse` behind a single bearer token. One deploy, one URL,
  one token; no VPS to maintain, no ML runtime. Without torch, memory math fits 2GB comfortably:
  FastAPI ~100MB + 2×Chromium ~700MB + page-render spikes ~500MB + pdftotext negligible. Source
  lives in-repo at `scrape-service/` (Dockerfile + ~150 lines of glue), deployed via `render.yaml`
  next to `scoutpost`. Wrapping the *library* is also closer to the benchmarked configuration
  than the official Docker REST server (the benchmark ran `crwl`, the lib CLI). Edge functions
  reach it over the public internet; the token lives in Supabase function secrets. The adapter
  modules target this service's API — endpoint shapes are ours, versioned in-repo, so upstream
  REST-API drift cannot break the Deno side.
- **KTD6 — Search is deleted, not replaced.** Exa is already the default Beat retrieval and
  models the same `SearchHit` shape. Losing the Firecrawl fallback means an Exa outage degrades
  Beat with no fallback — accepted (Decision 3 records the SearXNG option as future work).
- **KTD7 — Benchmark-first ordering.** U1 repairs the rotted benchmark URLs and records a
  Firecrawl baseline BEFORE any code changes, because the parity gate (R9) is meaningless against
  dead cases, and post-migration Firecrawl re-runs cost credits we won't want to spend.
- **KTD8 — Provider enum.** `scouts.provider` CHECK (`00002_tables.sql:25`) currently allows
  `('firecrawl','firecrawl_plain')`. U8 migrates values `firecrawl_plain → 'canonical'`, drops
  `'firecrawl'` (zero rows), updates `responses.py:86` regex (accept old value on input for API
  compat), `v1.py:358` default, and the frontend/backend tests that assert the literal. This is
  cosmetic but the objective is *zero* grep hits for firecrawl outside git history.
- **KTD9 — Scraper Factory verdict.** Reviewed (repo cloned 2026-07-03). Its useful idea is the
  generate→test→refine loop with schema-driven validation, which this PRD encodes as the parity
  harness + per-unit test gates. Its core architecture (LLM-generated per-source scrapers,
  MongoDB registry, daily batch) solves a different problem (structured records from known
  sources) and scored 29% on content preservation — not adopted as runtime.
- **KTD10 — Adversarial alternatives sweep (2026-07-03, pre-approval).** Every architecture that
  avoids a self-hosted HTTP service was evaluated and killed on facts:
  (a) *In-edge-function scraping* (Deno fetch + HTML→md): plain-HTTP tools cap at 88% on the
  benchmark (bot-walled CMS refuses raw HTTP), no browser can run in a Supabase isolate
  (256MB/CPU limits), and JS-rendered user URLs would silently regress web-scout hash baselines.
  Viable later as a fetch-first *optimization* in front of the service, never as the sole path.
  (b) *Self-hosted Firecrawl*: exists, but AGPL, a heavy multi-container stack (Redis + workers +
  Playwright services), and — decisive — it inherits the 79% extraction quality; hosting was
  never Firecrawl's problem, extraction was. (c) *Managed browser APIs* (Browserless, Browserbase,
  Cloudflare Browser Rendering): re-introduce a paid vendor key, killing the OSS win — the
  objective, not the price, rules them out. (d) *Exa contents as scraper*: 79% benchmarked, paid.
  (e) *GitHub Actions runners*: minutes of queue latency breaks the synchronous test-scrape and
  ingest UX (`scouts/index.ts:1494`), and shared datacenter IPs score worse against bot walls.
  (f) *Mac mini + tunnel*: $0 and a residential IP, but a home-network SPOF under a revenue SaaS —
  acceptable for dev/staging only. (g) *Fly.io scale-to-zero*: genuinely cheaper (~$3-5/mo
  effective) but adds a second cloud vendor and machine-boot cold starts against the 25s primary
  scrape timeout; rejected for operational consolidation in Render, not on price.
  Conclusion: an authenticated, self-hosted browser-rendering HTTP service is the only
  architecture satisfying open-source + synchronous + arbitrary-URL + bot-wall constraints.

---

## High-Level Technical Design

```
Edge Functions (Supabase cloud)
  civic-execute ──┐
  civic-extract-worker ─┐(parseDocument)      ┌─→ POST /scrape (Playwright render → md/html)
  scout-web-execute ──┤                        │
  scout-beat-execute ─┼─→ _shared/scrape.ts ──┤  scrape-service (Render Standard, bearer token)
  beat-search ────────┤   (port + dispatcher)  │  FastAPI + Crawl4AI lib + poppler pdftotext
  ingest ─────────────┤                        │
  scouts, civic ──────┘                        └─→ POST /parse (PDF → text, density guard)
  change detection: raw_captures canonical hashes (in-house, per scout[, url])
  search: _shared/exa.ts (existing)          map: _shared/site_map.ts (sitemap + link harvest)
```

New env/secrets (Supabase function secrets + OSS compose): `SCRAPE_PROVIDER`,
`SCRAPE_SERVICE_URL`, `SCRAPE_SERVICE_TOKEN`. Deleted in U8: `FIRECRAWL_API_KEY`,
`SCOUT_ALLOW_PROD_FIRECRAWL`, `BEAT_RETRIEVAL=firecrawl` support.

---

## System-Wide Impact

- **OSS self-host** gains one container (`scrape-service`, ~1.5-2GB RAM with Playwright, no ML
  runtime, default-on) but loses its only mandatory paid scraping key.
  `selfhost/docker-install-entrypoint.sh`, installer manifest schema
  (`setup-from-manifest.sh:47` requires `firecrawl_api_key`) and `setup-generator.ts:149`
  (`require(...)`) all change — manifest field becomes optional/removed with a compat shim.
- **Latency:** Crawl4AI warm-server render ≈ Firecrawl latency; pdftotext ~100ms/PDF is absorbed
  trivially by the existing 2-min queue worker cadence. First-request cold start mitigated by the
  warm Playwright pool.
- **`run_lifecycle.ts:286`** classifies provider errors by matching `"firecrawl"` in messages —
  generalized to match the new adapter's error prefix, else provider-refund semantics silently break.
- **Weekly benchmarks** (`.github/workflows/weekly-scout-benchmarks.yml:31`) drop
  `SCOUT_ALLOW_PROD_FIRECRAWL`; spend guard in `_bench_shared.ts:187-192` becomes a guard on the
  self-hosted endpoint (still guards Exa/LLM spend).
- **Backend diagnostic scripts** (`benchmark_ct_tags.py`, `benchmark_web_diagnostic.py`) exist
  solely to probe Firecrawl changeTracking → deleted in U8, not ported.
- **Bundled function**: any unit touching `scouts/index.ts` or `_shared/*` must re-run
  `scripts/ops/bundle-ef.ts` before deploy.

---

## Implementation Units

**Merge model (revised by Tom, 2026-07-03):** all units are developed as stacked commits on
one long-lived branch (`scrape-u1`) in the `scoutpost-scrape` jj workspace, with PR #262 kept
open as the running CI surface (every push re-runs the full check suite on the whole stack).
There are exactly TWO merges: (1) after U6 — Tom merges PR #262, deploying all code DARK
(`SCRAPE_PROVIDER` still `firecrawl`); (2) after U7's bake passes — a small final U8 cleanup
PR. U7 itself is operations only (secrets flip + monitoring), no code merge. Greptile is
REMOVED from the flow (trial expired; Tom 2026-07-03) — each unit instead gets a local
multi-agent review pass (8 finder angles + fix) before its commit is finalized. Never push
to `main`. Dependency order: U1 → U2 → {U3, U4, U5} → U6 → U7 → U8.

### U1. Benchmark repair + recorded Firecrawl baseline + scrape-service (local)
- **Goal:** trustworthy parity harness, a frozen pre-migration baseline, and the in-repo
  scrape-service running locally for every later unit's verification.
- **Files:** `scripts/benchmarks/benchmark-civic.ts` (3 dead URLs → live replacements per
  `SCRAPING_MIGRATION.md` table, incl. `DEFAULT_URL` ~line 54; add liveness guard: scenario fails
  on 4xx/redirect-loop instead of scoring error-page chrome); new `scrape-service/` (FastAPI app:
  `POST /scrape` via Crawl4AI lib with warm browser pool capped at 2, `POST /parse` via poppler
  `pdftotext -layout` + text-density guard (`needs_ocr` structured error),
  `GET /health`, bearer-token middleware, KTD2 server-side mapping; `Dockerfile` with pinned
  Playwright/Chromium, pinned `crawl4ai` version, `poppler-utils`; own pytest suite — 100% coverage on
  routing/auth/mapping, live-render tests marked and run locally); `scripts/dev/scrape-stack.sh`
  (build + run the container locally, healthcheck wait); new
  `scripts/benchmarks/record-scrape-baseline.ts` (runs the 8-case set + civic/web suites via
  the product path against Firecrawl, stores per-case markdown + scores under
  `scripts/benchmarks/baselines/firecrawl-2026-07/`); CI: scrape-service pytest job (unit tier only).
- **Test scenarios:** liveness guard turns a 404 case red (prove with a knowingly-dead URL);
  repaired URLs pass their page-specific probes; baseline artifacts committed and deterministic
  (URL, sha256, probe scores per case); scrape-service: authenticated /scrape on a repaired civic
  URL returns markdown passing its probes; /parse on a known council PDF returns non-empty
  markdown; unauthenticated requests 401.
- **Verification:** one paid Firecrawl baseline run (cap: one full suite pass, ~30 scrapes);
  `scripts/dev/scrape-stack.sh` healthy on Apple Silicon and linux/amd64 (`docker buildx`).

### U2. Scrape port + Crawl4AI provider (lands dark)
- **Goal:** `_shared/scrape.ts` port with `firecrawl` (moved) and `crawl4ai` (new) providers;
  default `firecrawl`; all 13 call sites compile against the port via re-export aliases.
- **Files:** `_shared/scrape.ts` (types, dispatcher, `scrapePrimaryPageResilient` ladder moved
  from `firecrawl.ts:490-594`, `isTransientScrapeError`, `warningForScrapeError`);
  `_shared/scrape_crawl4ai.ts` (thin bearer-auth client for scrape-service `/scrape`; KTD2
  mapping asserted, not performed; `AbortController` fuse identical to `firecrawl.ts` behavior);
  `_shared/scrape_firecrawl.ts` (moved, unchanged behavior);
  `_shared/firecrawl.ts` becomes deprecated re-exports; rename tests →
  `_shared/scrape_test.ts` parameterized over both providers + `_shared/scrape_crawl4ai_test.ts`
  (stubbed fetch, every branch); `run_lifecycle.ts:286` + `civic_diagnostics.ts:19-26`
  generalized; `.github/workflows/ci.yml`: (a) add `deno coverage` gate = 100% line on
  `_shared/scrape*.ts`, (b) add `supabase start`-backed function-test job running
  `civic-execute/ civic-extract-worker/ ingest/ scout-web-execute/ scout-beat-execute/ scouts/`
  `_test.ts` (not yet in the required set).
- **Test scenarios:** contract parity — same stubbed page yields identical `ScrapeResult` from
  both providers; ladder strategies (combined → retry → split → markdown_only) exercised per
  provider; transient classification table-tested (429/5xx/timeout/abort vs 4xx/unsupported-file);
  scrape-service `success:false` and non-JSON body → `ApiError(502)`; metadata date keys survive
  for `sourcePublishedDate`.
- **Verification:** full local-stack function tests green; live smoke against the U1 local
  container: `deno run` a script scraping 3 of the repaired civic URLs through
  `SCRAPE_PROVIDER=crawl4ai`, probes pass; prod behavior unchanged (provider default still
  firecrawl); re-bundle `scouts`.

### U3. Doc-parse port + pdftotext cutover + civic PDF fixture gate (dark)
- **Goal:** `parseDocument(url)` with content-type dispatch; civic worker and preview consume it;
  real-council-PDF fixture gate proves the parser ≥ recorded Firecrawl output — or escalates the
  OCR decision to Tom with measured evidence.
- **Files:** `_shared/docparse.ts` (thin client for scrape-service `/parse`) + tests (100% bar);
  `civic-extract-worker/index.ts:275` and `_shared/civic_preview.ts:73` switch to the port;
  fixture builder `scripts/benchmarks/build-civic-pdf-fixtures.ts` (pulls 15-20 distinct
  `civic_extraction_queue`/`raw_captures` PDF source URLs from prod, mixed Swiss/US; the recorded
  baseline is **`raw_captures.content_md`** — Firecrawl's actual historical production markdown
  for those same documents, so the comparison is against what production really produced);
  scoring script comparing **two candidates** — poppler `pdftotext -layout` and
  `@llamaindex/liteparse` (Apache-2.0, pure JS, "spatial text extraction"; head-to-head
  2026-07-03: both 6/6 probes on the benchmark PDFs, poppler 10-30× faster at 51-191ms vs
  1.6-5.3s) — on probes derived from the recorded markdown + Gemini-extraction spot-check (same
  promises extracted from both texts on 3 fixtures). Winner ships behind `/parse`; pre-registered
  tiebreak = poppler (speed, maturity, benchmark provenance). LlamaParse (cloud) excluded
  outright: paid per page, 131s/doc benchmarked, violates the open-source objective.
- **Test scenarios:** dispatcher routes `%PDF` magic bytes and `application/pdf` content-type to
  `/parse`, HTML to `/scrape`, HEAD-failure falls back to sniff; `/parse` non-200/timeout →
  transient taxonomy; `needs_ocr` density-guard error → non-transient, logged distinctly (this is
  the scanned-share measurement); empty text → throws (preserving `:277` behavior);
  `append_processed_pdf_url_capped` only on success (regression: migration 00031's silent-loss fix).
- **Verification / gate:** fixture run: winning parser ≥ recorded Firecrawl on every fixture,
  deltas reviewed by hand in the PR description; scanned share reported (count of `needs_ocr`
  fixtures). **If any fixture regresses vs production markdown or the scanned share is material →
  HARD STOP:** present Tom the Docling-sidecar vs Gemini-native-PDF options with the measured
  data. Otherwise merge; prod still dark.

### U4. changeTracking retirement — civic per-URL hash baselines
- **Goal:** no code path needs remote `change_status`; civic change detection = canonical hashes.
- **Files:** migration `000XX_civic_canonical_baselines.sql` (index per KTD3; backfill baselines
  from latest usable `raw_captures` row per (scout, tracked URL) where present);
  `_shared/web_scout_baseline.ts` → generalized baseline module (drop `doubleProbe` paths `:69,:98,:107`);
  `civic-execute/index.ts:241-269` → fresh scrape + `hashChangeStatusForUrl`; "removed" derived
  from 404/410 status; `scouts/index.ts:665` (civic baseline at creation) + `:1494-1529`
  (test-scrape: drop `doubleProbe`, provider detection collapses); delete
  `firecrawlChangeTrackingScrape` + `doubleProbe` + `ChangeTrackingResult` from the port;
  scout-web-execute legacy branch `:470-491` + `markScoutCanonicalProvider:1272-1281` removed
  (prod has zero legacy rows — verified); update `_test.ts` suites accordingly; re-bundle.
- **Test scenarios:** civic run with unchanged page → no docs enqueued, baseline stable; changed
  page → docs enqueued, baseline advances only on successful run; 404 URL → failure accounting
  (`scrapeFailureCount`, `allTrackedUrlsAre4xx` outcome) unchanged; silent first baseline per URL;
  two tracked URLs with independent baselines don't cross-contaminate; creation-time baseline
  written for every confirmed URL.
- **Verification:** local-stack civic end-to-end (create → run → change → run) with the local
  scrape-service; one prod civic scout manually re-run post-merge (still on Firecrawl scrape
  provider — hash logic is provider-independent) and observed correct same/changed behavior for
  2 cycles.

### U5. map + search retirement
- **Goal:** zero call sites for `firecrawlMap`/`firecrawlSearch`.
- **Files:** new `_shared/site_map.ts` (+100%-covered test): robots.txt `Sitemap:` → sitemap.xml
  (index + urlset, ≤200, same-registrable-domain filter with subdomains) → fallback root-page link
  harvest via scrape port; `civic/index.ts:147` consumes it; `beat-search/index.ts:164,403` ports
  search to `_shared/exa.ts` (scrape stays on the port); remove retrieval-port firecrawl branches
  `beat_pipeline.ts:570,590-614`, `scout-beat-execute:178-180,236,439,641-646`;
  `beat_ab_logger.ts:4,127` type narrows to `"exa"`; delete `firecrawl_search_test.ts`, update
  `exa_test.ts`/`beat_pipeline_test.ts`; docs `docs/architecture/retrieval-ports.md`,
  `docs/features/beat.md` civic/beat sections.
- **Test scenarios:** sitemap-index recursion, gzip sitemaps, missing sitemap → harvest fallback,
  malformed XML → fallback not crash; civic discover returns candidates for the 4 repaired civic
  benchmark sources comparable to recorded `firecrawlMap` output (U1 baseline includes one
  recorded map run per source); beat-search Exa path returns hits with dates; kill-switch env
  `BEAT_RETRIEVAL=firecrawl` now logs a deprecation warning and uses Exa.
- **Verification:** civic discover live parity on 4 sources (candidate sets overlap on the pages
  that matter — the Gemini-ranked top hits); benchmark-beat offline suite green.

### U6. Production + OSS infrastructure
- **Goal:** scrape-service deployed on Render, authenticated, reachable from Supabase; OSS
  compose parity.
- **Files/actions:** root `render.yaml` gains the `scrape-service` web service (Docker runtime,
  Standard plan, Frankfurt, `healthCheckPath: /health`, `SCRAPE_SERVICE_TOKEN` env, autodeploy
  from `main` with `dockerfilePath: ./scrape-service/Dockerfile`); token generated and set via
  `supabase secrets set SCRAPE_SERVICE_URL=… SCRAPE_SERVICE_TOKEN=…`; runbook
  `docs/architecture/scrape-service.md` (token rotation, monthly `crawl4ai`/Playwright
  version-bump cadence, Render alerting on health-check failures); OSS:
  `deploy/docker/docker-compose.yml` + `.env.example` add the `scrape-service` container
  (built from `scrape-service/`, default-on) and drop the `FIRECRAWL_API_KEY` requirement
  (`:34,38,86,143`); `deploy/render/render.yaml:42`, `deploy/installer/*`, `deploy/SETUP.md`,
  `selfhost/setup.sh:169-373`, `selfhost/setup-from-manifest.sh` (manifest `firecrawl_api_key`
  becomes optional/ignored with a compat shim), `selfhost/SETUP_AGENT.md`, `SKILL.md`;
  `frontend/src/lib/setup/setup-generator.ts:25-149` + `frontend/src/tests/setup-generator.test.ts`,
  `setup-page.test.ts`; `scripts/ops/strip-oss.sh` check; `selfhost/selfhost_maintenance_test.ts`.
- **Test scenarios:** setup-generator emits manifests without firecrawl key and validates old
  manifests (compat shim); selfhost maintenance test green; OSS mirror validation green.
- **Verification:** from a Deno script using the function-secret values: authenticated `/scrape`
  and `/parse` round-trips against the deployed Render service; unauthenticated requests 401;
  memory headroom observed on a 5-concurrent-scrape burst (Render metrics);
  `selfhost/selfhost-doctor.sh` passes against a scratch OSS install with the new compose.

### U7. Flip + bake + parity gate
- **Goal:** production runs on the scrape-service; evidence recorded.
- **Actions:** set `SCRAPE_PROVIDER=crawl4ai` in prod function secrets; run the full live parity
  suite (R9) via `scripts/benchmarks/with-linked-supabase-env.sh`; compare per-case against U1
  baseline; bake **7 days** (one full weekly-benchmark cycle + all civic dailies): monitor
  `scout_runs` error classes, `scrape_warning` metadata, notification volume anomalies; keep
  `SCRAPE_PROVIDER=firecrawl` rollback documented and tested once (flip back, one web run, flip
  forward).
- **Gate:** every parity case ≥ baseline score; zero new `errorClass:"provider"` regressions
  attributable to the stack across the bake window; civic scouts produce expected diffs (spot-check
  3 scouts' runs by hand).
- **Hard stop:** any parity case regresses → halt, diagnose, do NOT proceed to U8.

### U8. Firecrawl deletion + docs sweep
- **Goal:** `grep -ri firecrawl --exclude-dir=.git` returns only git-history/CHANGELOG/PRD-archive hits.
- **Files:** delete `_shared/scrape_firecrawl.ts`, deprecated `_shared/firecrawl.ts` aliases,
  `firecrawl_test.ts` remnants; provider enum migration per KTD8 (`00002` CHECK → `('canonical')`
  mapping `firecrawl_plain→canonical`; `responses.py:86`, `v1.py:358`, backend tests
  `test_execution_storage.py:47`, `test_schedule_service.py:318,335`, `test_v1_endpoints.py:320,323`,
  frontend `webhook-client.test.ts:96,106`); delete `backend/scripts/benchmark_ct_tags.py`,
  `benchmark_web_diagnostic.py`, `scripts/audits/audit-firecrawl-*.ts`,
  `audit-beat-firecrawl-permutations.ts`, `scripts/benchmarks/benchmark-firecrawl-map.ts`;
  `_bench_shared.ts:177-192` guard rework; `backend/app/config.py:78-79`; `.env.example:19`;
  weekly workflow env; docs sweep (README:23, CLAUDE.md/AGENTS.md incl. stale `:283` backend
  mapping, `docs/features/{civic,web-scouts,beat}.md`, `docs/supabase/*`, `docs/oss/*`,
  `docs/architecture/*`, threat-assessment-data.json prose); memory/e2e scripts
  (`scripts/ops/e2e-smoke.sh:13`, `scripts/qa-matrix.md:18`); re-bundle; final full test pass.
- **Verification:** grep gate; all four CI required checks + function-test job + OSS mirror green;
  one post-deletion prod run per scout type observed healthy.

---

## Scope Boundaries

**In scope:** everything above. **Out of scope:**
- Scrapling (no HTTP server — recorded as the fallback candidate if a source class defeats
  Crawl4AI stealth; revisit then, not now).
- Social scouts (Apify) and Exa itself — different providers, unaffected.
- Firecrawl `map`/`search` *feature parity* beyond current production use (deep crawling,
  news-source search verticals): we replace what's used, not what Firecrawl offers.
- The Tow Center Scraper Factory runtime model (KTD9).
- Fetch-first optimization in front of the browser service (KTD10a — future).
- OCR (Docling sidecar / Gemini native PDF) unless U3's gate demands it (KTD4).
- AWS-era code paths (`aws/`, historical docs) — migration history only.

---

## Risks & Dependencies

- **Anti-bot regression risk (moderate):** benchmark evidence is 8 cases; production has ~80
  distinct source domains. Mitigations: U7 bake window, per-case parity gate, kill-switch, and
  the documented Scrapling escape hatch. Residential-proxy needs would be new spend — flagged, not built.
- **Scanned-PDF risk (low, measured not assumed):** production has never OCR'd (Firecrawl
  `pdfMode:"fast"` = embedded text only), so scanned docs are already unparsed today — no
  regression is possible, only unmeasured status quo. The `/parse` density guard turns every
  scanned doc into a counted `needs_ocr` event; U3's gate reports the real share and escalates
  the upgrade decision (Docling sidecar vs Gemini native PDF ingestion) only if the data says so.
- **Single-service SPOF (low impact given volume):** scrape-service down → runs fail with
  provider errors → existing refund + `increment_scout_failures` machinery handles it; Render
  health-check alerting configured in U6. Kill-switch restores Firecrawl in minutes during bake;
  after U8 the recovery is a Render restart/redeploy.
- **Self-managed maintenance:** we now own Playwright/Chromium and `crawl4ai` version bumps in
  `scrape-service/Dockerfile`. Runbook (U6) pins versions and schedules a monthly bump; this is
  the price of removing the paid dependency. Library API drift surfaces in the scrape-service
  pytest suite at bump time, never in the Deno adapters (the REST contract is ours).
- **Render Standard memory (2GB, low risk without torch):** FastAPI ~100MB + Chromium pool of 2
  ~700MB + render spikes leaves ~1GB headroom; pool cap + per-page size guards enforce it. U6
  verification includes a 5-concurrent burst check. Escape hatch: Pro instance — volume
  (<200 scrapes/day) makes this unlikely.
- **Dependency:** U7 blocks on U1's baseline being credible.

---

## Decisions Log (Open Questions resolved 2026-07-03)

1. **Hosting — DECIDED (Tom, 2026-07-03):** single custom scrape-service on one new Render
   Standard service (~$25/mo), per KTD5. Hetzner VPS and 2×-service options rejected
   (management overhead / cost). Full alternatives sweep in KTD10.
2. **Bake window — DECIDED (Tom, 2026-07-03):** 7 days.
3. **Beat search fallback — DEFAULTED (Claude rec, pending Tom veto):** Exa-only (KTD6).
   SearXNG (self-hosted metasearch, free but flaky) documented as a later add if Exa reliability
   becomes a problem. Flag before U5 merges if you want the fallback instead.
4. **Provider enum rename — DECIDED (Tom, 2026-07-03):** rename `firecrawl_plain → canonical`
   per KTD8.
5. **OSS default weight — DEFAULTED (Claude rec, pending Tom veto):** scrape-service default-on
   in the OSS compose (~1.5-2GB RAM floor); the paid-key removal is the point. Flag before U6
   merges if you prefer an optional profile + "bring your own scraper endpoint" env.
6. **PDF parser — REVISED ON EVIDENCE (2026-07-03):** Docling dropped from v1 in favor of
   poppler `pdftotext` after challenge. Facts: benchmark tie (100%/100%) on every shared case
   with pdftotext 200-400× faster; production Firecrawl has always run `pdfMode:"fast"`
   (embedded text, no OCR) so pdftotext is *parity*, not a downgrade; dropping torch removes the
   2GB-instance OOM risk that made single-service hosting fragile. `@llamaindex/liteparse`
   (Apache-2.0, in Tom's kit) verified 2026-07-03: ties pdftotext 6/6 probes at 10-30× the
   latency — admitted as second candidate at the U3 gate. LlamaParse (cloud): paid, 131s/doc,
   excluded outright. Docling (or Gemini native PDF) returns only if U3's real-fixture gate
   demands it.

---

## Loop Execution Contract (`/loop`)

Invocation: `/loop Read SCRAPING-MIGRATION-PRD.md top to bottom and execute per the Loop
Execution Contract` (or point `ralph run` at this file with the same instruction).

**Each iteration:** read this file top to bottom → take the **first unchecked unit** whose
dependencies are all checked → implement per the unit spec in this workspace → run the unit's
verification + repo-mandatory checks (`cd frontend && npm run check && npm test` when frontend
touched; `cd backend && .venv/bin/python -m pytest tests/unit/ -v` when backend touched;
`cd supabase/functions && deno test --allow-env _shared/ <touched-function-dirs>/`;
function integration tests against `supabase start` when civic/web/beat/ingest touched;
`deno coverage` 100% on new `_shared/scrape*`/`docparse*`/`site_map*` files;
`bash scripts/ops/strip-oss.sh` in a throwaway worktree when files added/removed; re-run
`scripts/ops/bundle-ef.ts` when `scouts/index.ts` or `_shared/*` touched) → run the local
multi-agent review pass and apply fixes → `jj` commit the unit as one described commit on the
stack → `jj git push --bookmark scrape-u1` (PR #262 re-runs CI on the stack; required set must
stay green, pre-existing audit-backend/audit-frontend failures excepted) → check the unit's box
below → append one Work Log line → next iteration. NO per-unit merge: Tom merges PR #262 once
after U6, and the U8 cleanup PR after the bake.

**Ground rules:**
- **Anti-gaming:** parity means the recorded probes pass on genuine page content — never tune a
  probe, case, or canonicalizer because of what the gate checks. Any case/probe change requires
  live-page evidence logged in the Work Log (the benchmarks repo found 404 chrome passes loose probes).
- **Paid caps:** Firecrawl — one full baseline suite in U1 + one rollback smoke in U7, nothing
  else; Exa — normal product-path usage only; no credit-burning debug loops (debug against the
  local container).
- **Live-service etiquette:** council sites are small public infrastructure — max one live
  parity sweep per iteration, stagger requests, never retry-hammer a failing source.
- **Prod safety:** every unit lands dark behind `SCRAPE_PROVIDER` until U7. Any prod secret
  change is logged in the Work Log with before/after keys (names, not values).
- **Hard stops (surface to Tom, do not proceed):** any U7 parity-case regression; U3 fixture-gate
  failure (any fixture below recorded production markdown, or material scanned share → present
  Docling-sidecar vs Gemini-native-PDF options with measured data); scrape-service
  OOM/instability on Render Standard in U6's burst check; any action requiring new spend beyond
  the approved caps (approved: one Render Standard service ~$25/mo, U1 Firecrawl baseline run,
  U7 rollback smoke).
- A unit blocked >2 attempts → mark `[BLOCKED: reason]`, stop and summarize (units are
  sequential; unlike independent tasks, skipping ahead is not safe).

**Checklist:**

- [x] U1 — Benchmark repair + Firecrawl baseline + scrape-service (local)
- [x] U2 — Scrape port + Crawl4AI provider (dark)
- [x] U3 — Doc-parse port + pdftotext + Gemini fallback + civic PDF gate (dark)
- [x] U4 — changeTracking retirement (civic per-URL hash baselines)
- [x] U5 — map + search retirement (Exa-only per Decision 3)
- [ ] U6 — Production (Render scrape-service) + OSS infrastructure
- [ ] U7 — Flip + 7-day bake + parity gate  `[HARD STOP on any regression]`
- [ ] U8 — Firecrawl deletion + docs sweep + provider enum → `canonical`

## Work Log

(append-only; newest first; `- 2026-MM-DD — U<N> — done/found/PR#`)

- 2026-07-06 — REBASE ONTO main + MERGE PREP (Tom-authorized). main had advanced (transport #261–#265
  + a big page-scout/scrapegraph-removal commit), leaving PR #262 CONFLICTING. Rebased the 9-commit
  stack onto main@origin. Conflict surface was tiny (migration files disjoint by design): only
  ci.yml (kept main's --allow-import deno step + our scrape coverage-gate step) and .gitignore
  (union). Two transitive breaks the rebase surfaced, both fixed: (a) check-scrape-coverage.sh's
  deno run needed --allow-read=. --allow-import for main's transport satellite.js imports; (b) our
  civic migration collided with main's 00073_transport_sampler_cron — renumbered
  00073_civic_canonical_baselines → 00074 (both self-host CI jobs failed on the duplicate
  schema_migrations PK; green after). Local verify green: deno 452, scrape-service 62 @100%, scrape
  coverage gate 100%, migration-uniqueness. Pre-existing red (also red on #265, non-blocking):
  audit-backend, audit-frontend (dependency CVEs on the default branch). Still dark
  (SCRAPE_PROVIDER=firecrawl).

- 2026-07-04 — SECOND FIX PASS (final ce-code-review, Tom-requested last check). The final review
  found that my OWN first-pass fixes introduced 5 new civic-path bugs + an SSRF hole — the exact
  value of a last check. All live behind SCRAPE_PROVIDER=firecrawl (dark), all in the civic path
  that goes live on merge, so fixed before merge. FIX2-1 (P1): civic-extract-worker inserts
  truncated captures (no canonical hash) into the same (scout_id, source_url) namespace the new
  per-URL baseline lookup reads — a newer worker row shadowed the real baseline → spurious
  "changed"/re-storm. Fixed: baseline lookup now filters canonical-only (also makes migration
  00074's partial index usable). Verified on REAL local Postgres (worker row present → still
  "same"; genuinely-different → "changed"). FIX2-2 (P1/P2): a 4xx tracked page counted as a scrape
  failure that fed the queuedCount==0 throw → could auto-pause an otherwise-healthy scout; and a
  5xx target page was hashed+baselined (error page poisoning the baseline). Fixed: new "gone" state
  for 4xx (never counted toward the throw; allTrackedUrlsAre4xx→allTrackedUrlsGone), 5xx→transient
  scrape_failed, neither hashed nor baselined. FIX2-3 (P2): establishCivicBaseline baselined error
  pages and stamped a functionless scout when zero URLs were reachable. Fixed: skip error-status
  pages; throw ValidationError when NO tracked URL is reachable (empty-but-reachable stays
  non-fatal). FIX2-4 (P2/P3): PDF download followed redirects with only the initial host validated
  → SSRF via a public→169.254.169.254/file:// redirect; and oversized PDFs were sent to Gemini
  inline (would 4xx). Fixed: manual per-hop redirect following with the SSRF guard on every hop +
  non-http(s) scheme block; skip Gemini + surface needs_ocr past the 14 MB inline limit. Tests:
  scrape-service 62 pass @ 100% cov; _shared 384 pass; scrape coverage gate 100%; canonical_baseline
  + civic_diagnostics unit + real-DB all green. Not yet a commit at time of writing. Merge still
  HELD pending Tom.

- 2026-07-04 — REVIEW + FIX PASS (pre-merge, Tom-requested). Ran the workflow-backed high-effort
  code review over the full U1-U6 diff (31 verified findings → 10 reported). It caught SERIOUS
  bugs, TWO of which refuted my own U4 self-review: (a) a dead page does NOT make scrape() throw
  (both providers return the 404 page at HTTP 200 + real status) so allTrackedUrlsAre4xx was
  unreachable; (b) the direct-doc dedup was gated on changeStatus==='same', re-storming on the
  first-run 'new' for all 19 live civic scouts. Fixed 9, refuted 1. Per Tom's rules: Beat/Exa
  validated with REAL Exa smoke (3 councils, 8/8 on-domain — the 'site: broken' finding was a
  false positive, Exa honors it empirically; kept includeDomains as hardening); everything else
  debugged against REAL behavior — scrape-service on real 404 pages (ground truth for FIX-1),
  mapSite on 6 real councils (all yield good candidates; gap is sitemap-less sites only), and the
  change-detection primitives on REAL local Postgres (per-URL isolation + scout_runs success-join
  both verified). Fixes: FIX-1 status_code through the port + civic 4xx detection; FIX-2/3 dedup
  gates on !==changed + baseline written every run (TTL refresh); FIX-5 empty-markdown non-fatal;
  FIX-6 OSS default→firecrawl; FIX-8 repointed U7-gate + audit imports; FIX-9 mapSite deadline;
  FIX-10 Gemini key→header. Commit f56ec73c on PR #262. SCRAPE_PROVIDER stays firecrawl (dark)
  until crawl4ai validated end-to-end per Tom. Merge still HELD pending Tom.

- 2026-07-04 — U6 (partial) — infra-as-code pushed to PR #262: render.yaml scoutpost-scrape
  service, OSS docker-compose scrape-service (default-on, SCRAPE_PROVIDER=crawl4ai, firecrawl
  key now optional), runbook docs/architecture/scrape-service.md. BOX NOT CHECKED. Remaining
  U6 = (a) MANUAL: provision Render service + SCRAPE_SERVICE_TOKEN + `supabase secrets set`
  (Tom's env); (b) frontend setup-generator + installer/selfhost scripts drop the mandatory
  firecrawl-key prompt (needs frontend loop: npm check/test/i18n). Then U7 flip+bake, U8 delete.

- 2026-07-04 — U5 — DONE, pushed to PR #262. In-house _shared/site_map.ts replaces firecrawlMap
  (robots→sitemap→gzip/index recursion→link-harvest fallback; civic discover wired; 17 tests,
  91.5%, not strict-gated — residual is defensive network branches, documented). beat-search
  direct firecrawlSearch → exaSearch; resolveBeatRetrievalPort now Exa-only (kill-switch retired,
  logs deprecation). Deferred to U8: firecrawlSearch/firecrawlMap bodies + dead beat_pipeline
  firecrawl branch (unreachable now). 389 deno tests; 4 gated modules 100%. Only `scouts` is
  bundled (untouched). All CODE-ONLY units now done (U1-U5); U6 needs Render provisioning +
  Supabase secrets (Tom's env), U7 needs prod flip+bake, U8 is the deletion sweep.

- 2026-07-04 — U4 — DONE, pushed to PR #262. Civic changeTracking → in-house canonical-hash
  baselines per (scout, source_url), reusing the web machinery. New _shared/canonical_baseline.ts
  (hashChangeStatusForUrl + writeCanonicalBaseline, 100% cov, 17 tests); civic-execute rewritten
  (scrape port + per-URL hash; 'new'≡'changed' preserves control flow; removed-page = HTTP 404 →
  4xx); establishCivicBaseline writes per-URL baselines at creation; scout-web-execute delegates
  to shared (byte-identical for web); migration 00074 per-URL index. DESIGN CALL (documented):
  civic does NOT do silent-first-run (PRD's literal wording) — document-level processed_pdf_urls
  dedup prevents re-alert storms and silent-on-new would MISS docs during migration; new≡changed
  is safer + preserves exact prior civic behavior. DEFERRED to U8: delete changeTracking/
  doubleProbe/ChangeTrackingResult from port + dead web legacy-provider branches (0 prod rows) —
  belongs with firecrawl-deletion, avoids touching live web legacy path here. 378 deno tests; 4
  gated modules 100%. Review self-verified (agent classifier down): markRunSuccess reached so
  baselines usable next run; failed run's baselines ignored (status filter); per-URL sourceUrl
  consistent between hash+write; firecrawlUpstreamStatus parses 404 from scrape error.

- 2026-07-03 — U3 — DONE (incl. U3d), pushed to PR #262. docparse.ts port (100% cov) +
  civic-extract-worker/civic_preview wired; scrape-service /parse = pdftotext with Gemini
  native-PDF fallback on low yield (Tom's gate decision). GATE RESULT (10 real prod civic
  PDFs, content-token recall vs Firecrawl content_md): council minutes/agendas/resolutions
  97-100% (Kimball 100/99, Geneva PV 97, IUCN 100, FRAPRU 100, DRSP 100) = parity; 2
  chart-heavy REPORTS regress (SPVM annual 64%, NBC note 85% — Firecrawl browser-render
  captured chart/encoding text); liteparse ties pdftotext (no edge); 2 URLs bot-walled
  (browser handles); 0 truly scanned (the 'scanned' flag was a 0-byte fetch). METRIC LESSON:
  first gate run cried wolf (6 'regressions') — anchors were polluted with Firecrawl markdown
  syntax + reading-order artifacts; switched to markdown-stripped order-independent
  content-token recall. Tom decisions: (a) Gemini-native fallback on low yield [built U3d,
  temp 0, finishReason guard, 210s client fuse, non-determinism bounded by processed_pdf_urls];
  (b) deleted stray eng.traineddata (parallel OCR experiment). Review (Explore): 3 findings —
  truncation guard + deadline fixed; churn finding refuted (URL-level dedup). scrape-service
  55 tests/100%; 362 deno tests. U6 must add GEMINI_API_KEY to scrape-service env (render+OSS).

- 2026-07-03 — U2 — DONE, pushed to PR #262 (stacked commit 933263ae). firecrawl.ts split into
  scrape_types/scrape_firecrawl/scrape_crawl4ai/scrape.ts (port). Lands dark (SCRAPE_PROVIDER
  default firecrawl → byte-identical). 14 importers repointed; shim dropped (EF bundler can't
  chain export-from — confirmed pre-existing bundler stampBaseline collision is NOT a U2
  regression, exists on main). 349 deno tests (was 326); 100% coverage gate on scrape.ts +
  scrape_crawl4ai.ts wired into CI. Local review (4 angles): 2 findings, both fixed — crawl4ai
  non-OK now always 502 (Firecrawl parity, not 504); ingest routed through port (was orphan);
  docstring corrected re per-subsystem cutover. Live smoke: port→crawl4ai container on Zurich
  civic page passes all probes. Deferred to owning units: civic-PDF callers→U3 doc-parse,
  web change-detection→U4, beat→U5 (documented in scrape.ts port docstring).

- 2026-07-03 — U1 — DONE under revised contract (Tom: stacked commits, two merges total,
  Greptile removed). PR #262 retitled as the migration-stack PR, merge deferred to post-U6.
  U1 box checked; starting U2.

- 2026-07-03 — U1 — BLOCKED ON MERGE APPROVAL: all required checks green on amended commit
  (only pre-existing audit-backend/audit-frontend fail, proven on all branches). Merge of
  PR #262 denied by permission classifier (self-authored + self-reviewed + prod auto-deploy)
  — correct guardrail, not worked around. Tom pinged; merge-state monitor armed; U2 starts
  on merge. Standing question for Tom: reactivate Greptile, or bless local review substitute.

- 2026-07-03 — U1 — review pass done (Greptile TRIAL ENDED — substituted local 8-angle
  code-review; surface to Tom for reactivation decision). 15 findings fixed + squashed:
  strip-oss leak of baselines (real catch), streamed download cap, form-feed page count
  (regex was blind to PDF 1.5+ ObjStm), SSRF private-IP guard, docs off, typed timeouts,
  gate integrity (record fails on errored case; compare fails on missing case), reuse
  (sha256Hex/envFlag imports). One reviewer fix REFUTED empirically: browser UA on liveness
  guard masks death (Zurich dead URL serves 200 cookie-error to browser UA, honest 404 to
  plain UA) — kept plain UA + 403 tolerance, documented in module. 42 tests / 100% cov;
  container re-verified. Deferred: semaphore-wait-inside-fuse (low volume), per-page
  density (U3), CLAUDE.md required-checks list (U8 docs). CI re-running on amended commit.

- 2026-07-03 — U1 — implemented + verified, PR #262 open (Greptile requested), awaiting CI.
  URLs repaired (all 200), liveness guard proven vs real dead URL, scrape-service 37 tests /
  100% cov, container healthy arm64 (+amd64 buildx in flight), live /scrape+/parse smokes pass,
  Firecrawl baseline frozen: 38/48 ≈ 79% (reproduces tools/benchmarks incl. Zermatt 0/6).
  Paid spend: one Firecrawl baseline pass (approved cap). Deviations: strip-oss ran via CI
  oss-mirror-check instead of local throwaway worktree; local crawl4ai parity sweep deferred
  (etiquette: one live sweep/iteration — baseline was it). Key fetched from mac-mini goose-ops.

---

## Sources & Research

- **Decision record:** `SCRAPING_MIGRATION.md` (2026-07-03) — Crawl4AI recommendation, benchmark
  table, dead-URL replacements.
- **Benchmarks:** `tools/benchmarks/results/combined-current.json` + `public/index.html`
  (2026-07-03 runs): scraping 8 cases (Crawl4AI 100%, Scrapling 100%, Scrapy/MarkItDown 88%,
  Firecrawl 79%, Exa 79%, PixelRAG 83%, Scraper Factory 29%, Obscura 50%); PDF (Docling 100%,
  pdftotext 100%, Fireparse 100% paid, LlamaParse 100% on 1 case at 131s paid, Surya 83%,
  LangExtract 83%, Marker 0%).
- **PDF head-to-head (fresh, 2026-07-03):** poppler `pdftotext -layout` vs
  `@llamaindex/liteparse` 2.4.0 (Apache-2.0, deps: commander only) on `shultz-follow-the-money`
  and `gijn-citizen-investigations` fixtures — both 6/6 weighted probes; poppler 51-191ms,
  liteparse 1.6-5.3s. LlamaParse cloud excluded (paid, `llx-` key, violates objective).
- **Firecrawl touchpoint audit** (Explore agent + spot verification, 2026-07-03): single client
  `_shared/firecrawl.ts:10-640`; 13 call sites (civic-execute:241, civic-extract-worker:275,
  civic:147, ingest:255, beat-search:164,403, scout-beat-execute:236,788, scout-web-execute:455,
  470,491,1071, scouts:665,1509, civic_links:244, civic_preview:73, beat_pipeline:603,
  web_scout_baseline:69,107); backend has no client (stale CLAUDE.md:283); CLI/MCP zero refs;
  `scouts/_bundled.ts` auto-generated; env/config/docs inventory as listed per unit above.
- **Production DB (2026-07-03):** scouts by type/provider — web 61 all `firecrawl_plain`, civic 19,
  beat 40, social 42; 264 runs/7d; `raw_captures` columns confirm per-(scout,url) baseline fit.
- **Test/coverage audit (2026-07-03):** backend 436 pass; frontend 265 pass; deno CI set 326 pass;
  `firecrawl.ts` 44.8% line coverage; civic/ingest integration tests env-gated, not in CI.
- **Crawl4AI** (`deploy/docker/README.md` @ unclecode/crawl4ai, fetched 2026-07-03): image
  `unclecode/crawl4ai:0.8.6`, port 11235, `POST /crawl`, `/crawl/stream`, `/html`, `/screenshot`,
  `/pdf` (render-to-PDF, not parsing), `/execute_js`, JWT auth, `/playground`. Apache-2.0.
  We wrap the library, not this server (KTD5).
- **docling-serve** (README fetched 2026-07-03): `quay.io/docling-project/docling-serve`, stable
  v1 API, `POST /v1/convert/source`. MIT. Evaluated and **deferred** (Decision 6): requires
  PyTorch (~2-3GB image, 1-2GB resident RAM); no benchmark case showed it beating pdftotext.
- **PDF parity facts:** Firecrawl production default `parsers:[{type:"pdf",mode:"fast"}]` =
  embedded-text extraction, no OCR (`_shared/firecrawl.ts:63-66` and its anti-hallucination
  comment); `raw_captures.content_md` stores Firecrawl's historical markdown per processed civic
  doc (prod schema, verified 2026-07-03) — U3's fixture baseline. Determinism constraint: civic
  dedup keys on `content_sha256`, ruling out LLM transcription as primary parser.
- **Tow Center scraper-factory** (cloned 2026-07-03): generate→test→refine architecture reviewed;
  verdict KTD9.
- **House conventions:** `TRANSPORT-SCOUT-PRD.md` (implementation-unit + loop-contract format),
  `tools/benchmarks/LOOP.md` (anti-gaming, paid caps, work-log discipline),
  `kit/coding-rules/SKILL.md` (workflow routing, jj, completion standard).

---

*Note (2026-07-03): this file was recreated after it disappeared from the working tree mid-session
(possibly a parallel session — an untracked `supabase/functions/eng.traineddata` Tesseract model
appeared around the same time). If that other session holds a divergent copy, reconcile before
approving.*
