# API surface — post-cutover (2026-04-22)

Snapshot of the full HTTP surface after the legacy FastAPI data routers
were retired in favour of Supabase Edge Functions. Use this as the
authoritative contract until the FastAPI service is fully decommissioned
or rewritten.

The OSS mirror inherits the Edge Function side intact and ships the
FastAPI auth/feedback/admin pieces stripped (see `scripts/ops/strip-oss.sh`).

---

## Live HTTP surface

### Supabase Edge Functions (`supabase/functions/*`)

All EFs are reachable at `https://<project>.supabase.co/functions/v1/<fn>`.
Auth: Bearer JWT (Supabase auth) **or** Bearer `cj_…` API key plus
`apikey: <SUPABASE_ANON_KEY>` header (api-keys + units + scouts).

| Function | Purpose | Status |
|---|---|---|
| `_shared/` | Internal helpers (auth, db, firecrawl, OpenRouter, notifications) | Live (not an endpoint) |
| `api-keys` | CRUD for `cj_…` API keys (per-user, max 5) | Live (PR #71) |
| `apify-callback` | Apify webhook target — completes social runs | Live |
| `apify-reconcile` | Periodic backfill for stuck Apify jobs | Live (cron) |
| `beat-search` | Beat Scout AI search — direct call surface | Live |
| `civic` | Civic Scout CRUD | Live |
| `civic-execute` | Civic scout run executor | Live (cron) |
| `civic-extract-worker` | Async PDF parsing worker | Live |
| `civic-test` | Discover meeting URLs from a council domain | Live |
| `entities` | Entity CRUD | Live |
| `execute-scout` | Generic scout run dispatcher | Live |
| `ingest` | Manual unit ingest from URL/text | Live |
| `main` | Health/heartbeat | Live |
| `manage-schedule` | Cron management for scouts | Live |
| `mcp-server` | Remote MCP JSON-RPC + OAuth discovery/PKCE + API-key auth | Live |
| `openapi-spec` | Serves the `/api/v1` OpenAPI JSON | Live |
| `projects` | Investigation project CRUD | Live |
| `promise-digest` | Civic promise weekly digest | Live (cron) |
| `reflections` | Agent reflection notes CRUD | Live |
| `scout-beat-execute` | Beat-mode scout executor | Live (cron) |
| `scout-health-monitor` | Periodic scout health rollup | Live (cron) |
| `scout-templates` | Scout templates catalog | Live |
| `scout-web-execute` | Page Scout executor (fresh scrape + local canonical hash) | Live (cron) |
| `scouts` | Scout CRUD + run/pause/resume + last-run | Live |
| `social-kickoff` | Social Scout — fire Apify run | Live (cron) |
| `social-test` | Social Scout — preview / baseline scan | Live |
| `units` | Units list/get/search (hybrid lex+vec) + verify/reject/mark-used | Live |
| `user` | Current user / preferences / timezone | Live |

### FastAPI routers (`backend/app/routers/*`)

Reachable at `https://scoutpost.ai/api/...`. Hosted on Render.
Frontend is served by the same service in dev; static SPA in production.

| Router | Mount | Purpose | Status |
|---|---|---|---|
| `local_auth.py` | `/api/auth/login`, `/api/auth/callback` | Local-only MuckRock broker for localhost SaaS smoke tests; mounted only with `LOCAL_MUCKROCK_AUTH_BROKER=true`. | Live (dev only) |
| `public_edge_proxy.py` | `/functions/v1/*`, `/mcp*` | Same-origin proxy to hosted Supabase Edge Functions and MCP. | Live |
| `onboarding.py` | `/api/onboarding/*` | Onboarding initialize/status/tour-complete | Live |
| `user.py` | `/api/user/*` | User preferences (mirrors EF; legacy callers) | Live |
| `units.py` | `/api/units/*` | Units helpers (legacy callers) | Live |
| `license.py` | `/api/license/*` | License key gating (OSS sustainable-use model) | Live |
| `v1.py` | `/api/v1/*` | Public REST API (CLI uses this OR the Supabase EF URL) | Live |
| `feedback.py` | `/api/feedback` | Linear support widget — POST creates issues | Live (SaaS-only — stripped from OSS) |
| `threat_modeling/` | `/api/threat-modeling/*` | Internal threat assessment doc; currently gated out while `deployment_target == "supabase"`. | Residual |

### Removed in this PR (cutover finish)

The following routers are gone — all functionality now lives in Supabase Edge Functions:

- `backend/app/routers/scouts.py` → `supabase/functions/scouts/`
- `backend/app/routers/pulse.py` → `supabase/functions/scout-beat-execute/` + `beat-search/`
- `backend/app/routers/social.py` → `supabase/functions/social-test/` + `social-kickoff/` + `apify-callback/`
- `backend/app/routers/civic.py` → `supabase/functions/civic/` + `civic-execute/` + `civic-extract-worker/` + `civic-test/`
- `backend/app/routers/scraper.py` → `supabase/functions/manage-schedule/` (cron) + `supabase/functions/scouts/` (run-now)
- `backend/app/routers/data_extractor.py` → retired; manual ingest now lives on `supabase/functions/ingest/`

The frontend already migrated off these routes in PR #71 (api-client routes
to Supabase EFs when `PUBLIC_DEPLOYMENT_TARGET=supabase`).

