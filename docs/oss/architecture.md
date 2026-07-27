# Scoutpost OSS Architecture

Scoutpost OSS is the self-hosted, open-source newsroom deployment of Scoutpost. The current architecture is Supabase-first: Supabase Auth, Postgres, Edge Functions, `pg_cron`, and `pg_net` provide the application runtime. FastAPI is optional for self-hosted installs and is mainly retained in the private SaaS deployment for auth broker, admin, feedback, and compatibility routes.

This document replaces the older pre-cutover design that described a long-term AWS SaaS backend plus a Supabase OSS adapter. Do not use DynamoDB, EventBridge, or Lambda as the target architecture for new OSS work.

## Goals

1. Public, auditable newsroom deployment.
2. Same core scout types as hosted Scoutpost: Page, Beat/Location, Social, Civic.
3. Agent-compatible surfaces: UI, `scout` CLI, REST/Edge Functions, and MCP.
4. Docker installer path that keeps newsroom credentials local.
5. Optional self-hosting/support licensing that never gates application features.

## Repository Topology

| Repo | Visibility | Purpose |
| --- | --- | --- |
| `buriedsignals/scoutpost` | Private | Main development, SaaS-specific code, CI, release automation. |
| `buriedsignals/scoutpost-os` | Public | OSS mirror after SaaS-only code and private workflows are stripped. |

The mirror pipeline is implemented by `scripts/ops/strip-oss.sh` and `.github/workflows/mirror-oss.yml`. Any new SaaS-only route, component, workflow, or secret-bearing file must be excluded there.

## Runtime Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Frontend | SvelteKit static SPA | Built with public Supabase/MapTiler config. |
| Auth | Supabase Auth | OSS path; hosted SaaS also bridges MuckRock into Supabase. |
| API/runtime | Supabase Edge Functions | Product REST, scout execution, CLI, MCP, worker functions. |
| Database | Supabase Postgres | Scouts, runs, units, projects, entities, reflections, queues, snapshots. |
| Search | pgvector/HNSW plus provider APIs | Canonical unit search and dedup. |
| Scheduling | `pg_cron` + `pg_net` | Calls `execute-scout` on schedule. |
| Page/article rendering | Crawl4AI + Firecrawl Cloud | Crawl4AI is primary; Firecrawl Cloud handles Civic/legacy Page change tracking and classified anti-bot fallback. |
| Beat search | Firecrawl Cloud | Sole discovery provider through `/v2/search`. |
| Social scraping | Apify | Async actor queue, callback, reconcile. |
| Email | Resend | Notifications and digests. |
| Agent surfaces | `cli/`, `mcp/`, `mcp-server` | Product operations for agents/editors. |

## Core Data Model

| Table / area | Purpose |
| --- | --- |
| `scouts` | Scout definitions, type-specific config, baseline metadata. |
| `scout_runs` | Per-run execution status, timestamps, counts, and errors. |
| `information_units` | Canonical source-linked facts. |
| `unit_occurrences` | Provenance and duplicate occurrences for canonical units. |
| `projects` | Investigation workspaces. |
| `entities` | Extracted/searchable entities. |
| `reflections` | Agent/editor synthesis notes linked to units/entities/scouts. |
| `post_snapshots` | Social Scout baselines. |
| `apify_run_queue` | Async social actor runs. |
| `civic_extraction_queue` | Async civic document extraction queue. |
| `promises` | Civic promise tracker linked to canonical units. |
| `raw_captures` | Temporary source captures with expiry. |

See `docs/supabase/supabase-schema.md`, `docs/supabase/scouts-runs.md`, `docs/supabase/social-apify.md`, and `docs/supabase/civic-pipeline.md`.

## Scout Execution

```
User / CLI / MCP creates scout
  -> `scouts` Edge Function
  -> `scouts` table row
  -> baseline setup where applicable
  -> `manage-schedule` creates pg_cron job

pg_cron fires
  -> pg_net.http_post(`/functions/v1/execute-scout`)
  -> type-specific function
  -> scout_runs + units/queues/snapshots/promises
  -> notifications and credit accounting
```

Type routing:

| Scout type | Function path |
| --- | --- |
| `web` | `execute-scout` -> `scout-web-execute` |
| `beat` | `execute-scout` -> `scout-beat-execute` |
| `social` | `execute-scout` -> `social-kickoff` -> `apify-callback` / `apify-reconcile` |
| `civic` | `execute-scout` -> `civic-execute` -> `civic-extract-worker` |

## Self-Hosted Install

The supported newsroom path is the Docker installer:

- `docs/oss/newsroom-docker-install.md`
- `deploy/installer/README.md`
- `deploy/installer/scoutpost-setup.example.json`

The installer links or creates a Supabase project, deploys migrations/functions, sets Edge Function secrets, writes local env files, builds the frontend, and installs update automation. Generated manifests and env files are gitignored and must not be committed.

## Agent Surfaces

| Surface | Source | Notes |
| --- | --- | --- |
| CLI | `cli/` | Deno `scout` client for scouts, units, projects, auth/config. |
| Remote MCP | `supabase/functions/mcp-server/` | JSON-RPC over HTTP with OAuth/API-key auth. |
| Stdio MCP bridge | `mcp/` | Thin local bridge that forwards JSON-RPC to the remote MCP endpoint. |
| Product skill | `frontend/static/skills/scoutpost.md` | Public product-use instructions for agents. |

Any feature exposed in the UI should be considered for CLI/MCP parity when it is useful to agents or editors.

## Licensing Boundary

The Sustainable Use License governs the public repo. License keys, where used, gate self-hosting/support convenience and not application capabilities. See `docs/oss/license-key.md`.

## Historical Migration Notes

Older docs and issues may mention:

- DynamoDB records: `SCRAPER#`, `TIME#`, `POSTS#`, `PROMISE#`
- EventBridge schedules
- Python Lambda functions
- AWS adapter ports
- `cojournalist` repository/product names

Treat those as migration history unless the file explicitly says it is documenting remaining legacy code. New implementation and docs should use Scoutpost, Supabase Edge Functions, and Postgres table names.
