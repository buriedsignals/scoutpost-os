# Page Scout Service (type `web`)

> **Naming:** In the UI, this appears as "Page Scout". The backend type code is `web`.

Website monitoring with change detection and criteria matching.

## Overview

Page Scouts monitor specific URLs for content changes. Users choose between two modes:
- **Any Change**: Notifies on any content change (criteria is null, skips LLM analysis)
- **Specific Criteria**: Notifies only when changes match user-defined criteria (LLM-analyzed)

The current UI opens on **Specific Criteria** so journalists state what matters
before testing the page. **Any Change** remains available as an explicit choice
and for legacy/API requests with empty criteria.

Uses Firecrawl `/scrape` as the fetch/render provider, but Page Scout change
detection is owned locally by Scoutpost: fresh markdown is canonicalized,
version-hashed, and compared against the latest `raw_captures` baseline.
Firecrawl `changeTracking` remains a legacy migration path for older scouts.

## Change Detection Provider

The live Page Scout provider values are:

| Provider | Method | Change Detection | When Used |
|----------|--------|------------------|-----------|
| `firecrawl_plain` | Fresh Firecrawl scrape (`maxAge: 0`, `storeInCache: false`) | Local canonical markdown SHA-256 | Default for new Page Scouts |
| `firecrawl` | Firecrawl `changeTracking` format | Firecrawl remote baseline diff | Legacy scouts during migration |

The `firecrawl_plain` name is historical. It now means "Firecrawl scrape
provider + Scoutpost local hash detector" for Page Scouts.

### Canonical Hashing

Raw Firecrawl markdown is not hashed directly for change detection. The Page
Scout canonicalizer removes known scrape-noise before hashing:

- image markdown and image CDN URL churn
- placeholder/static asset URL churn
- relative timestamps such as "34 mins ago"
- whitespace-only differences

It preserves ordinary text, headings, publication dates, and article links. The
canonicalizer is versioned (`web-md-v1`) and stored alongside each baseline in
`raw_captures.canonicalizer_version`.

Firecrawl `changeTracking` is still supported for existing `provider =
"firecrawl"` scouts. On a successful run, those scouts write a local canonical
baseline and switch to `firecrawl_plain`. Failed Firecrawl changeTracking runs
do not silently migrate.

