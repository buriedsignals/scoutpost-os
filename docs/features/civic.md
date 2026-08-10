# Civic Scout Service (type `civic`)

> **Naming:** In the UI, this appears as "Track a Council". The backend type
> code is `civic`. **Tier:** Requires Pro plan. Free-tier users see the option
> with a "PRO" badge and are redirected to pricing.

Civic Scouts monitor official council documents for source-linked accountability
leads. They reject calendars, meeting logistics, procedural items, unadopted
proposals, and unsupported summaries. An adopted material decision becomes a
canonical fact lead; only an explicit, attributable future obligation with a
supported fulfilment date becomes a tracked promise.

## Current Runtime

| Stage                     | Runtime                                           | Primary files                                                                     |
| ------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| URL discovery and preview | FastAPI/UI helper plus `civic-test` Edge Function | `backend/app/routers/civic.py`, `supabase/functions/civic-test/`                  |
| Scheduled execution       | Supabase `execute-scout` -> `civic-execute`       | `supabase/functions/execute-scout/`, `supabase/functions/civic-execute/`          |
| Async extraction          | Supabase queue + worker                           | `civic_extraction_queue`, `supabase/functions/civic-extract-worker/`              |
| Run and fact storage      | Supabase Postgres                                 | `scout_runs`, `raw_captures`, `information_units`, `unit_occurrences`, `promises` |
| Due promise digest        | Supabase Edge Function                            | `supabase/functions/promise-digest/`                                              |

Do not model new civic work around Lambda, EventBridge, DynamoDB `SCRAPER#`
records, or `PROMISE#` records. Those names are migration history.

## UI Flow

```
1. Start search
   User enters a council domain.
   Bounded same-domain discovery finds candidate URLs.
   An LLM ranks likely meeting index pages.
   User selects official tracked URLs.

2. Test extraction
   User optionally enters criteria.
   `civic-test` resolves a bounded document sample and previews promises and material decisions.
   Preview is read-only. It returns an opaque, short-lived server-owned snapshot token.

3. Schedule scout
   `scouts` creates the scout row and stores tracked URLs / criteria. The client may
   request initial import with the preview token, never with extracted item text.
   `manage-schedule` creates the Supabase cron schedule.
   Baselines and processed URL state are held on the scout and related Supabase tables.
```

## Execution Flow

```
pg_cron/pg_net
  -> execute-scout
  -> civic-execute
       - scrape tracked listing pages through the provider port
       - compare versioned local canonical baselines per tracked URL
       - parse same-domain document links from listing HTML
       - classify meeting documents with keyword stage and LLM fallback
       - enqueue unseen documents in civic_extraction_queue
       - refresh scout run / baseline metadata

civic-extract-worker
  -> claim_civic_queue_item(worker_id, lease) with FOR UPDATE SKIP LOCKED
  -> renew heartbeat around expensive provider work and insert batches
  -> parse PDF/HTML through the document parse port
  -> store raw_capture with 30-day expiry
  -> extract and deterministically validate accountability candidates
  -> upsert canonical information_units / unit_occurrences
  -> upsert only policy-qualified promises linked to unit_id; decisions are facts
  -> finalize only while the worker still owns a live lease
  -> append processed_pdf_urls only after successful extraction
```

The queue is deliberately asynchronous. A scheduled run may finish by enqueueing
documents, while extraction and promise/unit writes complete in later worker
ticks. Expired leases are reclaimed; owner checks prevent a late worker from
finalizing work another worker has taken over.

## Discovery And Extraction Rules

- Discovery should prefer official listing/archive pages over direct PDF URLs.
- Civic document parsing supports both PDF and HTML.
- The self-hosted parse path uses Poppler `pdftotext -layout` first. Only
  low-yield/scanned PDFs use Google's native PDF processing through OpenRouter;
  the native engine is forced so Mistral/Cloudflare parsing is never selected,
  otherwise the parser returns `needs_ocr`.
