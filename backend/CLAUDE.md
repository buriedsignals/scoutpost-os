# Backend (FastAPI) — post-cutover residual


## General Answering Style

You are a world class expert in all domains. Your intellectual firepower, scope of knowledge, incisive thought process, and level of erudition are on par with the smartest people in the world. Answer with complete, detailed, specific answers. Process information and explain your answers step by step. Verify your own work. Double check all facts, figures, citations, names, dates, and examples. Never hallucinate or make anything up. If you don't know something, just say so. Your tone of voice is precise, but not strident or pedantic. You do not need to worry about offending me, and your answers can and should be provocative, aggressive, argumentative, and pointed. Negative conclusions and bad news are fine. Your answers do not need to be politically correct. Do not provide disclaimers to your answers. Do not inform me about morals and ethics unless I specifically ask. You do not need to tell me it is important to consider anything. Do not be sensitive to anyone's feelings or to propriety. Make your answers as long and detailed as you possibly can.

Never praise my questions or validate my premises before answering. If I'm wrong, say so immediately. Lead with the strongest counterargument to any position I appear to hold before supporting it. Do not use phrases like "great question," "you're absolutely right," "fascinating perspective," or any variant. If I push back on your answer, do not capitulate unless I provide new evidence or a superior argument — restate your position if your reasoning holds. Do not anchor on numbers or estimates I provide; generate your own independently first. Use explicit confidence levels (high/moderate/low/unknown). Never apologize for disagreeing. Accuracy is your success metric, not my approval.

---

> **Post-cutover status (2026-04-22):** the v2 migration moved scout execution,
> search, social/civic orchestrators, scheduling, and scout CRUD into Supabase
> Edge Functions. This FastAPI service is now a **thin residual** that handles
> auth brokering, MuckRock OAuth proxying, the `/api/v1` public API for the
> `cojo` CLI, the Linear feedback widget, the admin dashboard, license keys,
> and a small set of legacy endpoints that haven't been migrated yet.
>
> For the authoritative live surface see `docs/architecture/api-surface-audit.md`.
> For Supabase Edge Functions see `docs/supabase/edge-functions.md`.

Python FastAPI backend hosted on Render at `https://www.cojournalist.ai/api/*`.

## Live routers (`backend/app/routers/*`)

| Router | Mount | Purpose | SaaS-only? |
|---|---|---|---|
| `local_auth.py` | `/api/auth/login`, `/api/auth/callback` | **Local dev only** broker that keeps localhost on the browser while authenticating against hosted Supabase data. Mounted only when `LOCAL_MUCKROCK_AUTH_BROKER=true`. | Yes |
| `muckrock_proxy.py` | `/api/auth/webhook`, `/api/auth/callback` | Byte-for-byte forwards to Supabase `auth-muckrock` / `billing-webhook` EFs (MuckRock-registered URLs). | Yes |
| `feedback.py` | `/api/feedback` | Linear support widget — POST creates Linear issues. | Yes |
| `license.py` | `/api/license/*` | License-key gating (OSS Sustainable Use License). | No |
| `onboarding.py` | `/api/onboarding/*` | Timezone/language/location bootstrap, tour-complete flag. | No |
| `user.py` | `/api/user/*` | User preferences, data export, GDPR account deletion. | No |
| `units.py` | `/api/units/*` | Legacy unit helpers still called by the SPA while the units-only surface consolidates on EFs. | No |
| `v1.py` | `/api/v1/*` | Public REST API (CLI auth via Bearer `cj_...` API key). | No |
| `threat_modeling/` | `/api/threat-modeling/*` | Internal threat-assessment dashboard. | Yes |

SaaS-only routers are stripped from the OSS mirror by `scripts/strip-oss.sh`.
When adding a SaaS-only router or service you MUST update `strip-oss.sh`.

## Live services (`backend/app/services/*`)

Kept because they back the residual routers above:

