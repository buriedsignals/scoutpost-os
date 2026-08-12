# Page Scout Service (type `web`)

> **Naming:** In the UI, this appears as "Page Scout". The backend type code is `web`.

Website monitoring with change detection and criteria matching.

## Overview

Page Scouts monitor specific URLs for content changes. Users choose between two modes:
- **Any Change**: Notifies on any alertable normalized comparison-content change (criteria is null, skips LLM analysis)
- **Specific Criteria**: Notifies only when changes match user-defined criteria (LLM-analyzed)

The current UI opens on **Specific Criteria** so journalists state what matters
before testing the page. **Any Change** remains available as an explicit choice
and for legacy/API requests with empty criteria; the UI warns that pages without
a reliable main-content landmark can still produce page-chrome noise.

Uses the configured scrape port (Crawl4AI with the existing Firecrawl anti-bot
fallback), but Page Scout change detection is owned locally by Scoutpost:
the unmodified provider markdown is retained while a quality-gated semantic
projection is canonicalized, version-hashed, and compared against the latest
successful per-source `raw_captures` baseline. Firecrawl
Cloud remains available only through the classified anti-bot fallback or the
operator-wide `SCRAPE_PROVIDER=firecrawl` compatibility switch.

## Change Detection and Renderer Attribution

Page Scouts have one change-detection strategy: a fresh provider-port scrape
followed by a local canonical-hash comparison. There is no per-scout provider
setting. The configured primary renderer is an operator concern, while the
renderer that actually served a fetch is recorded per run as
`scrape_provider_served`.

### Canonical Hashing

Provider markdown is not hashed directly for change detection. On Crawl4AI
renders, when rendered HTML exposes a substantial `main`, `[role=main]`, or
single/dominant `article`, Page Scout compares that projection. It falls back
to the complete rendered document when the candidate is absent, too small, or
cannot be converted safely. The unmodified provider markdown is retained for
evidence, extraction, and child-link discovery in either case. A Firecrawl
anti-bot fallback labels its existing `onlyMainContent` output as
`provider_main`; that provider does not supply a separate complete Markdown
document on that path.

The Page Scout canonicalizer then removes deterministic scrape noise before
hashing:

- image markdown and image CDN URL churn
- placeholder/static asset URL churn
- relative timestamps such as "34 mins ago"
- zero-width/non-breaking-space and equivalent Unicode presentation churn
- unordered-list marker changes (`*`/`+`/`-`)
- known tracking query parameters while preserving locale parameters such as
  `hl` and `gl`
- bare whole-line renderer IDs (long decimal, hex, or UUID values)
- whitespace-only differences

It preserves ordinary text, headings, publication dates, and article links. The
canonicalizer is versioned (`web-md-v2`) and stored alongside each baseline in
`raw_captures.canonicalizer_version`.

Page Scout deterministically classifies same-scope line/rank reordering and
same-scope duplicate-only count changes as non-alerting noise. This hard gate
applies to both Any Change and Specific Criteria, and the criteria model is not
called for those deltas. Moving or copying identical wording across Markdown
sections remains alertable because it can change the locale, entity, or policy
scope to which a rule applies. Mixed deltas retain exact `MOVED` evidence plus
occurrence counts, surrounding context, and nearest headings for criteria
evaluation.

