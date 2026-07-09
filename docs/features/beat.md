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
│                  BEAT SCOUT (v2 + Exa retrieval)                 │
│                                                                  │
│  Trigger: pg_cron → execute-scout EF → scout-beat-execute       │
│           OR: UI preview → POST /functions/v1/beat-search       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step 0: Retrieval port selection                                │
│  ├─ Default: Exa retrieval                                       │
│  ├─ Firecrawl kill-switch retired (Exa only)                     │
│  ├─ Low-coverage (<2) → Exa deep-lite retry                      │
│  └─ A/B discovery shadow: BEAT_AB_SHADOW=1                       │
│           │                                                      │
│           ▼                                                      │
│  Step 1: Query Generation                                        │
│  ├─ LLM generates queries in local language + English            │
│  ├─ Also returns canonical/localized query text                  │
│  ├─ Also returns required_concepts and weak_terms for filtering  │
│  ├─ News category: can generate discovery_queries                │
│  │   (community events, civic groups, local blogs)               │
│  ├─ Government category: discovery_queries for public sector     │
│  └─ Categories: news, government, analysis                       │
│           │                                                      │
│           ▼                                                      │
│  Step 2: Retrieval                                               │
│  ├─ Exa default: /search with category, userLocation, dates      │
│  ├─ Scrape found URLs via crawl4ai (Firecrawl AB fallback)       │
│  ├─ Persist beat_ab_runs metrics + Exa cost when available       │
│  └─ Low-coverage Exa runs retry Exa deep-lite                    │
│           │                                                      │
│           ▼                                                      │
│  Step 3: Legacy filter/ranking path                              │
│  ├─ Scope-aware date windows (7d–21d depending on config)        │
│  ├─ Undated cap, tourism filter, embedding dedup, clusters       │
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
| `scout-beat-execute/index.ts` | `supabase/functions/` | Beat scout entrypoint. Branches on `priority_sources`: explicit → direct scrape; empty → retrieval pipeline. Uses Exa retrieval (crawl4ai scrape), logs `beat_ab_runs`, handles the low-coverage Exa deep-lite retry, extracts units, and sends deterministic extractive digest email. |
| `_shared/beat_pipeline.ts` | `supabase/functions/` | Public facade for Beat discovery helpers. Kept intentionally small so downstream imports stay stable during Exa migration. |
| `_shared/exa.ts` | `supabase/functions/` | Exa `/search` client and retrieval-port helpers. Preserves `SearchHit` shape plus Exa metadata/cost for canary logging. |
| `_shared/beat_ab_logger.ts` | `supabase/functions/` | Writes `beat_ab_runs` and computes raw/dated/final/locality/freshness metrics. |
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

The v2 port preserves all 8 pipeline stages with these clarifications:

- **Stage 1 (query gen):** Gemini 2.5 Flash-Lite via Google direct API (legacy used OpenRouter). Schema-constrained output. Caching not yet ported — v1 kept a 24h in-memory query cache with TTL.
- **Stage 5 (tourism pre-filter):** identical 11-domain + 6-title pattern list.
- **Stage 6 (embedding dedup):** scope-aware thresholds preserved (combined 0.85 / location 0.82 / topic 0.80). The `+8` local-language bonus is approximated via a charset heuristic (`/[À-ÿ]/`) instead of `langdetect`, to avoid shipping a heavy ML model in the Edge runtime. Slight precision loss on non-Latin scripts (JP/KR/ZH); flagged as a follow-up if needed.
- **Email digest:** Generative Beat summary composition is removed from the production notification path. Digest text is deterministic and built from the same article cards rendered in the email; summary links outside those cards are rejected.
- **Credit:** 7 credits per run unchanged from legacy. Refunded via `refund_credits` RPC when the pipeline yields 0 URLs or the run errors.

## Deduplication Mechanisms

### Layer 1: URL Deduplication + Quality Filters
- Firecrawl Search is the external-search boundary. `_shared/firecrawl.ts` normalizes both legacy flat results and current `web`/`news` result groups into one `SearchHit` shape with `url`, `title`, `description`, `date`, and `source`.
- The beat pipeline sends `ignoreInvalidURLs: true` and `excludeDomains` to Firecrawl so obvious bad URLs and blocked domains are removed before local filtering.
- Firecrawl kill-switch search uses explicit `sources: ["web"]` for both primary and discovery queries. Do not rely on Firecrawl defaults.
- Do not add `news`, `recent-web`, or `web+news` back to the default path without rerunning the quality audit and updating this document. The 2026-05-02 audit found `news` and `recent-web` were the main sources of locality drift and one-concept topic drift, especially for non-English and civic-style beats.
- `scrapeOptions` is not enabled during search fan-out because Firecrawl charges search plus scrape credits when search results are scraped inline; extraction remains a later, narrowed stage.
- Simple URL-based dedup during search aggregation
- Source dates are normalized through `_shared/atomic_extract.ts::sourcePublishedDate`: Firecrawl scrape metadata first, visible date near the top of scraped markdown second, Firecrawl search date last. This feeds extraction prompts and `information_units.occurred_at` fallback, but it is not a hard relevance gate.
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

## Scope Modes

| Mode | Configuration | Search Behavior |
|------|---------------|-----------------|
| **Location-only** | `location` set, no `criteria` | Local news terms in that location |
| **Criteria-only** | `criteria` set, no `location` | Criteria searches globally |
| **Combined** | Both `location` and `criteria` | Criteria searches scoped to location |

