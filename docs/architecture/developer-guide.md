# Developer Guide

How to set up a local environment, run tests, and extend coJournalist without breaking
either the AWS SaaS or the Supabase OSS deployment target.

---

## Local Development Setup

### Prerequisites

- Python 3.11+
- Node 22 LTS (use `nvm use` in `frontend/` — see `.nvmrc`)
- A running backend target: either a Supabase project or AWS credentials

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create a `.env` file (or export vars) with the minimum required for your target:

**Supabase (OSS):**
```bash
DEPLOYMENT_TARGET=supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=xxx
SUPABASE_ANON_KEY=xxx
SUPABASE_JWT_SECRET=xxx
DATABASE_URL=postgresql://postgres:password@db.xxx.supabase.co:5432/postgres
OPENROUTER_API_KEY=xxx
LLM_MODEL=google/gemini-2.5-flash-lite
FIRECRAWL_API_KEY=xxx
RESEND_API_KEY=xxx
APIFY_API_TOKEN=xxx
INTERNAL_SERVICE_KEY=any-secret-string
```

**AWS (SaaS):**
```bash
DEPLOYMENT_TARGET=aws
AWS_REGION=eu-west-1
MUCKROCK_CLIENT_ID=xxx
MUCKROCK_CLIENT_SECRET=xxx
SESSION_SECRET=xxx
OPENROUTER_API_KEY=xxx
FIRECRAWL_API_KEY=xxx
RESEND_API_KEY=xxx
APIFY_API_TOKEN=xxx
INTERNAL_SERVICE_KEY=xxx
```

Start the API server:

```bash
cd backend
uvicorn app.main:app --reload --port 8000
```

### Full-stack launchers

```bash
./start.sh saas      # Docker backend + Docker frontend on http://localhost:5173
./start.sh oss-demo  # local Supabase demo frontend on http://localhost:4173
```

`./start.sh saas` is the Docker full-stack path. The canonical private-repo
daily workflow remains `cd frontend && npm run dev` so local MuckRock auth keeps
the documented localhost broker contract.

### Frontend

```bash
cd frontend
nvm use          # Ensure Node 22 — IMPORTANT
npm install
npm run dev                     # private repo default: local FastAPI MuckRock broker on http://localhost:5173
npm run dev:hosted-broker       # diagnostic: same frontend, but use the deployed broker
npm run dev:supabase-local-demo # local Supabase Auth + local-only demo workspace
npm run dev:raw                 # manual env override / OSS-style raw Vite boot
```

The private repo now has two explicit local auth modes:

- `npm run dev`: local frontend + local FastAPI auth broker, but authenticated against the hosted Supabase project so localhost shows your real account data before deploy.
- `npm run dev:hosted-broker`: diagnostic mode that keeps the frontend local but uses the already-deployed broker path.
- `npm run dev:supabase-local-demo`: disposable local Supabase email/password login for checking the onboarding/demo UI without touching hosted auth.
- Local demo mode keeps the example workspace local-only. Demo unit verify/delete interactions are simulated in-memory so the signup/demo flow still behaves like production onboarding, while the same workspace controls remain visible for UI smoke testing.
- Local MuckRock dev is pinned to `http://localhost:5173/auth/callback`, and Vite proxies `/api/auth/*` to the local FastAPI process on `127.0.0.1:8000` so the browser never has to round-trip through Render just to finish login.

The raw/manual path still exists for OSS-style development. Set the following in
your frontend `.env.local` only when you intentionally want manual control:

```bash
PUBLIC_DEPLOYMENT_TARGET=supabase   # or 'aws' for SaaS target
PUBLIC_SUPABASE_URL=https://xxx.supabase.co
PUBLIC_SUPABASE_ANON_KEY=xxx
PUBLIC_MUCKROCK_ENABLED=false
PUBLIC_MUCKROCK_BROKER_URL=http://localhost:5173/api/auth/login
PUBLIC_MUCKROCK_POST_LOGIN_REDIRECT=http://localhost:5173/auth/callback
PUBLIC_LOCAL_DEMO_MODE=false
PUBLIC_MAPTILER_API_KEY=xxx         # required (geocoding/location scouts)
```