---

## Orphaned services (deferred cleanup)

The following Python service modules are no longer imported by any
mounted router after this PR. They're kept on disk as reference for OSS
forks that want a Python backend; mark them for deletion in a future
`/cleanup` pass:

| Service | Why orphaned |
|---|---|
| `services/pulse_orchestrator.py` | Only used by `routers/pulse.py` |
| `services/social_orchestrator.py` | Only used by `routers/social.py` |
| `services/civic_orchestrator.py` | Only used by `routers/civic.py` (also `routers/scraper.py`) |
| `services/post_snapshot_service.py` | Only used by `routers/social.py` + `routers/scraper.py` |
| `services/execute_pipeline.py` | Only used by `routers/pulse.py` |

The following stay because non-dead callers still import them
(verified via `rg "from app.services.<name>"`):

- `services/notification_service.py` — used by `services/scout_service.py` + `services/social_orchestrator.py`
- `services/user_service.py` — used by `dependencies/auth.py`, `utils/credits.py`, `routers/{auth,user,onboarding,export}.py`
- `services/execution_deduplication.py` — used by `services/scout_service.py` + `services/execute_pipeline.py`
- `services/scout_service.py` — preserved per `backend/CLAUDE.md` "Critical Architecture - DO NOT REMOVE"
- `services/scout_runner.py`, `services/schedule_service.py`, `services/cron.py`, `services/news_utils.py` — still used by `routers/v1.py` (external API)

---

## Render env-vars — current load-bearing

The cutover does **not** free up any Supabase-related Render env vars. The
adapter layer (`backend/app/adapters/supabase/*`) still reads them at
runtime for the auth broker, units endpoint, and v1 API.

Still required:

- `DATABASE_URL` — asyncpg pool in `adapters/supabase/connection.py`
- `SUPABASE_SERVICE_KEY` — admin ops in `adapters/supabase/auth.py` + `adapters/supabase/scheduler.py`
- `SUPABASE_JWT_SECRET` — residual FastAPI HS256 JWT verification in `adapters/supabase/auth.py`; ES256 tokens verify via Supabase JWKS
- `SUPABASE_ANON_KEY` — used by frontend bundle; not actively read by backend (could be removed but harmless)
- `MUCKROCK_CLIENT_ID`, `MUCKROCK_CLIENT_SECRET`, `SESSION_SECRET` — MuckRock auth broker and HMAC state signing
- `OPENROUTER_API_KEY` — external key for extraction and scanned-PDF fallback through OpenRouter to Google Vertex
- `EMBEDDING_SERVICE_URL` / `EMBEDDING_SERVICE_TOKEN` — internal authenticated EmbeddingGemma service
- `LLM_MODEL` — full `google/...` OpenRouter model ID compatible with the pinned Google Vertex route; defaults to `google/gemini-2.5-flash-lite`
- `FIRECRAWL_API_KEY` — web scraping
- `APIFY_API_TOKEN` — social scraping
- `RESEND_API_KEY` — notifications
- `INTERNAL_SERVICE_KEY` — Lambda → FastAPI auth (legacy; still used by adapters)
- `LINEAR_API_KEY` — feedback router

The local embedding model emits 768-dimensional vectors with tag
`embeddinggemma-300m-768-int8-onnx-task-prefix-v1`. Every OpenRouter request restricts the provider to
`google-vertex`, requires ZDR, denies provider data collection, and sends
`X-OpenRouter-Cache: false`. OpenRouter remains a processor in front of Google
Vertex; account-level logging/data-sharing settings are defense in depth.

Safe to delete (no current importer):

- (none identified this pass — orphaned-service deletion in a future PR may unlock more)

---

## Verification checklist

Run these to confirm the audit matches reality:

```bash
# Backend boots
cd backend && source .venv/bin/activate && python3 -c "from app.main import app; print(app.routes)" | head -10

# Backend tests
python3 -m pytest tests/unit/ -q

# Frontend lint + tests
cd ../frontend && nvm use && npm run check && npm test

# OSS mirror boots after stripping
cd .. && bash scripts/ops/strip-oss.sh && cd /tmp/oss-mirror/backend && source .venv/bin/activate && python3 -c "from app.main import app; print('OSS app boots OK')"

# EF list matches docs
ls supabase/functions/
```

---

## Follow-ups

1. **Orphaned-service cleanup** — sweep the services listed above and any
   schemas/utils they pull in. Best done with the `/cleanup` skill.
2. **MCP live smoke** — after each deploy, verify hosted `/mcp`, OAuth
   metadata, protected-resource metadata, `initialize`, and `tools/list`
   against the public URL agents are given.
3. **Documentation refresh** — `docs/architecture/fastapi-endpoints.md`
   and `cli/CLAUDE.md` need to mention the EF surface as primary.
   Tracked in PR D of this cutover-finish series.
4. **AWS billing teardown** — separate destructive-prod task per Tom.