## Execution Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    PAGE SCOUT EXECUTION                          │
│                                                                 │
│  Trigger: pg_cron → execute-scout EF → scout-web-execute        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Stage 1: Change Detection                                      │
│  ├─ If provider = "firecrawl_plain":                            │
│  │   ├─ Fresh Firecrawl scrape (cache bypassed)                 │
│  │   └─ Canonical SHA-256 comparison against raw_captures       │
│  ├─ If provider = "firecrawl":                                  │
│  │   ├─ Legacy Firecrawl changeTracking scrape                  │
│  │   └─ On success, write local canonical baseline + migrate    │
│  └─ Returns: "new" | "changed" | "same"                         │
│           │                                                     │
│           │ If "same" → return early (no notification)          │
│           ▼                                                     │
│  Stage 2: Criteria Analysis                                     │
│  ├─ If criteria is null ("Any Change" mode):                    │
│  │   └─ Auto-match, summary = "Page content updated"            │
│  ├─ If criteria is set ("Specific Criteria" mode):              │
│  │   ├─ Analyze markdown content against criteria (GPT-4o-mini) │
│  │   └─ Returns: {matches: bool, summary: string}               │
│  │       │                                                      │
│  │       │ If !matches → return early (no notification)         │
│           ▼                                                     │
│  Stage 3: Unit Deduplication                                    │
│  ├─ Extract atomic units                                        │
│  ├─ Upsert through canonical unit dedup                         │
│  └─ Merge duplicates instead of inserting repeated facts        │
│           ▼                                                     │
│  Stage 4: Notification                                          │
│  ├─ Store scout_run diagnostics                                 │
│  ├─ Store raw_captures + information_units                      │
│  ├─ Send localized email (user's preferred_language)            │
│  └─ Decrement credits via Supabase RPC                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Location | Purpose |
|------|----------|---------|
| `scout-web-execute/index.ts` | `supabase/functions/` | Main scheduled/run-now Page Scout pipeline |
| `scouts/index.ts` | `supabase/functions/` | Scout CRUD, preview/test, run, pause/resume |
| `_shared/firecrawl.ts` | `supabase/functions/` | Firecrawl scrape wrapper |
| `_shared/web_content_canonical.ts` | `supabase/functions/` | Versioned markdown canonicalizer |
| `_shared/web_scout_baseline.ts` | `supabase/functions/` | Schedule-time baseline establishment |
| `_shared/atomic_extract.ts` | `supabase/functions/` | Atomic unit extraction |
| `_shared/notifications.ts` | `supabase/functions/` | Localized email notifications |

## Deduplication Mechanisms

### Layer 1: Local canonical hash baseline
- Fresh Firecrawl scrape bypasses the default provider cache for Page Scout
  change detection.
- Canonical markdown hash is compared with the latest `raw_captures` baseline
  for the same canonicalizer version.
- Raw markdown hash is still stored for diagnostics and content dedup context.

### Layer 2: Canonical unit deduplication
- Extracted facts are upserted through the canonical unit path.
- Duplicate source/fact occurrences merge into existing units instead of
  creating repeated inbox items.
- Within-run embedding dedup drops near-duplicate extracted statements before
  unit upsert.

### Runtime Guardrails

- Page Scout Firecrawl calls are client-side bounded; fresh scrapes abort if
  Firecrawl stalls.
- OpenRouter extraction and embedding calls are bounded so a provider stall cannot leave the run row in `running` indefinitely.
- Listing-page Phase B subpage-follow runs under a total wall-clock budget and per-subpage scrape cap instead of unbounded sequential fetches.

## Preview vs Scheduled Mode

| Mode | Baseline | Notifications | Credits |
|------|----------|---------------|---------|
| **Preview** (Test button) | Fresh scrape + summary; no baseline persisted | Never sent | Not charged |
| **Scheduled** | Server establishes local canonical baseline at scout creation/scheduling | Sent if criteria match on later changes | Charged on runs |
| **Run Now** (Manual) | Uses the saved creation-time baseline; never bootstraps a missing baseline | Sent if criteria match | Charged |

## Schedule-Time Baseline

When the user schedules a Page Scout, the server establishes the local
canonical baseline before the schedule is enabled. Run Now does not create the
first baseline, because that would make the first manual run look like a
successful no-op while silently changing future alerts.

If a listing/index page changes and Phase B follows matching subpages, the configured scout URL remains the index URL, but each extracted unit and its raw capture are attributed to the exact article/subpage URL that produced the fact.

## Source Dates

Page Scout uses the shared `_shared/atomic_extract.ts::sourcePublishedDate` helper before extracting and inserting information units. The helper tries Firecrawl scrape metadata first, then a visible publication date near the top of markdown, then returns `null`. Extracted facts still prefer the LLM-provided event date, but `information_units.occurred_at` falls back to this source publication date when the fact has no more specific date.

## Database Records

### `raw_captures`

Stores the scraped markdown used for baseline comparison and source
traceability. Page Scout rows include:

- `content_sha256` — raw markdown hash
- `canonical_content_sha256` — versioned canonical markdown hash
- `canonicalizer_version` — e.g. `web-md-v1`
- `expires_at` — raw capture retention cutoff

### `scout_runs`

Stores run lifecycle, stage, notification, and diagnostic fields. When
archiving is on, the background capture writes `snapshot_status` (and, on
success, `snapshot_id`/`snapshot_fidelity`) into `scout_runs.metadata` — a
diagnostic only; it never changes the run outcome.

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

**When it captures (R4):** at schedule-time baseline establishment and on runs
whose change status is `changed`/`new`. Never on `same` runs (~75%), never in
preview/test. Capture runs in the **background** (`EdgeRuntime.waitUntil`) after
the run is marked success and its notification is sent, so a capture fetch —
which can take tens of seconds — never delays or endangers the run or the alert
(R11).

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

A notified change **always** leaves at least a `markdown_only` record. On
anti-bot-walled hosts (served by the Firecrawl fallback), the alert-firing fetch
itself carries the same-fetch rawHtml + screenshot (KTD9) — no local render is
possible. Firecrawl's `screenshot`/`rawHtml` formats add **no** extra credits
over a plain scrape (verified against Firecrawl billing, 2026-07-07); the
fallback's cost driver is its proxy mode, not the capture formats.

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