## Execution Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    PAGE SCOUT EXECUTION                          │
│                                                                 │
│  Trigger: pg_cron → execute-scout EF → scout-web-execute        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Stage 1: Change Detection                                      │
│  ├─ Fresh provider-port scrape (cache bypassed)                 │
│  ├─ Quality-gated main-content projection (or full fallback)    │
│  ├─ Canonical SHA-256 comparison against raw_captures           │
│  └─ Returns: "new" | "changed" | "same"                         │
│           │                                                     │
│           │ If root is same and no known/discovered children →  │
│           │ return early. Known index children are still due.   │
│           ▼                                                     │
│  Stage 2: Scope + per-source comparison                         │
│  ├─ Exact page: compare configured URL only                     │
│  └─ Genuine index: follow strict descendants one hop, rotate    │
│      fairly under the cap, and compare each child independently │
│           ▼                                                     │
│  Stage 3: Alert decision from normalized delta                  │
│  ├─ Hard-filter same-scope reorder/duplicate-only noise         │
│  ├─ Any Change: any remaining normalized content delta          │
│  └─ Specific Changes: structured match on ADDED/REMOVED/MOVED   │
│      (no generated description is required)                     │
│           ▼                                                     │
│  Stage 4: Optional unit enrichment + deduplication              │
│  ├─ Extract atomic units after the alert decision               │
│  ├─ Upsert through canonical unit dedup                         │
│  └─ Zero/duplicate units cannot veto a qualifying alert         │
│           ▼                                                     │
│  Stage 5: One aggregated notification                           │
│  ├─ Store scout_run diagnostics                                 │
│  ├─ Store raw_captures + information_units                      │
│  ├─ Render exact source URLs + deterministic before/after text   │
│  └─ Decrement credits via Supabase RPC                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Location | Purpose |
|------|----------|---------|
| `scout-web-execute/index.ts` | `supabase/functions/` | Main scheduled/run-now Page Scout pipeline |
| `scouts/index.ts` | `supabase/functions/` | Scout CRUD, preview/test, run, pause/resume |
| `_shared/scrape.ts` | `supabase/functions/` | Provider port and classified anti-bot fallback policy |
| `_shared/web_content_canonical.ts` | `supabase/functions/` | Versioned markdown canonicalizer |
| `_shared/web_scout_baseline.ts` | `supabase/functions/` | Schedule-time baseline establishment |
| `_shared/page_scout_change.ts` | `supabase/functions/` | Deterministic normalized delta and alert decision |
| `_shared/page_scout_criteria.ts` | `supabase/functions/` | Structured Specific Changes delta matcher |
| `app/main_content.py` | `scrape-service/` | Language-independent semantic-main projection and quality gate |
| `_shared/subpage-filter.ts` | `supabase/functions/` | Strict descendant scope and primary-content discovery |
| `_shared/atomic_extract.ts` | `supabase/functions/` | Atomic unit extraction |
| `_shared/notifications.ts` | `supabase/functions/` | Localized email notifications |

## Deduplication Mechanisms

### Layer 1: Local canonical hash baseline
- The fresh provider-port scrape bypasses the default provider cache for Page Scout
  change detection.
- Canonical comparison-markdown hash is compared with the latest
  `raw_captures` baseline for the same canonicalizer version and projection
  strategy. A strategy transition silently establishes a comparable baseline
  instead of emitting a synthetic whole-document change.
- Raw markdown hash is still stored for diagnostics and content dedup context.

### Layer 2: Canonical unit deduplication
- Extracted facts are upserted through the canonical unit path.
- Duplicate source/fact occurrences merge into existing units instead of
  creating repeated inbox items.
- Within-run embedding dedup drops near-duplicate extracted statements before
  unit upsert.

### Runtime Guardrails

- Page Scout renderer calls are client-side bounded; fresh scrapes abort if
  the renderer stalls.
- OpenRouter extraction and embedding calls are bounded so a provider stall cannot leave the run row in `running` indefinitely.
- Listing-page Phase B subpage-follow runs under a total wall-clock budget and
  per-subpage scrape cap instead of unbounded sequential fetches. Candidate
  selection uses prior capture and attempt times, so failed, zero-unit, and
  deduplicated children cannot monopolize every run.
- The configured URL and every renderer-reported effective child URL are
  validated before comparison, persistence, extraction, archiving, or alerting.
- Run metadata reports candidate, checked, scraped, failed, and
  `coverage_complete` values; partial coverage is never labelled complete.

## Preview vs Scheduled Mode

| Mode | Baseline | Notifications | Credits |
|------|----------|---------------|---------|
| **Preview** (Test button) | Fresh scrape + summary; no baseline persisted | Never sent | Not charged |
| **Scheduled** | Server establishes local canonical baseline at scout creation/scheduling | Sent if criteria match on later changes | Charged on runs |
| **Run Now** (Manual) | Uses a valid canonical baseline; repairs missing historical state without alerting or charging | Sent if criteria match on later runs | Charged only after baseline readiness |

## Schedule-Time Baseline

When the user schedules a Page Scout, the server establishes the local
canonical baseline before the schedule is enabled. Run Now does not create the
first baseline for a healthy Scout. As a migration guard, an older Scout whose
timestamp or valid current capture is missing is repaired as a baseline-only,
uncharged run.

For a genuine listing/index, the configured scout URL remains the index URL,
but each child keeps its own successful canonical baseline. Child captures,
units, alert links, and archive evidence retain the exact effective child URL.
A child linked during initial index establishment is a silent baseline; a child
first linked later is evaluated as an addition.

## Source Dates

Page Scout uses the shared `_shared/atomic_extract.ts::sourcePublishedDate` helper before extracting and inserting information units. The helper tries renderer metadata first, then a visible publication date near the top of markdown, then returns `null`. Extracted facts still prefer the LLM-provided event date, but `information_units.occurred_at` falls back to this source publication date when the fact has no more specific date.

## Database Records

### `raw_captures`

Stores the unmodified provider markdown and the optional focused comparison
document. Page Scout rows include:

