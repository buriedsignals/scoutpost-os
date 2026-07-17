# Edge Functions Reference

Scoutpost's current SaaS and OSS scout runtime is Supabase Edge Functions. The older AWS Lambda mapping is migration history, not the implementation target for new work.

Source files: `supabase/functions/`

## Runtime Shape

| Function | Purpose |
| --- | --- |
| `main` | Edge runtime health entry point. |
| `scouts` | Scout CRUD, baseline setup, schedule orchestration. |
| `execute-scout` | Scheduled dispatcher for page, beat, social, and civic scout runs. |
| `manage-schedule` | pg_cron / pg_net schedule lifecycle. |
| `scout-web-execute` | Page Scout execution and change detection. |
| `scout-beat-execute` | Beat / Location Scout execution. |
| `social-test` | Social profile validation and baseline preview. |
| `transport-test` | Authenticated, Pro/Team Fleet live-data check that returns stable baseline IDs without creating a scout or spending credits. |
| `social-kickoff` | Social scheduled run kickoff and Apify actor start. |
| `apify-callback` | Apify webhook receiver for completed actor runs. |
| `apify-reconcile` | Cron fallback for missed Apify callbacks. |
| `civic-test` | Civic extraction preview. |
| `civic-execute` | Civic run kickoff and document queueing. |
| `civic-extract-worker` | Civic queue worker that extracts promises and writes units. |
| `units`, `projects`, `entities`, `reflections`, `ingest`, `runs`, `user`, `api-keys` | Product API resources used by UI, CLI, and MCP. |
| `mcp-server` | Remote MCP JSON-RPC endpoint for self-hosted deployments. |
| `scout-health-monitor` | Scheduled scout failure notifications. |

## Docker Self-Hosted

For Docker deployments, Edge Functions run inside Supabase Edge Runtime. Kong routes `/functions/v1/*` to the runtime container. The installer writes the required env/secrets and deploys functions during setup.

```yaml
edge-functions:
  image: supabase/edge-runtime:v1.67.4
  command: start --main-service /home/deno/functions/main
  volumes:
    - ../../supabase/functions:/home/deno/functions
```

See `docs/oss/newsroom-docker-install.md` and `deploy/installer/README.md` for the supported install path.

## Scheduling

Scout schedules use Postgres-native cron:

1. `manage-schedule` creates/updates/deletes cron jobs.
2. Cron jobs use `pg_net.http_post` to call `execute-scout`.
3. `execute-scout` loads the scout and routes to the type-specific function.
4. Type-specific functions write `scout_runs`, units, queue rows, snapshots, and notifications.

This replaces EventBridge/Lambda scheduling. Do not add new EventBridge or Lambda requirements to OSS docs.

## Auth

- User-facing requests use Supabase Auth JWTs or Scoutpost API keys (`cj_...`) depending on surface.
- Internal scheduled/worker requests use the shared internal service-key boundary and Supabase service-role access where needed.
- MCP requests use `mcp-server` with the self-hosted auth/API-key boundary.
- Hosted Fleet live tests reuse the same Pro/Team entitlement gate as Fleet creation; self-hosted deployments with credits disabled skip that commercial gate.

## AI transport and PDF boundary

Structured extraction uses the single external `OPENROUTER_API_KEY` and defaults
to `google/gemini-2.5-flash-lite`; any `LLM_MODEL` override must remain in the
`google/...` namespace. Every OpenRouter request pins `google-vertex`, requires
ZDR, denies provider data collection, and sends `X-OpenRouter-Cache: false`.
Structured output additionally requires provider parameter support.

Text embedding calls use `EMBEDDING_SERVICE_URL` and the generated
`EMBEDDING_SERVICE_TOKEN`. The internal service runs EmbeddingGemma locally and
returns the pinned 768-dimensional model space.

PDF parsing is local-first and is not an Edge LLM workflow: the scrape service
runs Poppler `pdftotext -layout` first. Only a low-yield/scanned PDF may use
Google native-PDF processing through the same constrained OpenRouter route; it
forces the native parser and returns `needs_ocr` rather than selecting Mistral,
Cloudflare, or another parser when that route is unavailable.

## Current References

- `docs/supabase/edge-functions.md`
- `docs/supabase/scouts-runs.md`
- `docs/supabase/social-apify.md`
- `docs/supabase/civic-pipeline.md`
- `docs/supabase/benchmarks.md`
