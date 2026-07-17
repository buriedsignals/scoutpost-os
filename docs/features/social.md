# Social Scout Service (type `social`)

> **Naming:** In the UI, this appears as "Social Scout". The backend type code is `social`.

Social Scouts monitor public social profiles for new posts and, when enabled, removed posts. The current runtime is Supabase Edge Functions plus Apify: `execute-scout` calls `social-kickoff`, Apify runs asynchronously, and `apify-callback` or `apify-reconcile` writes canonical units and post snapshots.

Do not model new social work around EventBridge, Lambda, DynamoDB `POSTS#` records, or `/api/social/execute`. Those are pre-cutover names.

## Supported Platforms

| Platform | Apify Actor ID | Media support |
| --- | --- | --- |
| Instagram | `pmQcv69sB1UwguQUY` | Text, image URLs, video URLs |
| X/Twitter | `61RPP7dywgiy0JPD0` | Text and media URLs |
| Facebook | `cleansyntax~facebook-profile-posts-scraper` | Text, image URLs, video URLs |
| TikTok | `novi~tiktok-user-api` | Text, cover image, video URL |
| LinkedIn | `harvestapi~linkedin-profile-posts` | Text, image URLs, video thumbnail |

LinkedIn supports **personal profiles (`linkedin.com/in/...`) only** — company,
school, and showcase page inputs are rejected at validation. LinkedIn's
authwall answers datacenter probes with HTTP 999, so profile probing degrades
to `probe_uncertain` and the run proceeds with the input handle; a truly dead
handle surfaces as a 0-post baseline rather than a hard failure.

## Modes

| Mode | Behavior |
| --- | --- |
| `summarize` | New posts produce an AI summary and notification. |
| `criteria` | New posts are embedded and compared against the scout criteria; only matches create relevant units/alerts. |

New UI, CLI, MCP, and documented API flows default to `criteria` and require
non-empty criteria text. `summarize` remains an explicit opt-out for collecting
all substantive new posts. For backward compatibility, raw REST requests that
omit both `monitor_mode` and `criteria` retain the legacy summarize behavior;
new clients should always send their chosen mode explicitly.

Optional `track_removals` reports posts that disappear between snapshots.

## Current Runtime

```
pg_cron/pg_net
  -> execute-scout
  -> social-kickoff
       - load social scout config
       - decrement platform-specific credits
       - insert apify_run_queue row
       - start Apify actor with callback URL
       - return 202 / queue_id

Apify actor terminal event
  -> apify-callback
       - find apify_run_queue by apify_run_id
       - fetch dataset
       - normalize posts
       - diff against post_snapshots
       - process new/removed posts
       - upsert canonical information_units / unit_occurrences
       - update post_snapshots and scout_runs

apify-reconcile
  -> cron fallback for missed callbacks or cold-start gaps
```

`apify_mark_timeouts()` marks stuck pending/running queue rows after two hours. `cleanup_apify_queue()` removes terminal rows older than seven days.

## Baselines And Diffing

`post_snapshots` stores one baseline row per social scout. Scheduled creation establishes a baseline server-side for UI, API, CLI, and MCP callers. The UI can pass preview posts as an optimization, but non-UI agents only need `platform` and `profile_handle`; the create endpoint performs the baseline scrape before scheduling.

Each execution compares current platform post IDs against the stored snapshot:

- New IDs become candidate posts.
- Removed IDs are reported only when `track_removals` is true.
- Successful runs replace the snapshot with the latest post set.
- Run Now refuses to execute a social scout without a saved baseline instead of treating all existing posts as new.

## Criteria Matching

Criteria mode runs only on new posts after ID diffing.

1. Embed the criteria text as a retrieval query.
2. Embed each new post:
   - All platforms use the post's text through the local EmbeddingGemma service.
   - Image embeddings are intentionally unsupported; no runtime caller required the staged multimodal path.
3. Compare embeddings by cosine similarity and keep matches above the configured threshold.

The baseline does not store embeddings. Embeddings are execution-time data for relevance checks, not snapshot state.

## Canonical Units And Dedup

Social scouts write through the same canonical unit service as page, beat, civic, and manual ingest. The semantic boundary is stricter for social:

- Exact source matches may merge across scout types.
- Semantic matching does not cross between social and non-social canonical rows.

This prevents a social post summary from collapsing into an unrelated page/beat/civic unit solely because the text is similar.

## Data Model

| Table | Purpose |
| --- | --- |
| `apify_run_queue` | One async Apify actor run per social scout execution. |
| `post_snapshots` | Current baseline posts per scout. |
| `scout_runs` | Execution status, timings, counts, and errors. |
| `information_units` | Canonical units for new/removal findings. |
| `unit_occurrences` | Source/provenance rows for canonical social units. |

See `docs/supabase/social-apify.md` for table columns, cron jobs, and operational SQL.

## Credit Cost

| Platform | Scheduled execution | Test |
| --- | --- | --- |
| Instagram | 2 | 0 |
| X/Twitter | 2 | 0 |
| Facebook | 15 | 0 |
| TikTok | 2 | 0 |
| LinkedIn | 7 | 0 |

Credits are deducted at kickoff. Apify platform billing is separate from Scoutpost credits.

## Function Surface

| Surface | Purpose |
| --- | --- |
| `POST /functions/v1/social-test` | Validate/profile-preview path used before scheduling. |
| `POST /functions/v1/social-kickoff` | Scheduled run kickoff and Apify actor start. |
| `POST /functions/v1/apify-callback` | Apify webhook receiver for terminal actor runs. |
| `POST /functions/v1/apify-reconcile` | Cron fallback for missed callbacks. |
| `POST /functions/v1/execute-scout` | Generic scheduled dispatcher that routes social scouts to `social-kickoff`. |

## Key Files

| File | Purpose |
| --- | --- |
| `supabase/functions/social-test/` | Profile validation and preview. |
| `supabase/functions/social-kickoff/` | Queue row creation and actor start. |
| `supabase/functions/apify-callback/` | Webhook handling, dataset fetch, diff, unit writes. |
| `supabase/functions/apify-reconcile/` | Missed-webhook reconciliation. |
| `supabase/functions/_shared/unit_dedup.ts` | Canonical unit dedup boundary. |
| `docs/supabase/social-apify.md` | Queue, cron, actor, and operations reference. |

## Related Docs

- `docs/supabase/social-apify.md`
- `docs/supabase/scouts-runs.md`
- `supabase/migrations/00022_apify_failsafe.sql`