**Validation:** At least one of `location` or `criteria` must be provided (enforced by `BeatSearchRequest` and `BeatExecuteRequest`).

## Source Modes

Source mode changes ranking, filtering, target count, and Exa category mapping. Exa is the retrieval port for all beat discovery — see [Retrieval Port](#retrieval-port).

| Mode | Firecrawl source | Exa category | Discovery | Date Window | AI Target | Domain Cap |
|---|---|---|---|---|---|---|
| **niche** | web only | `personal site` | LLM-generated discovery queries | 14d (28d fallback) | 5-6 | 2/domain |
| **reliable** | web only | `news` | Limited discovery, depending on generated query plan | 14d (28d fallback) | 6-8 | 3/domain |

## Retrieval Port

Exa `/search` is the **sole** retrieval port for Beat discovery. The former
Firecrawl retrieval kill-switch is **retired**: `resolveBeatRetrievalPort`
(`_shared/exa.ts`) always returns `"exa"`, and a lingering
`BEAT_RETRIEVAL=firecrawl` or `scouts.metadata.retrieval="firecrawl"` request is
logged (`firecrawl_retrieval_deprecated`) and ignored.

Beat **search is Exa-only** — it never uses Firecrawl:

- **Low-coverage retry (Exa).** When an Exa run discovers `< 2` final candidates
  (`shouldFallbackFromExa`), it retries Exa with the more thorough `deep-lite`
  tier rather than falling back to Firecrawl (audit 2026-07-07: Firecrawl search
  on those niche queries returned ~0). `retrieval` stays `"exa"`. Opt out
  per-scout with `scouts.metadata.exa_fallback=false`.
- **Priority sources** are scoped with Exa `includeDomains` (not a `site:`
  operator, which Exa treats as literal text) — identical on the preview and the
  scheduled runner.

Firecrawl survives in Beat as exactly **one** thing — the **anti-bot scrape
fallback**: discovered article URLs are scraped through the crawl4ai
scrape-service (`scrape()` in `_shared/scrape.ts`); when a host blocks it
(Cloudflare/DataDome/Imperva) that single scrape retries via Firecrawl
(`isAntiBotBlockedError`). Every run stamps `scrape_served_crawl4ai` /
`scrape_served_firecrawl` into `scout_runs.metadata`, and `benchmark-beat`
asserts crawl4ai actually served and that retrieval stayed Exa.

`BEAT_AB_SHADOW=1` (or `scouts.metadata.beat_ab_shadow=true`) still runs an
alternate-port shadow through discovery/filtering only and writes a
`beat_ab_runs` row.

## Search Relevance Guardrails

The production default is intentionally simpler than the earlier fan-out design:

- Run all generated and discovery queries through Exa search (the sole retrieval port; see [Retrieval Port](#retrieval-port)) — never Firecrawl search.
- Forward the scout's geography via Exa `userLocation`/`category` when the scout has a location.
- Let the LLM query plan translate/localize queries for non-English locations instead of hardcoding country-specific terms.
- Pass `canonical_query`, `localized_query`, `required_concepts`, and `weak_terms` from query generation into the AI relevance filter.
- For compound topics, the AI filter must require all major concepts. A result matching only a weak generic term such as `AI`, `policy`, `technology`, or `media` is not enough.
- Measure quality by relevance/locality/manual review, not by result count alone.

The regression that motivated this rule: a topic-only Beat Scout for `AI in journalism` returned broad AI stories about the Pentagon, Oscars rules, school boards, and city councils. Those results matched generic `AI` terms but not the journalism/newsroom concept. The fix is covered by the live benchmark canary `topic-only:ai-journalism`; ongoing coverage lives in `docs/supabase/benchmarks.md` and `scripts/benchmarks/`.

Future experiments may reintroduce `news` only as a separately ranked freshness lane with its own relevance gate and audit evidence. It should not be blindly merged into the default result set.

### Recency Config by Scope

All scope/mode combinations use a **standard 14-day initial window**. When all dated articles fall outside this window, a **28-day relaxed fallback** is applied (capped at the 90-day absolute floor).

| Scope | Mode | Initial Window | Relaxed Fallback |
|-------|------|----------------|------------------|
| all | all | 14 days | 28 days |

All dated articles must also pass a **90-day absolute staleness floor** regardless of the window.

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

### `beat_ab_runs`

Canary retrieval evidence is stored in `beat_ab_runs`:

| Field | Meaning |
|---|---|
| `retrieval` | `firecrawl` or `exa` |
| `raw_hit_count` / `dated_hit_count` / `final_hit_count` | Retrieval quality counters |
| `locality_score` / `freshness_score` | Deterministic scoring for canary comparison |
| `total_cost_dollars` | Exa response cost when provided |
| `metadata.shadow` | `true` when row was produced by discovery-only A/B shadow |
| `metadata.fallback_reason` | e.g. `exa_low_coverage` |

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
deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-beat.ts
deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-beat.ts --scout-id <existing-beat-scout-uuid>
deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-beat.ts --timeout-min 8
deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-beat.ts --scenario ai-journalism --timeout-min 10 --verbose
```

The default run checks six canaries (location-only, two topic-only, topic+country,
topic+city, second topic+country) through both preview search and scheduled
execution. It retries a canary once on likely transient infra failures such as a
run timeout or zero-result response, but still fails hard on semantic drift.
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