### Pre-Commit Checks (Frontend)

Run these before every commit that touches frontend code:

```bash
cd frontend
npm run paraglide:compile   # Recompile i18n message files
npm run check               # svelte-check (type errors, missing i18n keys)
npm test                    # Vitest unit tests
```

If `npm run check` fails with "Property 'xxx' does not exist on type 'typeof messages'",
a `m.some_key()` call exists without a corresponding key in `messages/en.json`. Add the
key to `en.json` and all 12 language files (`da`, `de`, `es`, `fi`, `fr`, `it`, `nl`,
`no`, `pl`, `pt`, `sv`), then recompile.

---

## Running Tests

### Backend Unit Tests

```bash
cd backend
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/python -m pytest tests/unit/ -v
```

Tests use `unittest.mock.AsyncMock` to stub all port adapters. No live database or AWS
connection is required. See `backend/tests/CLAUDE.md` for test structure.

### Frontend Tests

```bash
cd frontend
nvm use
npm ci
npm test
```

### Coverage Baseline

Coverage reporting is informational for now; do not add global thresholds until
the baseline is measured and stable.

```bash
cd frontend && npm run test:coverage
cd backend && .venv/bin/python -m pytest tests/unit --cov=app --cov-report=term-missing
cd supabase/functions && deno task test:coverage
```

---

## The Golden Rule: Business Logic Stays in `services/`

Services never import `boto3`, `asyncpg`, or any adapter directly. They depend on port
interfaces via `providers.py`. This is the rule that keeps both targets working.

```
WRONG:  from app.adapters.supabase.scout_storage import SupabaseScoutStorage
RIGHT:  from app.dependencies.providers import get_scout_storage
```

---

## Adding a New Feature

### Case 1: No New Storage Required

If the feature only needs to call existing port methods, implement it entirely in
`services/` and `routers/`:

1. Write the service class in `backend/app/services/`
2. Add the router in `backend/app/routers/`
3. Register the router in `backend/app/main.py`
4. Write unit tests in `backend/tests/unit/`

Both deployment targets get the feature automatically.

### Case 2: New Storage Operation Required

Follow the four-step process in `docs/architecture/adapter-pattern.md`:

```
1. Add abstract method to the port in ports/storage.py
2. Implement in adapters/aws/<file>.py
3. Implement in adapters/supabase/<file>.py
4. Run tests: cd backend && .venv/bin/python -m pytest tests/unit/ -v
```

For the Supabase adapter, you also need a migration if you are adding a new column or
table. Create a new numbered file in `supabase/migrations/`:

```bash
supabase/migrations/00007_my_new_column.sql
```

Apply it to your Supabase project:

```bash
supabase db push     # against cloud project
# or
supabase db reset    # for local development with supabase CLI
```

### Case 3: New Scout Type

Adding a new scout type touches many files. The checklist:

- Add `type` to the `CHECK` constraint in `scouts` table migration
- Add router in `backend/app/routers/`
- Add orchestrator/service in `backend/app/services/`
- Add Pydantic schemas in `backend/app/schemas/`
- Add the execute endpoint mapping in `supabase/functions/execute-scout/index.ts`
- Add frontend components in `frontend/src/lib/components/`

---

## Scout Topics Are Tags

Scout topics are semantically independent tags. The UI stores them as one
comma-separated string when creating or updating a scout, but display, filtering,
counts, and suggestions must split that string into individual tags.

Use `frontend/src/lib/utils/topics.ts` for this logic:

- `parseTopicTags()` for display and form chips
- `collectTopicCounts()` for filter dropdowns and suggestions
- `topicMatches()` for workspace filtering

Do not compare `scout.topic` as one opaque string in UI filtering code. For
example, `housing, real estate, Pontresina` must filter under `housing`,
`real estate`, and `Pontresina` independently.

