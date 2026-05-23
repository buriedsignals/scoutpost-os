# Retrieval Ports

Scoutpost keeps retrieval provider selection explicit so provider migrations do
not rewrite scheduling, credits, canonical-unit dedup, or notification behavior.

## Beat Scout

Beat Scout currently has two retrieval ports:

| Port | Status | Purpose |
|---|---|---|
| `firecrawl` | Default | Existing Firecrawl-compatible Beat discovery path. |
| `exa` | Canary | Exa `/search` replacement for Beat retrieval only. |

The stable code import is `_shared/beat_pipeline.ts`. It is intentionally a
small facade while `_shared/beat_pipeline_legacy.ts` holds the deprecated
Firecrawl-compatible 8-stage implementation. The legacy file remains until live
Exa benchmarks prove the replacement and the default is flipped.

## Controls

| Control | Scope | Behavior |
|---|---|---|
| `scouts.metadata.retrieval = "exa"` | Per scout | Run this scout through Exa retrieval unless an env override wins. |
| `scouts.metadata.retrieval = "firecrawl"` | Per scout | Keep this scout on Firecrawl. |
| `BEAT_RETRIEVAL=exa` | Global | Force Exa for all Beat runs. |
| `BEAT_RETRIEVAL=firecrawl` | Global | Kill switch back to Firecrawl for all Beat runs. |
| `BEAT_AB_SHADOW=1` | Global | Run the alternate port through discovery/filtering and write a shadow `beat_ab_runs` row. |
| `scouts.metadata.beat_ab_shadow=true` | Per scout | Enable discovery-only A/B shadow for one scout. |
| `scouts.metadata.exa_fallback=false` | Per scout | Disable low-coverage Exa fallback for one scout. |

## Fallback

If a scout-requested Exa run finds fewer than two final candidates and
`BEAT_RETRIEVAL=exa` is not forcing Exa globally:

1. The executor writes an Exa `beat_ab_runs` row with
   `metadata.fallback_reason = "exa_low_coverage"`.
2. The current execution falls back to Firecrawl.
3. After three consecutive low-coverage Exa rows, the scout metadata is updated
   to `retrieval = "firecrawl"`.

This protects existing Beat scouts from silent low-coverage canary regressions
without re-baselining or changing canonical-unit dedup.

## Metrics

`beat_ab_runs` is the comparison table for canary review:

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

The migration gate has already been satisfied: Exa beat Firecrawl on all 13
global audit scenarios with no critical regression on the hardest cases. The
one-off Exa-vs-Firecrawl comparison script was removed after that migration
decision; ongoing safety coverage now lives in the Beat benchmark, QA matrix,
and `beat_ab_runs` canary telemetry.
