# Beat Scout (type `beat`)

> **Naming:** Publicly this is the **Beat Scout** surface. It can be scoped by geography, topic/criteria, or both. Older repo references may describe the geography-scoped Beat Scout flow with legacy wording.

AI-curated digest with multi-language search and fact-level deduplication.

## Overview

The beat pipeline surfaces niche sources, community blogs, and underreported stories. It supports location-only, criteria-only, or combined location+criteria scoping. Scheduled creation runs a baseline-only pass first: current findings are deduped and hidden from the inbox, the scout gets `baseline_established_at`, and later Run Now/cron executions notify only on new material.

Beat Scouts can run weekly or monthly. Daily schedules are intentionally
rejected because this pipeline fans out across search, filtering, extraction,
and deduplication; weekly is the highest supported frequency.

**Beat Scout modes:**
- **Geography-scoped Beat Scout** — requires a location, optionally accepts criteria. Often used with **niche** sources.
- **Topic-scoped Beat Scout** — requires criteria, no location. Often used with **reliable** sources.

Both flows expose a source mode toggle so users can switch between niche and reliable. The backend pipeline is identical; only the default parameters differ.

**`topic` vs `criteria` vs `description`:** The `criteria` field is the search/filter driver (keywords, inclusion/exclusion rules, thresholds, and notification requirements). The `topic` field is only for organization and UI filtering: store 1-3 short comma-separated tags such as `housing, council, budget`, not a sentence. The optional `description` field is human/agent context shown on scout cards. Every scout must have either a location or topic tags so it can be scoped and browsed. `BeatSearchRequest` has no `topic` field. `BeatExecuteRequest` has both: if `criteria` is empty but `topic` is set, `topic` is copied to `criteria` for backward compatibility with old SCRAPER# records.