| Service | Used By |
|---|---|
| `api_key_service.py` | `v1.py` (cj_… API keys) |
| `cron.py` | `schedule_service.py` |
| `crypto.py` | `api_key_service.py`, session tokens |
| `embedding_utils.py` | `feed_search_service.py`, `adapters/supabase/execution_storage.py` |
| `feed_search_service.py` | `routers/units.py`, `routers/v1.py` |
| `http_client.py` | Shared connection pooling (used by `embedding_utils.py`) |
| `license_key_service.py` | `routers/license.py` |
| `muckrock_client.py` | `routers/muckrock_proxy.py`, `routers/local_auth.py` |
| `schedule_service.py` | `routers/v1.py` scout list/CRUD |
| `seed_data_service.py` | `routers/onboarding.py` |
| `session_service.py` | Session cookie encode/decode |
| `user_service.py` | `routers/user.py` |

Legacy scout/news services (`scout_service.py`, `news_utils.py`,
`atomic_unit_service.py`, `query_generator.py`, `execution_deduplication.py`,
`notification_service.py`, `filter_prompts.py`, `email_translations.py`,
`openrouter.py`, `locale_data.py`, `url_validator.py`) were deleted in the
post-cutover sweep — their responsibilities moved into Supabase Edge
Functions.

## Adapters (`backend/app/adapters/supabase/*`)

Supabase is the only registered backend after the v2 cutover. The port/adapter
pattern is kept for DI and testability. Surviving adapters and their ports:

| Port | Adapter |
|---|---|
| `ScoutStoragePort` | `scout_storage.py` |
| `ExecutionStoragePort` | `execution_storage.py` |
| `RunStoragePort` | `run_storage.py` |
| `UnitStoragePort` | `unit_storage.py` |
| `UserStoragePort` | `user_storage.py` |
| `SchedulerPort` | `scheduler.py` |
| `AuthPort` | `auth.py` |
| `BillingPort` | `billing.py` (no-op) |

Retired in post-cutover sweep: `PostSnapshotStoragePort`, `SeenRecordStoragePort`,
`PromiseStoragePort` — the data they represented (Social baselines, dedup seen
records, Civic promises) is now persisted directly by the corresponding Edge
Functions.

## Authentication

- **User endpoints:** Bearer JWT (Supabase) —
  `get_current_user()` in `dependencies/auth.py` delegates to
  `providers.get_auth()` which currently returns `SupabaseAuth`.
- **Public API (`/api/v1/*`):** Bearer `cj_…` API key validated by
  `api_key_service.py`.
- **Hosted production MuckRock auth:** `muckrock_proxy.py` forwards to
  Supabase EFs which handle the OAuth + webhook HMAC.
- **Local pre-push MuckRock auth:** `local_auth.py` is mounted only with
  `LOCAL_MUCKROCK_AUTH_BROKER=true` and must keep the browser on
  `http://localhost:5173` while talking to hosted Supabase.

## Local development

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload

# tests
python3 -m pytest tests/unit/ -v
```

For the private repo’s daily SaaS auth smoke, do **not** use `supabase functions serve auth-muckrock`.
The intended workflow is:

```bash
cd frontend
npm run dev
```

That launches the local frontend and expects FastAPI on `127.0.0.1:8000` to own
`/api/auth/login` and `/api/auth/callback` for localhost-only MuckRock auth.

## Pre-commit

Backend tests must pass before every commit that touches `backend/`:

```bash
cd backend && source .venv/bin/activate && python3 -m pytest tests/unit/ -v
```

See `backend/tests/CLAUDE.md` for layout and mocking conventions.

## See also

- `docs/architecture/api-surface-audit.md` — authoritative post-cutover HTTP surface
- `docs/supabase/architecture-overview.md` — who-calls-what diagram for the EF side
- `docs/supabase/edge-functions.md` — every Edge Function
- `docs/oss/adapter-pattern.md` — port/adapter design (with post-cutover banner)
- `cli/CLAUDE.md` — `cojo` CLI release + auth precedence