---

## Frontend Auth: Conditional Loader Pattern

The frontend ships with two auth implementations. `PUBLIC_DEPLOYMENT_TARGET` (a build-time
env var) controls which one loads:

```typescript
// frontend/src/lib/stores/auth.ts
const DEPLOYMENT = import.meta.env.PUBLIC_DEPLOYMENT_TARGET;

const authModule =
    DEPLOYMENT === 'supabase'
        ? await import('./auth-supabase')    // @supabase/supabase-js
        : await import('./auth-muckrock');   // MuckRock OAuth 2.0

export const authStore = authModule.authStore;
export const currentUser = authModule.currentUser;
export const auth = authModule.auth;
```

All components import from `$lib/stores/auth` — they never import the specific
implementation files directly. This means the same component code works with both auth
systems.

`auth-supabase.ts` uses `@supabase/supabase-js` and sends a `Bearer <jwt>` token in the
`Authorization` header. `auth-muckrock.ts` relies on a session cookie set by the FastAPI
backend's OAuth callback.

---

## Mirror CI/CD: What Gets Stripped

On every push to `main` (after CI passes), a GitHub Action mirrors the codebase to the
public OSS repo with AWS-specific code removed:

```bash
rm -rf aws/
rm -rf backend/app/adapters/aws/
rm -f backend/app/routers/auth.py        # MuckRock OAuth router
rm -f backend/app/services/muckrock_client.py
rm -f backend/app/utils/credits.py
rm -f .github/workflows/mirror-*.yml
rm -f .github/workflows/claude*.yml
```

The mirror action then validates the stripped build:

```bash
DEPLOYMENT_TARGET=supabase python -c "from app.main import app"
```

**To verify the OSS build works locally:**

```bash
# Temporarily set DEPLOYMENT_TARGET and confirm startup
DEPLOYMENT_TARGET=supabase uvicorn app.main:app --port 8001
```

If the application imports anything from `adapters/aws/` at startup, this will fail with
an `ImportError`. Check that no service or router has a direct import of an AWS adapter.

---

## Environment Variables Reference

### Backend — SaaS (AWS)

| Variable | Required | Description |
|----------|----------|-------------|
| `DEPLOYMENT_TARGET` | Yes | `aws` |
| `MUCKROCK_CLIENT_ID` | Yes | OAuth client ID |
| `MUCKROCK_CLIENT_SECRET` | Yes | OAuth client secret |
| `SESSION_SECRET` | Yes | JWT session signing key |
| `OAUTH_REDIRECT_BASE` | Yes | Browser-facing URL (e.g., `http://localhost:5173` for local) |
| `OPENROUTER_API_KEY` | Yes | External key for Google Vertex extraction, scanned-PDF fallback, and 768d Gemini embeddings through OpenRouter |
| `LLM_MODEL` | No | Full `google/...` OpenRouter model ID compatible with the pinned Google Vertex route; default: `google/gemini-2.5-flash-lite` |
| `FIRECRAWL_API_KEY` | Yes | Web scraping |
| `APIFY_API_TOKEN` | Yes | Social media scraping |
| `RESEND_API_KEY` | Yes | Email notifications |
| `INTERNAL_SERVICE_KEY` | Yes | Lambda → FastAPI auth |
| `AWS_API_BASE_URL` | Yes | AWS API Gateway URL |

### Backend — OSS (Supabase)

