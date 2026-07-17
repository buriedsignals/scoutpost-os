# Civic Scout Service (type `civic`)

> **Naming:** In the UI, this appears as "Track a Council". The backend type code is `civic`.
> **Tier:** Requires Pro plan. Free-tier users see the option with a "PRO" badge and are redirected to pricing.

Civic Scouts monitor official council pages for meeting agendas, minutes, PDFs, and promise-shaped commitments. The current runtime is Supabase-first: schedules live in `pg_cron`, scout runs enter Supabase Edge Functions, extracted facts become canonical `information_units`, and promises are tracked in the `promises` table.

## Current Runtime

| Stage | Runtime | Primary files |
| --- | --- | --- |
| URL discovery and preview | FastAPI/UI helper plus `civic-test` Edge Function | `backend/app/routers/civic.py`, `supabase/functions/civic-test/` |
| Scheduled execution | Supabase `execute-scout` -> `civic-execute` | `supabase/functions/execute-scout/`, `supabase/functions/civic-execute/` |
| Async extraction | Supabase queue + worker | `civic_extraction_queue`, `supabase/functions/civic-extract-worker/` |
| Run and fact storage | Supabase Postgres | `scout_runs`, `raw_captures`, `information_units`, `unit_occurrences`, `promises` |
| Due promise digest | Supabase Edge Function | `supabase/functions/promise-digest/` |

Do not model new civic work around Lambda, EventBridge, DynamoDB `SCRAPER#` records, or `PROMISE#` records. Those names are migration history.

## UI Flow

```
1. Start search
   User enters a council domain.
   Firecrawl Map discovers candidate URLs.
   An LLM ranks likely meeting index pages.
   User selects official tracked URLs.

2. Test extraction
   User optionally enters criteria.
   `civic-test` resolves meeting documents, parses a small sample, and previews promises.
   No scout is scheduled and no persistent promise rows are required for preview.

3. Schedule scout
   `scouts` creates the scout row and stores tracked URLs / criteria / initial promises.
   `manage-schedule` creates the Supabase cron schedule.
   Baselines and processed URL state are held on the scout and related Supabase tables.
```

## Execution Flow

```
pg_cron/pg_net
  -> execute-scout
  -> civic-execute
       - scrape tracked listing pages with Firecrawl change tracking
       - parse same-domain document links from listing HTML
       - classify meeting documents with keyword stage and LLM fallback
       - enqueue unseen documents in civic_extraction_queue
       - refresh scout run / baseline metadata

civic-extract-worker
  -> claim_civic_queue_item() with FOR UPDATE SKIP LOCKED
  -> parse PDF/HTML via Firecrawl
  -> store raw_capture with 30-day expiry
  -> extract promise JSON with openRouterExtract (Google Gemini on Vertex)
  -> upsert canonical information_units / unit_occurrences
  -> upsert promises linked to unit_id
  -> append processed_pdf_urls only after successful extraction
```

The queue is deliberately asynchronous. A scheduled run may finish by enqueueing documents, while extraction and promise/unit writes complete in later worker ticks.

## Discovery And Extraction Rules

- Discovery should prefer official listing/archive pages over direct PDF URLs.
- Civic document parsing supports both PDF and HTML.
- The self-hosted parse path uses Poppler `pdftotext -layout` first. Only
  low-yield/scanned PDFs use Google's native PDF processing through OpenRouter;
  the native engine is forced so Mistral/Cloudflare parsing is never selected,
  otherwise the parser returns `needs_ocr`.
- Worker attempts are capped at 3. The failsafe resets stale `processing` rows after 30 minutes and eventually marks terminal failures.
- `scouts.processed_pdf_urls` is capped at 100 and is updated only after a successful extraction, so failed documents remain retryable.

## Promise Extraction

Two prompt modes are used:

| Mode | Behavior |
| --- | --- |
| No criteria | Extract every dated promise, budget item, commitment, investment, or accountability-relevant decision. |
| Criteria set | Extract only promises directly relevant to the journalist's criteria. Return an empty list when nothing matches. |

Date handling:

- Specific dates are high confidence.
- Year references resolve to year end with medium confidence.
- Quarter references resolve to quarter end with medium confidence.
- Relative dates resolve against the document date with low confidence.
- Items with no inferable date are filtered out.

Scraped document text is treated as data, not instructions. The worker wraps source text before LLM calls so prompt-injection strings embedded in council PDFs cannot override the extraction prompt.

## Data Model

| Table | Purpose |
| --- | --- |
| `scouts` | Civic scout configuration: tracked URLs, root domain, criteria, processed URL ring buffer, schedule metadata. |
| `scout_runs` | Per-run status, errors, timings, and counts. |
| `civic_extraction_queue` | Pending/processing/done/failed document extraction work. |
| `raw_captures` | Temporary extracted markdown/raw content with `expires_at`. |
| `information_units` | Canonical factual units created from newly extracted promises. |
| `unit_occurrences` | Source/provenance occurrences for canonical units. |
| `promises` | Promise tracker linked to `information_units.unit_id`, with `due_date`, `date_confidence`, and status. |

See `docs/supabase/civic-pipeline.md` for table columns, RPCs, cron jobs, and operational queries.

## Credit Costs

| Operation | Credits | Notes |
| --- | --- | --- |
| Discovery | 10 | Map API plus LLM ranking. |
| Test extraction | 0 | Validates and previews only. |
| Scheduled execution | 10 | Weekly/monthly only. Refunds when no documents are queued because tracked pages are unchanged or already processed. |

## Public API / Function Surface

| Surface | Purpose |
| --- | --- |
| `POST /api/civic/discover` | Browser-authenticated domain discovery and ranked URL candidates. |
| `POST /api/civic/test` | Browser-authenticated extraction preview. |
| `POST /functions/v1/civic-test` | Edge Function preview path for selected URLs. |
| `POST /functions/v1/civic-execute` | Scheduled or manual civic scout execution. |
| `POST /functions/v1/civic-extract-worker` | Queue worker; normally called by cron. |
| `POST /functions/v1/promise-digest` | Due-promise digest/notification path. |

## Key Files

| File | Purpose |
| --- | --- |
| `frontend/src/lib/components/news/CivicScoutView.svelte` | 3-step UI. |
| `backend/app/routers/civic.py` | FastAPI discovery/test compatibility endpoints. |
| `supabase/functions/civic/` | Shared civic helpers/API surface. |
| `supabase/functions/civic-test/` | Extraction preview. |
| `supabase/functions/civic-execute/` | Scheduled run kickoff and document enqueueing. |
| `supabase/functions/civic-extract-worker/` | Queue claim, parse, extract, write units/promises. |
| `docs/supabase/civic-pipeline.md` | Current queue, cron, RPC, and operations reference. |

## Related Docs

- `docs/supabase/civic-pipeline.md`
- `docs/supabase/scouts-runs.md`
- `supabase/migrations/00020_civic_queue_rpc.sql`
- `supabase/migrations/00021_civic_worker_cron.sql`
