# Beat Retrieval

Beat discovery uses one provider boundary: Firecrawl Cloud
`POST /v2/search`. Keeping preview and scheduled execution on the same shared
adapter prevents provider drift without changing scheduling, credits,
canonical-unit deduplication, or notification behavior.

The pipeline lives in `_shared/beat_pipeline.ts`; the Firecrawl request and
response adapter lives in `_shared/scrape_firecrawl.ts`.

## Runtime contract

- Generated Beat queries use Firecrawl Cloud `/v2/search`.
- Search defaults to web results. Existing local date, locality, source-quality,
  relevance, and deduplication filters remain authoritative.
- Priority-domain discovery uses `includeDomains`. Explicit source URLs bypass
  search and go directly to rendering.
- A search response with no useful results is a valid quiet run. If every query
  fails at the provider boundary, the run fails and its pre-charge is refunded.
- `scout_runs.metadata.retrieval` is stamped as `firecrawl` so the live
  benchmark can detect deployment drift.

There is no runtime provider selector, per-scout retrieval override,
low-coverage provider retry, or discovery shadow mode. Old
`BEAT_RETRIEVAL`, `BEAT_AB_SHADOW`, and Exa-specific scout metadata have no
live effect and should not be reintroduced.

## Search versus rendering

Discovery and page rendering have deliberately different responsibilities:

| Boundary | Primary | Fallback |
|---|---|---|
| Beat discovery | Firecrawl Cloud `/v2/search` | None |
| Page/article rendering | Self-hosted Crawl4AI scrape service | Firecrawl Cloud scrape for classified anti-bot failures only |

Crawl4AI remains the primary renderer because Scoutpost controls that narrow
self-hosted service and its output contract. Self-hosting Firecrawl merely to
combine search and scraping would add a larger AGPL service and would still
require a separately operated search backend for equivalent self-hosted search.
Firecrawl Cloud remains useful where its managed search index and anti-bot
capability are the product being consumed.

## Historical telemetry

Migration `00064` and the `beat_ab_runs` table remain in the database so old
retrieval-comparison rows stay readable. The current Beat runtime does not
write, consult, or require this table. Its `exa` values, fallback metadata, and
cost fields describe historical migrations only.

## Rollback playbook

Rollback is a code revert:

1. Revert the Firecrawl-search migration commit on a new branch.
2. Deploy `beat-search` and `scout-beat-execute` together.
3. Run the linked-project Beat benchmark and confirm the reverted
   `scout_runs.metadata.retrieval` contract.

Do not use an environment-variable provider switch. The retired Exa credential
must remain absent during normal operation; restoring an old implementation
also requires restoring its secret deliberately.