- Worker attempts are capped at 3. The failsafe resets stale `processing` rows
  after 30 minutes and eventually marks terminal failures.
- `scouts.processed_pdf_urls` is capped at 100 and is updated only after a
  successful extraction, so failed documents remain retryable.

## Accountability Extraction

One versioned policy is shared by preview and production. It requires evidence,
operative authority, materiality, and criteria match. Promises additionally
require an actor, action, fulfilment-date source phrase, normalized due date,
and confidence. A meeting or publication date is never silently reused as a
deadline. Semantic zero after successful evaluation is a healthy result.

AI-extracted accountability leads must be verified against their cited official
evidence before publication. Fulfilled/broken status remains a human/editorial
judgment; Civic never infers it automatically.

## Data Model

| Table                    | Purpose                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `scouts`                 | Civic scout configuration: tracked URLs, root domain, criteria, processed URL ring buffer, schedule metadata. |
| `scout_runs`             | Per-run status, errors, timings, and counts.                                                                  |
| `civic_extraction_queue` | Pending/processing/done/failed document extraction work.                                                      |
| `raw_captures`           | Temporary extracted markdown/raw content with `expires_at`.                                                   |
| `information_units`      | Canonical factual units created from newly extracted promises.                                                |
| `unit_occurrences`       | Source/provenance occurrences for canonical units.                                                            |
| `promises`               | Promise tracker linked to `information_units.unit_id`, with `due_date`, `date_confidence`, and status.        |

See `docs/supabase/civic-pipeline.md` for table columns, RPCs, cron jobs, and
operational queries.

## Credit Costs

| Operation           | Credits | Notes                                                                                                               |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| Discovery           | 10      | Same-domain URL discovery plus LLM ranking.                                                                         |
| Test extraction     | 0       | Validates and previews only.                                                                                        |
| Scheduled execution | 10      | Weekly/monthly only. Refunds when no documents are queued because tracked pages are unchanged or already processed. |

## Public API / Function Surface

| Surface                                   | Purpose                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `POST /api/civic/discover`                | Browser-authenticated domain discovery and ranked URL candidates. |
| `POST /api/civic/test`                    | Browser-authenticated extraction preview.                         |
| `GET /api/civic/items`                    | Owner-scoped promise/decision leads and tracker state.            |
| `GET /api/civic/items/:id`                | One owner-scoped Civic item.                                      |
| `GET /api/civic/runs`                     | Safe aggregate Civic run diagnostics.                             |
| `GET /api/civic/runs/:id`                 | One safe aggregate Civic run diagnostic.                          |
| `POST /functions/v1/civic-test`           | Edge Function preview path for selected URLs.                     |
| `POST /functions/v1/civic-execute`        | Scheduled or manual civic scout execution.                        |
| `POST /functions/v1/civic-extract-worker` | Queue worker; normally called by cron.                            |
| `POST /functions/v1/promise-digest`       | Due-promise digest/notification path.                             |

## Key Files

| File                                                     | Purpose                                             |
| -------------------------------------------------------- | --------------------------------------------------- |
| `frontend/src/lib/components/news/CivicScoutView.svelte` | 3-step UI.                                          |
| `backend/app/routers/civic.py`                           | FastAPI discovery/test compatibility endpoints.     |
| `supabase/functions/civic/`                              | Shared civic helpers/API surface.                   |
| `supabase/functions/civic-test/`                         | Extraction preview.                                 |
| `supabase/functions/civic-execute/`                      | Scheduled run kickoff and document enqueueing.      |
| `supabase/functions/civic-extract-worker/`               | Queue claim, parse, extract, write units/promises.  |
| `docs/supabase/civic-pipeline.md`                        | Current queue, cron, RPC, and operations reference. |

## Related Docs

- `docs/supabase/civic-pipeline.md`
- `docs/supabase/scouts-runs.md`
- `supabase/migrations/00020_civic_queue_rpc.sql`
- `supabase/migrations/00021_civic_worker_cron.sql`
