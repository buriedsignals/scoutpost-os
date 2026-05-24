# Retrieval Ports

Scoutpost keeps retrieval provider selection explicit so provider migrations do
not rewrite scheduling, credits, canonical-unit dedup, or notification behavior.

## Beat Scout

Beat Scout has two retrieval ports:

| Port | Status | Purpose |
|---|---|---|
| `exa` | **Default** | Exa `/search` Beat retrieval. |
| `firecrawl` | Kill-switch / per-scout opt-out | Original Firecrawl-compatible discovery path. Still fully wired; selected via env or scout metadata. |

The pipeline lives in `_shared/beat_pipeline.ts`. The previous `beat_pipeline.ts`
facade re-exporting `beat_pipeline_legacy.ts` was deleted on 2026-05-24 once Exa
became the default — there is no longer a "legacy" file.

## Controls

| Control | Scope | Behavior |
|---|---|---|
| `BEAT_RETRIEVAL=firecrawl` | Global | **Kill-switch.** Forces every Beat run back to Firecrawl. Set as a Supabase Edge Function secret to flip without a code deploy. |
| `BEAT_RETRIEVAL=exa` | Global | Pins to Exa (same as default; useful for asserting intent). |
| `scouts.metadata.retrieval = "firecrawl"` | Per scout | Opt one scout out of Exa (e.g. a scout that consistently underperforms on Exa for known structural reasons). |
| `scouts.metadata.retrieval = "exa"` | Per scout | Pin one scout to Exa (defensive — same as default). |
| `scouts.metadata.exa_fallback = false` | Per scout | Disable the runtime low-coverage fallback for this scout. |
| `BEAT_AB_SHADOW=1` | Global | Discovery-only shadow logging of the alternate port. Surviving canary-phase telemetry; candidate for deletion in a follow-up cleanup. |

## Runtime fallback

Exa occasionally returns very few hits for sparse locations. If an Exa run
yields fewer than 2 candidates and the run wasn't forced via global env:

1. A row is written to `beat_ab_runs` with `metadata.fallback_reason = "exa_low_coverage"`.
2. The current execution re-runs through Firecrawl so the scout still gets fresh
   units this cycle.
3. After three consecutive low-coverage Exa rows, the scout's metadata is set to
   `retrieval = "firecrawl"` — a per-scout latch that survives until cleared.

Item (3) was originally canary protection. With Exa as default, the latch is
debatable — it can mask Exa improvements over time. Tracking removal as a
follow-up cleanup, gated on seeing how many scouts actually latch in
production.

## Metrics

`beat_ab_runs` is the canary/audit table:

| Field | Meaning |
|---|---|
| `retrieval` | `firecrawl` or `exa` |
| `raw_hit_count` | Search hits before local filtering |
| `dated_hit_count` | Raw hits with provider publication dates |
| `final_hit_count` | Hits selected for downstream scraping/extraction |
| `locality_score` | Fraction of final hits matching configured location text |
| `freshness_score` | Fraction of raw hits with dates |
| `total_cost_dollars` | Exa response cost when returned by the API |
| `metadata.shadow` | Discovery-only A/B shadow row |
| `metadata.fallback_reason` | Why the run ended up here (e.g. `exa_low_coverage`) |

## Rollback playbook

If Exa goes wrong in production:

1. `supabase secrets set BEAT_RETRIEVAL=firecrawl --project-ref <project-ref>`
2. Wait one Beat run cycle and confirm `beat_ab_runs.retrieval='firecrawl'` for
   recent rows.
3. Investigate, fix, then `supabase secrets unset BEAT_RETRIEVAL` to restore the
   Exa default.

No code deploy needed for the rollback — the kill switch is read on every
beat run.