## Execution Pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│                BEAT SCOUT (Firecrawl Cloud search)               │
│                                                                  │
│  Trigger: pg_cron → execute-scout EF → scout-beat-execute       │
│           OR: UI preview → POST /functions/v1/beat-search       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step 0: Discovery boundary                                      │
│  ├─ Firecrawl Cloud /v2/search for every generated query         │
│  ├─ Priority domains use includeDomains                          │
│  └─ Explicit source URLs bypass search                           │
│           │                                                      │
│           ▼                                                      │
│  Step 1: Query Generation                                        │
│  ├─ LLM generates queries in local language + English            │
│  ├─ Also returns canonical/localized query text                  │
│  ├─ Also returns required_concepts and weak_terms for filtering  │
│  ├─ Niche/government plans can include discovery_queries         │
│  ├─ Reliable location news uses only the primary query set       │
│  ├─ Government category: discovery_queries for public sector     │
│  └─ Categories: news, government, analysis                       │
│           │                                                      │
│           ▼                                                      │
│  Step 2: Retrieval                                               │
│  ├─ Firecrawl Cloud web search with geography + 14-day tbs       │
│  ├─ Web hits are normally date-less; do not cap them as stale    │
│  ├─ Scrape URLs via Crawl4AI (Firecrawl anti-bot fallback)       │
│  └─ Preserve quiet-zero versus all-query-failed semantics        │
│           │                                                      │
│           ▼                                                      │
│  Step 3: Filter/ranking path                                     │
│  ├─ Reject known-stale dates; preserve provider-windowed unknowns│
│  ├─ Tourism filter, embedding dedup, clusters                    │
│  ├─ Filter by relevance to location/topic/criteria               │
│  ├─ Enforce required concepts for compound topics                │
│  └─ Target: 5-6 (niche) or 6-8 (reliable) articles              │
│           │                                                      │
│           ▼                                                      │
│  Step 4: Fact-Level Deduplication (Scheduled only)               │
│  ├─ Extract 1-3 atomic facts per article                         │
│  ├─ Compare against facts from previous runs                     │
│  └─ Return only NEW facts (not seen before)                      │
│           │                                                      │
│           ▼                                                      │
│  Step 5: Extractive Digest & Notification                        │
│  ├─ Deterministic digest from rendered article cards             │
│  ├─ Store scout_runs + scout_run_events diagnostics              │
│  ├─ Store atomic units in knowledge base                         │
│  └─ Send localized email (user's preferred_language)             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Key Files

### v2 (Supabase Edge Functions) — authoritative source of truth

| File | Location | Purpose |
|------|----------|---------|
| `scout-beat-execute/index.ts` | `supabase/functions/` | Beat scout entrypoint. Branches on `priority_sources`: explicit → direct scrape; empty → Firecrawl Cloud discovery. Uses Crawl4AI for primary rendering, extracts units, and sends the deterministic extractive digest email. |
| `_shared/beat_pipeline.ts` | `supabase/functions/` | Shared Beat discovery, filtering, ranking, and priority-domain helpers used by preview and scheduled execution. |
| `_shared/scrape_firecrawl.ts` | `supabase/functions/` | Firecrawl Cloud `/v2/search` request/response adapter and managed scrape client. |
| `_shared/scrape.ts` | `supabase/functions/` | Crawl4AI rendering boundary with a classified Firecrawl Cloud anti-bot fallback. |
| `_shared/extractive_summary.ts` | `supabase/functions/` | Deterministic Beat email digest renderer and grounding checks. No LLM calls. |
| `beat-search/index.ts` | `supabase/functions/` | Preview endpoint — synchronous version of the pipeline for the New Scout modal's "Start Search" button. No credit charge, no persistence. |

### Legacy (v1 FastAPI) — for reference during cutover only

| File | Location | Purpose |
|------|----------|---------|
| `pulse_orchestrator.py` | `backend/app/services/` | Historical orchestration logic (ported to `_shared/beat_pipeline.ts`) |
| `query_generator.py` | `backend/app/services/` | LLM-powered search + discovery query generation |
| `pulse.py` | `backend/app/routers/` | Historical `/api/pulse/*` endpoints from the pre-cutover backend |
| `news_utils.py` | `backend/app/services/` | FirecrawlTools, embedding dedup, URL heuristic filters, PDF enrichment |
| `filter_prompts.py` | `backend/app/services/` | AI filter prompt templates (13 prompts across scope/category/mode) |
| `atomic_unit_service.py` | `backend/app/services/` | Fact extraction and dedup |
| `notification_service.py` | `backend/app/services/` | Localized email notifications |
| `email_translations.py` | `backend/app/services/` | Email strings (12 languages) |

## v1 → v2 parity notes

The v2 port preserves the useful legacy stages while removing provider-specific
assumptions:

- **Stage 1 (query gen):** `google/gemini-2.5-flash-lite` through OpenRouter's Google Vertex-only ZDR route. Output uses strict JSON Schema and OpenRouter response caching is disabled. Historical v1/direct-Google implementations are comparison context, not the current runtime.
- **Stage 5 (tourism pre-filter):** identical 11-domain + 6-title pattern list.
- **Stage 6 (embedding dedup):** scope-aware thresholds preserved (combined 0.85 / location 0.82 / topic 0.80). The `+8` local-language bonus is approximated via a charset heuristic (`/[À-ÿ]/`) instead of `langdetect`, to avoid shipping a heavy ML model in the Edge runtime. Slight precision loss on non-Latin scripts (JP/KR/ZH); flagged as a follow-up if needed.
- **Email digest:** Generative Beat summary composition is removed from the production notification path. Digest text is deterministic and built from the same article cards rendered in the email; summary links outside those cards are rejected.
- **Credit:** 7 credits per run unchanged from legacy. Refunded via `refund_credits` RPC when the pipeline yields 0 URLs or the run errors.

## Deduplication Mechanisms

### Layer 1: URL Deduplication + Quality Filters
- Firecrawl Cloud `/v2/search` is the sole external discovery boundary.
  `_shared/scrape_firecrawl.ts` normalizes results to the shared `SearchHit`
  shape with URL, title, description, and date.
- Search requests forward applicable date, geography, `includeDomains`, and
  `excludeDomains` options; local filters still reject unsuitable URLs and
  sources.
- Firecrawl web search results do not normally include publication dates.
  Their server-side 14-day `tbs` window is therefore the initial recency gate;
  date-less hits remain eligible for rendering instead of being capped.
- Source dates are normalized through
  `_shared/atomic_extract.ts::sourcePublishedDate`: scraper metadata first,
  visible date near the top of scraped markdown second, and the search hit date
  last. Known dates older than the 28-day relaxed window are rejected after
  rendering; preview applies the same check to dates found during extraction.
- **Homepage/index rejection**: bare `/`, `/blog`, `/news` etc. are dropped (`is_index_or_homepage`)
- **Standing page rejection**: institutional/section pages with short paths and no numeric IDs (`is_likely_standing_page`) — catches gov landing pages, stats dashboards, agenda indexes
- Removes exact duplicate URLs from multiple queries

### Layer 2: Embedding Deduplication (0.80 threshold)
- Embeds article title + description
- Clusters similar articles by cosine similarity
- Keeps highest-scoring article from each cluster
- **Language-aware scoring** for non-English locales (see below)

#### Article Scoring (for cluster selection)
When multiple articles cover the same story, the system picks the best one using:

| Factor | Points | Description |
|--------|--------|-------------|
| Has publication date | +5 | Dated articles preferred |
| Undated news penalty | -5 | Undated news articles penalized (discovery undated: neutral) |
| Local domain TLD | +5 | `.ca`, `.ch`, `.fr`, etc. based on location |
| Domain rarity | +4 to +8 | Rare domains get higher scores (freq 1 = +8, freq 2 = +6) |
| Discovery pass bonus | +6 | Community/blog sources preferred over news |
| **Language match** | +8 | Article language matches locale (non-English only) |
| Description length | +0-3 | Longer descriptions slightly preferred |

**Language scoring:** The Edge runtime uses a lightweight charset heuristic for the local-language bonus instead of the old Python `langdetect` dependency. This preserves the scoring shape without shipping a heavy language model into Edge Functions.

### Layer 2.5: Cluster + Tourism Filter (niche only)
- **Cluster filter**: drops mainstream news articles with cluster_size >= 3
- **Tourism filter**: rejects travel blogs and tourism guides by domain/title patterns (niche + location + news category only, via `is_likely_tourism_content`)

### Layer 3: Fact-Level Deduplication
- Extracts atomic facts from articles
- Compares against facts from previous runs (same scout)
- Only NEW facts trigger notifications

Beat extraction resolves the source title from scraper metadata first and the
search hit second. If the compressed article is longer than the 3,000
character extraction limit and a strongly matching H1-H3 appears after the
first 70% of that limit, the extraction window starts up to 300 characters
before that heading. Missing, weak, or early title matches retain the normal
prefix. This safeguard is enabled only by Beat callers; the shared extractor's
default behavior, including Page Scout extraction, is unchanged.

## Scope Modes

| Mode | Configuration | Search Behavior |
|------|---------------|-----------------|
| **Location-only** | `location` set, no `criteria` | Local news terms in that location |
| **Criteria-only** | `criteria` set, no `location` | Criteria searches globally |
| **Combined** | Both `location` and `criteria` | Criteria searches scoped to location |

**Validation:** At least one of `location` or `criteria` must be provided (enforced by `BeatSearchRequest` and `BeatExecuteRequest`).

## Source Modes

Source mode changes ranking, filtering, target count, and discovery-query
shape. Firecrawl Cloud is the search boundary for all Beat discovery — see
[Retrieval](#retrieval).

| Mode | Discovery | Date Window | AI Target | Domain Cap |
|---|---|---|---|---|
| **niche** | LLM-generated community/local-source queries | 14d (28d fallback) | 5-6 | 2/domain |
| **reliable** | Primary queries only for location news; other scopes keep their generated plan | 14d (28d fallback) | 6-8 | 3/domain |

## Retrieval

Firecrawl Cloud `POST /v2/search` is the **sole** search boundary for Beat
discovery. Preview and scheduled execution share the same adapter and filtering
pipeline:

- **Generated queries** use web results and the configured geography, recency,
  and excluded domains. Reliable location-news runs skip the five
  source-discovery queries: live Zürich, London, and Stockholm permutations
  preserved the eight-candidate ranking target while reducing search jobs from
  12 to 7.
- **Priority domains** use Firecrawl's `includeDomains` option, with the same
  behavior in preview and scheduled execution.
- **Explicit source URLs** bypass search and go directly to rendering.
- **Failure semantics** distinguish a legitimate zero-result response from a
  provider outage. A quiet zero can complete successfully; when every query
  errors, the scheduled run fails and refunds the pre-charge.

Crawl4AI remains the **primary renderer**: discovered article URLs are scraped
through the Crawl4AI scrape service (`scrape()` in `_shared/scrape.ts`); when a
host blocks it
(Cloudflare/DataDome/Imperva) that single scrape retries via Firecrawl
(`isAntiBotBlockedError`). Every run stamps `scrape_served_crawl4ai` /
`scrape_served_firecrawl` into `scout_runs.metadata`, and `benchmark-beat`
asserts Crawl4AI actually served and retrieval was `firecrawl`.

This split is intentional. Hosting Firecrawl itself would add a broader AGPL
service and would still require a separately operated search backend for
self-hosted search. Crawl4AI gives Scoutpost a narrow, controllable renderer;
Firecrawl Cloud supplies managed search and the classified anti-bot fallback.
See `docs/architecture/retrieval-ports.md`.

## Search Relevance Guardrails

The production default is intentionally simpler than the earlier fan-out design:

- Run the primary query set through Firecrawl Cloud web search. Keep
  discovery-query fan-out for niche and government modes where source
  discovery is intentional.
- Forward the scout's geography through the supported Firecrawl request fields
  when the scout has a location.
- Let the LLM query plan translate/localize queries for non-English locations instead of hardcoding country-specific terms.
- Pass `canonical_query`, `localized_query`, `required_concepts`, and `weak_terms` from query generation into the AI relevance filter.
- For compound topics, the AI filter must require all major concepts. A result matching only a weak generic term such as `AI`, `policy`, `technology`, or `media` is not enough.
- Measure quality by relevance/locality/manual review, not by result count alone.

The regression that motivated this rule: a topic-only Beat Scout for `AI in journalism` returned broad AI stories about the Pentagon, Oscars rules, school boards, and city councils. Those results matched generic `AI` terms but not the journalism/newsroom concept. The fix is covered by the live benchmark canary `topic-only:ai-journalism`; ongoing coverage lives in `docs/supabase/benchmarks.md` and `scripts/benchmarks/`.

Future experiments may reintroduce `news` only as a separately ranked freshness lane with its own relevance gate and audit evidence. It should not be blindly merged into the default result set.

### Recency Config by Scope

All scope/mode combinations use a **standard 14-day provider window**. Known
dated articles can use a **28-day relaxed fallback**. Date-less Firecrawl web
hits remain eligible until rendering because the web result contract does not
include a publication date; once rendering or extraction finds a known date
older than 28 days, the source is rejected.

| Scope | Mode | Initial Window | Relaxed Fallback |
|-------|------|----------------|------------------|
| all | all | 14 days | 28 days |

## Multi-Language Search

For non-English locations, the LLM generates queries in the local language.
Discovery queries (community events, jobs, civic groups) are also generated
in the local language, replacing previous hardcoded translation tables.

## Preview vs Scheduled Mode

| Mode | Dedup | Notifications | Credits | Units |
|------|-------|---------------|---------|-------|
| **Preview** (UI search) | URL + embedding only | Never | Not charged | Not stored |
| **Scheduled** (Edge Function) | All 3 layers | When new units surface | Charged | Stored |

## Database Records

### `scout_runs` and `scout_run_events`

Beat execution state is stored in `scout_runs`, with timeline diagnostics in
`scout_run_events`. `scout runs show <run_id>` exposes the run row, stage
events, source counts, notification state, merged units, and retrieval metadata.

### Historical `beat_ab_runs`

Migration `00064` and `beat_ab_runs` remain so prior provider-comparison
evidence stays readable. Current Beat execution does not write or consult this
table. Its fields describe historical migrations:

| Field | Meaning |
|---|---|
| `retrieval` | `firecrawl` or `exa` |
| `raw_hit_count` / `dated_hit_count` / `final_hit_count` | Retrieval quality counters |
| `locality_score` / `freshness_score` | Deterministic scoring for canary comparison |
| `total_cost_dollars` | Historical provider response cost when recorded |
| `metadata.shadow` | `true` when row was produced by discovery-only A/B shadow |
| `metadata.fallback_reason` | Historical provider-fallback reason |

### Information Units

Canonical facts live in `information_units` and per-run/source sightings live
in `unit_occurrences`. Beat writes source URLs, source titles/domains, run IDs,
and canonical-unit merge data through `_shared/unit_dedup.ts`.

## Credit Cost

| Operation | Credits |
|-----------|---------|
| Scheduled execution | 7 |
| UI search (preview) | 0 |

## Benchmarking

Run the Supabase-era Beat health benchmark to exercise the real discovery path:

```bash
deno run --allow-env --allow-net --allow-read=. --allow-write=scripts/reports scripts/benchmarks/benchmark-beat.ts
deno run --allow-env --allow-net --allow-read=. --allow-write=scripts/reports scripts/benchmarks/benchmark-beat.ts --scout-id <existing-beat-scout-uuid>
deno run --allow-env --allow-net --allow-read=. --allow-write=scripts/reports scripts/benchmarks/benchmark-beat.ts --timeout-min 8
deno run --allow-env --allow-net --allow-read=. --allow-write=scripts/reports scripts/benchmarks/benchmark-beat.ts --scenario ai-journalism --timeout-min 10 --verbose
```

The default run checks the first two fixed canaries through preview search, the
full silent baseline execution, and a user-authenticated Run Now execution. A
quiet zero on the immediate Run Now is valid when the baseline already observed
the same stable URLs; relevance and source-link gates use units from both runs.
Set `SCOUT_FULL_BEAT_BENCHMARK=1` to run all eight, including the
priority-domain canary.
Each canary runs once: zero-result, timeout, provider-path, and semantic-drift
failures remain visible instead of being hidden by a retry.
`--scout-id` replays one existing Beat scout configuration on a temporary
benchmark user to validate backward compatibility without touching the original scout.
`--scenario` filters by scenario name so operators can rerun a single canary
after a production deploy.

The AI journalism canary is the regression sentinel for broad-topic drift. It
requires both AI and journalism/media concepts and rejects the earlier broad-AI
drift terms. Beat retrieval also rejects social/video/community platforms
before scraping; those sources belong to Social Scout or manual research, not
automated Beat ingestion.

When this pipeline changes, deploy both functions that import `_shared/beat_pipeline.ts`:

```bash
supabase functions deploy scout-beat-execute --project-ref <project-ref> --no-verify-jwt
supabase functions deploy beat-search --project-ref <project-ref> --no-verify-jwt
```

## Related Docs

- `docs/supabase/scouts-runs.md` - scout scheduling and run records
- `docs/supabase/units-entities.md` - information unit deduplication