- `content_md` / `content_sha256` — unmodified provider evidence markdown and raw hash
- `comparison_md` — focused comparison markdown; null for the complete-document fallback
- `comparison_strategy` — `main`, `role_main`, `article`, `provider_main`, or `full`
- `canonical_content_sha256` — versioned hash of the comparison document
- `canonicalizer_version` — e.g. `web-md-v2`
- `expires_at` — raw capture retention cutoff

The ordinary 30-day TTL still bounds raw-capture history, but cleanup pins the
newest successful canonical capture for each Page Scout source. Before 90-day
run cleanup, that capture is detached from its expiring run, so paused scouts
and rotated index children retain one comparison baseline for the scout's
lifetime. Deleting the scout still deletes those captures.

### `scout_runs`

Stores run lifecycle, stage, notification, and diagnostic fields. When
archiving is on, the background capture writes `snapshot_status` (and, on
success, `snapshot_id`/`snapshot_fidelity`) into `scout_runs.metadata` — a
diagnostic only; it never changes the run outcome.
Index runs additionally write bounded `page_snapshot_sources` diagnostics per
exact source, while the legacy scalar snapshot diagnostics continue to describe
the root only.

Initial index membership is first-write-wins in
`scouts.metadata.page_scout_initial_candidates`; it is not derived from
expiring run diagnostics. The last authoritative root membership is stored in
`scouts.metadata.page_scout_active_candidates`, so removed children are not
resurrected from historical captures on a later unchanged run.

## Evidence Archiving (Page Archive)

> **Retrieving snapshots and toggling archiving** (UI / CLI `scout snapshots` /
> MCP `list_snapshots`+`get_snapshot_url` / REST) is documented in
> [`page-archive.md`](page-archive.md), including the UI⇄agent capability map. This
> section covers the capture/storage internals.

Opt-in, per-scout **evidence-grade snapshots** of the page updating. Gated on
`scouts.archive_enabled` and a Pro/Team tier (OSS: available to everyone);
`scouts.wayback_enabled` (default true) is the per-scout opt-out from public
Internet Archive submission. Dark by default — no scout captures until a user
enables it.

**When it captures:** the configured root gets a baseline snapshot at
archive-enabled creation or on the false→true archive transition, and a
run/raw-capture-bound change snapshot on canonical `changed`/`new` runs.
Snapshot eligibility follows the canonical change—not criteria matching,
generated units, or notification delivery. Followed children get independently
URL-bound baseline/change snapshots; enabling archive later creates one
non-retroactive child baseline on its next unchanged check. Capture runs in the
**background** (`EdgeRuntime.waitUntil`) after the run is marked success and its
notification is sent.

**Two-fetch flow (KTD2 / Decision 10):** the detection scrape stays the
change-detection baseline, raw capture, and extraction input. On a gated
`changed`/`new` run, a second **provider-pinned** capture fetch
(`snapshot: true`, anti-bot fallback disabled) produces the archived artifacts —
its own MHTML + full-page screenshot + markdown. The detection and capture
markdowns diverge on lazy-load pages (the capture fetch's full-page scan pulls
lazy content into the DOM); that divergence is expected and never flags a
change.

**Fidelity tiers (KTD9):**

| `fidelity` | Source | Artifacts |
|---|---|---|
| `full` | crawl4ai local render | MHTML + full-page PNG (verbatim) + `.md` |
| `rendered_thirdparty` | Firecrawl anti-bot fallback, same fetch | rawHtml + full-page PNG (verbatim) + `.md` |
| `markdown_only` | any capture failure (degrade) | `.md` content record only |

A capture-eligible change degrades to a `markdown_only` record when richer
artifacts are unavailable. On
anti-bot-walled hosts (served by the Firecrawl fallback), the alert-firing fetch
itself carries the same-fetch rawHtml + screenshot (KTD9) — no local render is
possible. Firecrawl's `screenshot`/`rawHtml` formats add **no** extra credits
over a plain scrape (verified against Firecrawl billing, 2026-07-07); the
fallback's cost driver is its proxy mode, not the capture formats.

Each source capture and trust operation is failure-isolated. Capture diagnostics
are persisted before the slower TSA/Wayback work. Root-only alerts retain the
general archive CTA; any alert involving a child omits that CTA until the
notification can resolve an exact-child snapshot target, so root evidence is
never presented as evidence for a child.

Persistence, hashing, storage layout, RLS, and the deletion contract live in
`page_snapshots` + the `page-snapshots` bucket (see
`docs/supabase/retention.md`). Scout deletion sweeps the bucket objects (a DB
cascade can only remove the rows).

## Credit Cost

| Operation | Credits |
|-----------|---------|
| Scheduled execution | 1 |
| Run Now | 1 |
| Preview/Test | 0 |

## Related Docs

- `docs/supabase/edge-functions.md`
- `docs/supabase/scouts-runs.md`