| Variable | Required | Description |
|----------|----------|-------------|
| `DEPLOYMENT_TARGET` | Yes | `supabase` |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Service role key (bypasses RLS) |
| `SUPABASE_ANON_KEY` | Yes | Anon key (returned to frontend) |
| `SUPABASE_JWT_SECRET` | Yes | JWT verification secret |
| `DATABASE_URL` | Yes | Direct asyncpg connection string |
| `OPENROUTER_API_KEY` | Yes | External key for Google Vertex extraction, scanned-PDF fallback, and 768d Gemini embeddings through OpenRouter |
| `FIRECRAWL_API_KEY` | Yes | Web scraping |
| `APIFY_API_TOKEN` | Yes | Social media scraping |
| `RESEND_API_KEY` | Yes | Email notifications |
| `INTERNAL_SERVICE_KEY` | Yes | Edge Function → FastAPI auth (auto-generated by Render) |
| `LLM_MODEL` | No | Full `google/...` OpenRouter model ID compatible with the pinned Google Vertex route; default: `google/gemini-2.5-flash-lite` |
| `RESEND_FROM_EMAIL` | No | Sender address (e.g., `scouts@newsroom.org`) |

OpenRouter extraction traffic flows Scoutpost → OpenRouter → Google Vertex. Requests set
`only: ["google-vertex"]`, `zdr: true`, and `data_collection: "deny"`, and
disable OpenRouter response caching with `X-OpenRouter-Cache: false`. Keep
OpenRouter account logging/data-sharing controls disabled as defense in depth.
This one-key setup simplifies billing and configuration; it does not remove a
processor. Embeddings use `google/gemini-embedding-001` through the same
OpenRouter-to-Google-Vertex route and request 768 dimensions.

### Frontend (Build-time)

| Variable | Target | Description |
|----------|--------|-------------|
| `PUBLIC_DEPLOYMENT_TARGET` | Both | `aws` or `supabase` — controls auth loader |
| `PUBLIC_SUPABASE_URL` | Supabase | Supabase project URL |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase | Anon key for client-side auth |
| `PUBLIC_MAPTILER_API_KEY` | Both | Geocoding for location autocomplete |

---

## Troubleshooting

### `asyncpg` connection failures

**Symptom:** `Connection refused` or `SSL connection failed` on startup.

Check:
- `DATABASE_URL` uses the correct port. Supabase cloud uses `6543` for the connection
  pooler (Supavisor) and `5432` for direct connections. Use `6543` in production.
- `statement_cache_size=0` is set in `connection.py`. Without it, Supavisor rejects
  prepared statements because connection IDs rotate between requests.

### `pg_cron` jobs not firing

**Symptom:** Scouts are created but never execute on schedule.

Check:
- `pg_cron` extension is enabled. Run `SELECT cron.job_run_details LIMIT 5;` to see
  recent job history.
- `pg_net` extension is enabled. Required for `pg_cron` to make HTTP calls.
- The Edge Function URL in the cron command matches the deployed `execute-scout` function
  URL. Inspect with:
  ```sql
  SELECT command FROM cron.job WHERE jobname LIKE 'scout-%';
  ```
- The `Authorization` header in the cron command contains the service role key (not the
  anon key).

### pgvector HNSW index build slow

**Symptom:** `CREATE INDEX` on `execution_records(embedding)` takes a long time.

This is expected for large tables. For initial setup with an empty database, the indexes
build instantly. If migrating existing data, build indexes after loading data, not before.

### `Invalid DEPLOYMENT_TARGET` error on startup

**Symptom:** `ValueError: Invalid DEPLOYMENT_TARGET: 'None'`

`DEPLOYMENT_TARGET` is not set in the environment. The application requires an explicit
value — it does not default. Set `DEPLOYMENT_TARGET=supabase` or `DEPLOYMENT_TARGET=aws`.

### Frontend auth loop (Supabase)

**Symptom:** Redirect loop on login or blank page after OAuth callback.

Check:
- `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` are set correctly at build time.
  SvelteKit bakes these in at build — they cannot be changed at runtime.
- The Supabase project's Auth settings include the frontend URL in "Site URL" and
  "Redirect URLs".

### Node version mismatch in frontend

**Symptom:** `npm ci` fails on Render with lock file errors.

The `frontend/.nvmrc` pins Node 22 LTS. Using a different major version generates an
incompatible `package-lock.json`. Always run `nvm use` before `npm install` in the
`frontend/` directory.
