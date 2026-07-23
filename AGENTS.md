# Scoutpost

## Deployment Workflow - MANDATORY

**NEVER push directly to `main`.** All changes go through a branch + PR. This is not optional.

1. **Check for worktrees first:**
   ```bash
   jj workspace list
   ```
   If a workspace exists for the current task, work there.

2. **Create a Jujutsu change** from current remote `main`:
   ```bash
   jj git fetch
   jj new main@origin -m "type: concise description"
   jj bookmark create my-feature -r @
   ```
   Use `jj` for working-copy and history mutations. Git is read-only
   compatibility tooling in this workspace.

3. **Push the bookmark and open a PR to `main`:**
   ```bash
   jj git push --bookmark my-feature
   gh pr create --title "..." --body "..."
   ```

4. **Wait for CI to pass** — 4 required checks must be green:
   - `build-frontend` — SvelteKit build
   - `test-frontend` — Vitest suite
   - `test-backend` — pytest unit tests
   - `lint` — svelte-check

5. **Merge the PR** — Render auto-deploys backend from `main`.

**Why:** Pushing to `main` triggers a Render deploy immediately with no safety net. The PR flow ensures CI passes and review happens before anything reaches production.

---

## Node Version - IMPORTANT

**This project requires Node 22 LTS.** The Dockerfile and `frontend/.nvmrc` are pinned to Node 22. Using a different major version (especially Node 25+ with npm 11) will generate an incompatible `package-lock.json` that breaks the Render build (`npm ci` fails). Always run `nvm use` in `frontend/` before `npm install`.

---

## Benchmark Env Model - IMPORTANT

Scout health benchmarks are triggered locally but run against deployed Supabase
Edge Functions. Use the linked-project launcher so the local process receives
the linked Supabase project's auth keys while provider keys stay in
Supabase function secrets:

```bash
scripts/benchmarks/with-linked-supabase-env.sh \
  deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-beat.ts
```

The launcher discovers the linked Supabase project via `supabase projects list`
and exports `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SCOUT_BENCHMARK_TARGET=scout-health`,
`SCOUT_BENCHMARK_PROJECT=1`, `SCOUT_LIVE_BENCHMARK=1`, and
`SCOUT_ALLOW_PROD_FIRECRAWL=1` for the child command. `benchmark-beat.ts`
asserts Beat execution requested Exa via
`scout_runs.metadata.requested_retrieval` / `retrieval`. Use
`supabase status -o env` only for local Edge Runtime diagnostics; local
functions need their own env file if you intentionally serve them with
`scripts/ops/serve-functions-local.sh`.

---

## Occasional User Update Emails

Follow `docs/operations/user-update-email.md` and use
`scripts/ops/send-user-update-email.ts`. The hosted function fetches recipients
directly from MuckRock, keeps them in memory only, and sends through Resend.
Never add a Scoutpost recipient table, delivery ledger, email hash, or other
campaign-recipient persistence. MuckRock and Resend credentials stay in
Supabase Function Secrets.

The required flow is preview, test-send to `tom@buriedsignals.com`, then
campaign send with the campaign-specific confirmation value. Messages use
`Tom at Scoutpost <updates@scoutpost.ai>` and
`Reply-To: tom@buriedsignals.com`.

---

## Frontend ENV VAR TRAP — read this before changing any `PUBLIC_*` or `VITE_*` config

The Vite/SvelteKit/Render env-var pipeline bit us **5+ times** during the v2 cutover (2026-04-21). The pattern keeps recurring because three layers each have different rules and they don't compose intuitively. **Stop and read this section before touching `Dockerfile`, `frontend/.env.production`, or Render env vars.**

### The three layers (in build-time order)

1. **`frontend/.env.production`** (committed): Vite reads this AT BUILD TIME for `import.meta.env.PUBLIC_*` and `import.meta.env.VITE_*` substitution. Source of truth for client-side public values.
2. **Dockerfile `ENV` directives**: process.env during `RUN npm run build`. **Overrides .env.production** because Vite's load order puts process.env first. Hardcoded `ENV X=value` is opaque to Render — Render env vars can't change it.
3. **Render service envVars**: become process.env at runtime. **Only reach the docker BUILD context if (a) declared as `ARG` in Dockerfile AND (b) Render decides to forward — behavior varies by how the var was created (blueprint sync vs dashboard add vs API PUT).** Do not rely on this for build-time vars.

### Rules going forward

- **`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `PUBLIC_DEPLOYMENT_TARGET`, `PUBLIC_MUCKROCK_ENABLED`, `VITE_API_URL`**: hardcoded `ENV` in `Dockerfile`. Single source of truth. Don't add to Render envVars (it's silently ignored). To change, edit Dockerfile + commit + redeploy.
- **`PUBLIC_MAPTILER_API_KEY`**: ARG in Dockerfile + Render envVar (it's a secret, has to be Render-side). Empty default means missing-key → degraded map UX, not a crash.
- **Backend secrets (`SUPABASE_SERVICE_KEY`, `DATABASE_URL`, etc.)**: Render envVars only. Read at runtime via `os.getenv`. Never in Dockerfile.
- **`.env.production`**: keep it as a redundant source of truth for local dev parity. Vite reads it; Dockerfile ENV overrides it in production builds.
- **Don't add `frontend/.env.*` globs to `.dockerignore`** — that masks `.env.production` from the build context. Use explicit `frontend/.env.local` etc.

### Symptoms that mean you fell into the trap

- `_app/env.js` shows a `PUBLIC_*` value as `""` while Render env vars list shows the correct value → Dockerfile didn't bake it.
- Browser bundle hits the wrong API host → check Dockerfile's `ENV VITE_API_URL=` literal first.
- "supabaseUrl is required" thrown by `supabase-js` → empty `PUBLIC_SUPABASE_URL` baked in.
- New env var added in Render dashboard, no effect on next deploy → it's a build-time var that needs Dockerfile too.

### Verifying a deploy picked up new build-time vars

```bash
# What got baked into the SPA
curl -s https://scoutpost.ai/_app/env.js
# What URL the api-client will call (look at any chunk + grep)
curl -s "https://scoutpost.ai/_app/immutable/chunks/$(curl -s https://scoutpost.ai/ | grep -oE 'chunks/[A-Za-z0-9_-]+\.js' | head -1)" | grep -oE 'https://[^"]+supabase\.co[^"]*' | head -2
```

### When to break the rule

If a build-time var legitimately needs to differ between SaaS and OSS deploys (e.g. project URL when forking), then add an `ARG` *with the SaaS default*, override via Render envVar (which DOES work for ARGs declared in Dockerfile), and document in the Dockerfile comment near the ARG. Maintenance escape hatch — exercise sparingly.

---

## Local MuckRock Auth — DO NOT REGRESS

The private repo has two distinct local auth goals and they are easy to mix up:

- **Daily pre-push SaaS testing:** sign in with a real MuckRock account on `http://localhost:5173`, return to localhost, and view **real hosted account data** before deploy.
- **Disposable demo testing:** local Supabase Auth with dummy/demo data only.

### The correct daily SaaS path

`cd frontend && npm run dev`

This is the default local workflow for the private repo. It MUST keep the browser on localhost while still authenticating against the hosted Supabase project.

Architecture:

- Frontend runs on `http://localhost:5173`
- Vite proxies `/api/auth/*` to the local FastAPI process on `http://127.0.0.1:8000`
- FastAPI mounts `backend/app/routers/local_auth.py` only when `LOCAL_MUCKROCK_AUTH_BROKER=true`
- The local broker talks to **MuckRock + hosted Supabase admin APIs**
- The broker resolves the hosted magiclink server-side and redirects the browser back to `http://localhost:5173/auth/callback`

Required local browser env contract:

- `PUBLIC_MUCKROCK_BROKER_URL=http://localhost:5173/api/auth/login`
- `PUBLIC_MUCKROCK_POST_LOGIN_REDIRECT=http://localhost:5173/auth/callback`
- `PUBLIC_MUCKROCK_ENABLED=true`
- `PUBLIC_LOCAL_DEMO_MODE=false`

### Production must stay separate

Production auth still uses `backend/app/routers/muckrock_proxy.py` to preserve the MuckRock-registered hosted callback/webhook URLs and forward to Supabase Edge Functions.

Production SaaS is also still a Supabase deployment:

- `PUBLIC_DEPLOYMENT_TARGET=supabase`
- `PUBLIC_MUCKROCK_ENABLED=true`
- `frontend/src/lib/stores/auth.ts` must therefore keep resolving to
  `auth-supabase.ts`
- `auth-supabase.ts -> login()` must route through the MuckRock broker when
  `PUBLIC_MUCKROCK_ENABLED=true`

Do not "simplify" this by switching hosted production to `auth-muckrock.ts` or
by making `auth-supabase.ts -> login()` always redirect to `/login`. That breaks
the production MuckRock OAuth start path.

Do NOT:

- make daily local auth depend on `supabase functions serve auth-muckrock`
- make daily local auth depend on the already-deployed hosted broker
- repoint production callback/base URLs to the localhost broker path
- “simplify” local auth by sending the browser to `scoutpost.ai` mid-flow

### If you touch auth, verify all of this

```bash
cd frontend && npm run check
cd frontend && npm test
cd backend && python3 -m pytest tests/unit/ -v
cd backend && python3 -m pytest tests/unit/api/test_local_auth.py -v
cd backend && python3 -m pytest tests/unit/api/test_muckrock_proxy.py -v
bash scripts/ops/strip-oss.sh   # in throwaway copy/worktree
```

Also confirm manually:

- `/login` on localhost shows the MuckRock branch
- `/docs` and `/skills` stay on localhost
- `GET /api/auth/login` on localhost 302s to MuckRock with `redirect_uri=http://localhost:5173/api/auth/callback`

### Local launch and browser smoke scripts

Use these when you need a reproducible local UI check:

```bash
./start.sh saas      # Docker backend + Docker frontend at http://localhost:5173
./start.sh oss-demo  # Local Supabase demo frontend at http://localhost:4173
```

`cd frontend && npm run dev` remains the canonical daily private-repo SaaS workflow. `./start.sh saas` is the Docker full-stack path and must preserve the local broker contract above.

After the app is running and the browser is manually signed in if needed, use browser-harness smoke checks:

```bash
scripts/dev/browser-smoke.sh saas
scripts/dev/browser-smoke.sh oss-demo
```

The smoke script uses the current Chrome session through `browser-harness`. It must not type credentials. It opens the workspace, clicks `New Scout`, opens Page/Beat/Social/Civic panels, closes Agents/Preferences, and fails on console errors containing `void 0 is not a function`.

### Supabase test discipline

Keep Supabase integration tests small and direct. Do not build fixture-heavy local Supabase environments just to satisfy one env-gated test.

- For valuable function tests that need real Supabase services, use the local CLI stack and source `supabase status -o env` for `API_URL`, anon/publishable key, and service-role key.
- Runtime smoke tests must be explicitly gated (for example `COJO_SELFHOST_RUNTIME_SMOKE=1`) and guarded against accidental production targets unless the test deliberately opts into remote.
- Prefer local-only auth/API/database checks over external scrape, LLM, email, or Apify calls in CI.
- If a test cannot run, state the exact missing service or env and either wire it from the CLI or remove the test. Avoid vague "needs SUPABASE_URL/API_URL" notes.

---

AI-powered local news monitoring platform. Users create "scouts" that monitor websites, local news, or search queries on schedules, receiving email notifications when criteria are met. Scouts can be scoped by **location** (geo-targeted) or **topic** (keyword-based), or both.

**Production URL:** `https://scoutpost.ai` — API at `/api/*`

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | SvelteKit (static SPA), TailwindCSS |
| Backend | Supabase Edge Functions for scout CRUD/execution + residual FastAPI on Render |
| Database | Supabase Postgres |
| Scheduling | Supabase `pg_cron` |
| Auth | MuckRock OAuth broker -> Supabase Auth JWT (SaaS) / Supabase Auth (OSS, Bearer JWT) |
| AI | Gemini models through OpenRouter, pinned to Google Vertex with ZDR; Firecrawl (web search) |
| Email | Resend |
| Maps | MapTiler (geocoding) |

## Project Structure

```
/
├── frontend/          # SvelteKit SPA
├── supabase/          # Edge Functions + Postgres migrations
├── backend/           # residual FastAPI Python backend
├── cli/               # Deno scout CLI
└── docs/              # Detailed architecture docs
```

## Key Documentation

- **Supabase Edge Functions**: `docs/supabase/edge-functions.md` - live scout CRUD/execution functions
- **API Endpoints**: `docs/architecture/fastapi-endpoints.md` - All REST endpoints with examples
- **Page Scouts**: `docs/features/web-scouts.md` - Website change detection
- **Scout Runs**: `docs/supabase/scouts-runs.md` - Supabase scout and run records
- **Units & Dedup**: `docs/supabase/units-entities.md` - canonical information units and dedup
- **Entitlements & Credits**: `docs/muckrock/plans-and-entitlements.md` - MuckRock entitlement tiers, credit costs
- **MuckRock Integration**: `docs/muckrock/oauth-integration.md` - OAuth flow, session management
- **User Update Emails**: `docs/operations/user-update-email.md` - stateless MuckRock-to-Resend operator workflow
- **Team Plan**: `docs/muckrock/entitlements-team-design.md` - Shared credit pool, ORG# records, seat management
- **OSS / Self-Hosted**: `docs/oss/` - Architecture, adapters, Supabase, licensing, deployment, automation

## Service Documentation

Detailed docs for each sidebar service in `docs/features/`:

| Service | File | Description |
|---------|------|-------------|
| Page Scout (type `web`) | `web-scouts.md` | fresh Firecrawl scrape, local canonical hash baselines, criteria analysis |
| Page Archive | `page-archive.md` | Evidence-snapshot retrieve/toggle for Page Scouts (CLI `scout snapshots`, MCP `list_snapshots`/`get_snapshot_url`, REST `/snapshots`); `archive_enabled` on scout create/update |
| Location Scout (type `beat`) | `beat.md` | Location-based monitoring — niche local sources by default |
| Beat Scout (type `beat`) | `beat.md` | Topic/criteria monitoring — reliable sources by default |
| Scrape | `scrape.md` | Firecrawl extraction, format options |
| Social Scout (type `social`) | `social.md` | Social media monitoring, post diffing, Apify scraping |
| Civic Scout (type `civic`) | `civic.md` | Council website monitoring, PDF parsing, promise extraction |
| Feed & Export | `feed.md` | Information units, export generation |

## Sidebar Services

| View | Internal Type | Primary Runtime | Orchestrator |
|------|---------------|-----------------|--------------|
| Page Scout | `web` | `scout-web-execute` | `scout-web-execute/index.ts` |
| Location Scout | `beat` | `scout-beat-execute` | `beat_pipeline.ts` |
| Beat Scout | `beat` | `scout-beat-execute` | `beat_pipeline.ts` |
| Social Scout | `social` | `social-kickoff` | `social-kickoff/index.ts` |
| Civic Scout | `civic` | `civic-execute` | `civic-execute/index.ts` |
| Scrape / Ingest | N/A | `ingest` | `ingest/index.ts` |
| Feed / Export | N/A | `units` + residual FastAPI export | `units/index.ts` |

## Admin Dashboard (SaaS-only, stripped from OSS mirror)

Revenue reporting for MuckRock pilot invoicing. Accessible through the
Supabase `admin-report` Edge Function and the SvelteKit admin page by users in
`ADMIN_EMAILS`.

| File | Purpose |
|------|---------|
| `supabase/functions/admin-report/index.ts` | Metrics, usage query, monthly report, email send |
| `supabase/migrations/00025_credits.sql` | Credit pools and `usage_records` audit table |
| `frontend/src/routes/admin/+page.svelte` | Browser admin page |

**Usage records:** Written inside the Supabase `decrement_credits`
transaction. Stored in `usage_records` with 90-day retention and rolled up by
`admin-report`.

**Endpoints:**
- `GET /admin-report/usage?start_date=X&end_date=Y` — Query usage records
- `GET /admin-report/metrics` — Users by tier, orgs, scouts
- `POST /admin-report/report/monthly?year=X&month=Y` — Invoice JSON
- `POST /admin-report/report/send-email?year=X&month=Y` — Send report via Resend

## Directory-Specific Guides

- `/backend/AGENTS.md` - FastAPI structure and services
- `/cli/AGENTS.md` - `scout` CLI release procedure and conventions
- `/frontend/AGENTS.md` - SvelteKit components and stores
- `/docs/AGENTS.md` - Documentation structure and guidelines

## CLI: `scout`

Shipping product — a Deno-based CLI that talks to the REST API with a JWT
bearer token or `cj_...` API key. Until public release assets exist, install
directly from the public mirror with Deno.

- Source: `cli/` (see `cli/AGENTS.md` for full detail)
- Release tag pattern: `cli-v<MAJOR>.<MINOR>.<PATCH>` — push the tag, CI
  builds + signs + notarizes + publishes the release automatically
- Pre-release suffixes (marked as prerelease on GitHub): `-rc1`, `-beta1`,
  `-alpha1`
- Current install (anyone, no auth):
  `deno install -A -g -n scout https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/cli/scout.ts`
- Planned binaries: `scout-darwin-arm64`, `scout-darwin-x86_64`,
  `scout-linux-arm64`, `scout-linux-x86_64` — each with a sibling `.sha256`
  file after the first public release is published.
- Release workflow runs on the private monorepo (where signing secrets live)
  and publishes cross-repo via `OSS_RELEASE_PAT`.
- Apple secrets (on this repo only) are listed in `cli/AGENTS.md`. Cert
  expires 2031; Apple Developer Program renews 2026-04-20 ($109/yr);
  renewal decision point 2027-04-15.

## Scout Types

| Type | UI Name | Purpose | Scope | Notification |
|------|---------|---------|-------|--------------|
| `web` | Page Scout | Monitor URL for content changes | URL (+ optional topic) | When criteria match |
| `beat` | Location Scout | Location-based news monitoring | Location (+ optional criteria) | Always |
| `beat` | Beat Scout | Topic/criteria news monitoring | Criteria (no location) | Always |
| `social` | Social Scout | Monitor social media profiles | Platform + handle | Always |
| `civic` | Civic Scout | Monitor council meetings for promises | Domain + confirmed URLs | When promises found |

**Location Scout vs Beat Scout:** Both use the same backend `beat` pipeline. Location Scout defaults to **niche** sources (local blogs, community sites); Beat Scout defaults to **reliable** sources (established outlets). Source mode is togglable in both. Location Scout requires a location and optionally accepts criteria; Beat Scout requires criteria only.

**Scout topics are tags:** The UI stores multiple topics as a comma-separated string when saving a scout, but those values are semantically independent tags. Frontend display, filters, counts, and suggestions must use `frontend/src/lib/utils/topics.ts` (`parseTopicTags`, `collectTopicCounts`, `topicMatches`) rather than comparing `scout.topic` as one opaque string.

**Page Scout change detection:** Uses fresh Firecrawl scrape output plus a local, versioned canonical markdown hash stored in `raw_captures`. Legacy Firecrawl `changeTracking` remains only as a migration path for older scouts. See `docs/features/web-scouts.md`.

**Page Scout first-run extraction:** Users control whether to import existing page data via "Import current page data" toggle. OFF (default) establishes baseline only; ON extracts content to knowledge base.

## Data Flow

```
User creates scout → Supabase Edge Function → `scouts` row
                                      └── `schedule_scout` RPC registers pg_cron

On schedule → pg_cron → execute-scout Edge Function:
                                      ├── Route to scout-type executor
                                      ├── Execute scout logic
                                      ├── Store raw captures + information units
                                      ├── Send notification (Resend)
                                      └── Decrement credits via Supabase RPC
```

## Pre-Commit Verification - MANDATORY

**Run these checks before every commit that touches frontend code:**

```bash
cd frontend

# 1. If you added/changed any m.*() calls in .svelte or .ts files:
#    Ensure ALL keys exist in messages/en.json AND all 12 language files.
#    Then recompile:
npm run paraglide:compile

# 2. Lint (catches missing i18n keys, type errors, Svelte issues):
npm run check

# 3. Tests:
npm test
```

**Common failure: "Property 'xxx' does not exist on type 'typeof messages'"**
This means a `m.some_key()` call exists in a component but the key is missing from `messages/en.json`. Fix: add the key to `en.json` and all other language files (`da`, `de`, `es`, `fi`, `fr`, `it`, `nl`, `no`, `pl`, `pt`, `sv`), then recompile.

**Backend tests:**
```bash
cd backend && python3 -m pytest tests/unit/ -v
```

See `backend/tests/AGENTS.md` and `frontend/src/tests/AGENTS.md` for details.

**OSS mirror check — required when adding SaaS-only files or routes:**

This project ships an OSS mirror via `scripts/ops/strip-oss.sh`. When you add any of the following, you MUST update `scripts/ops/strip-oss.sh` to exclude it from the mirror:

- New backend routers, services, or schemas that are SaaS-only (admin, billing, MuckRock, Linear)
- New frontend routes that are SaaS-only (`/admin`, `/pricing`, `/terms`)
- New frontend components that reference MuckRock, credits, or upgrade flows
- New test files for SaaS-only code

**Verify before pushing:**
```bash
bash scripts/ops/strip-oss.sh  # Run in a throwaway worktree or after git stash
```
CI also runs this validation (`OSS mirror validation` check), but catching it locally is faster.

## CI/CD Pipeline

CI runs automatically on push to `develop` and on PRs to `main`. See **Deployment Workflow** above for the mandatory process.

### GitHub Actions Workflows

| File | Purpose | Trigger |
|------|---------|---------|
| `ci.yml` | Build, test, lint (4 required checks) | Push to `develop`, PR to `main` |
| `Codex.yml` | Codex PR assistant (`@Codex` in issues/PRs) | Issue/PR comments |
| `Codex-review.yml` | Auto-review on PRs | PR opened/synchronized |
| `cli-release.yml` | Build + sign + notarize + publish `scout` CLI binaries | Push of `cli-v*` tag (or manual dispatch) |
| `mirror-oss.yml` | Strip SaaS-only code and push to public OSS mirror | Push to `main` |

### Deploy pipeline

```
feature branch → push → CI runs
                          ↓
               PR to main → CI + Codex review
                          ↓
               merge → Render auto-deploys backend
```

### CI gotchas — passes locally, red in CI

Two non-required CI jobs routinely go red on changes that type-check and test
green locally. Check for them before pushing:

- **`Edge Function unit tests` (Deno type strictness).** CI pins `deno-version:
  v2.x`, which type-checks **stricter** than a typical local deno (e.g. 2.6.9).
  Two recurring traps:
  - Passing a `Uint8Array` as a `fetch`/`new Response(...)` **body** → newer deno
    lib types it as `Uint8Array<ArrayBufferLike>`, not assignable to `BodyInit`
    (TS2769). Fix: `body: bytes as unknown as BodyInit`.
  - Annotating a `setTimeout` handle as `number` (`let timer: number`) → CI types
    it as `Timeout` (TS2322: Type 'Timeout' is not assignable to type 'number').
    Fix: `ReturnType<typeof setTimeout>`, or `const timer =` and let inference
    handle it.
  Reproduce locally with the exact CI command:
  `cd supabase/functions && deno test --allow-env --allow-read=. --allow-import _shared/ scout-transport-execute/ transport-sampler/`
  (it type-checks by default). Logs are empty while a run is "in progress" — pull
  a specific finished job with `gh api repos/<org>/<repo>/actions/jobs/<id>/logs`
  and grep for `TS####` / `Type checking failed`.

- **`scrape-service unit tests` (100% coverage gate).** `scrape-service/pytest.ini`
  runs pytest with `--cov=app --cov-fail-under=100`. **Any** uncovered line in
  `scrape-service/app/*.py` — including `except` branches — fails the job
  (`Coverage failure: total of 99 is less than fail-under=100`). Add a test for
  every new branch. `Settings` is a frozen dataclass: a new required field also
  needs adding to `tests/conftest.py::make_settings`. The global python may lack
  `pytest-cov`; run `python3 -m pytest tests/ -o addopts=""` for a gate-free
  sanity pass, or install `pytest-cov` into a scratch dir to see per-file misses.

Neither job is one of the 4 **required** checks (`build-frontend`,
`test-frontend`, `test-backend`, `lint`), but both should be green before merge.
The `audit-backend` / `audit-frontend` jobs scan dependency CVEs and can be red
from pre-existing advisories unrelated to a PR — check whether the PR touched any
dependency manifest before chasing them.

## Environment Variables

### Backend (Render)
- `MUCKROCK_CLIENT_ID` - MuckRock OAuth client ID
- `MUCKROCK_CLIENT_SECRET` - MuckRock OAuth client secret
- `SESSION_SECRET` - HMAC signing key for OAuth/MCP broker state; legacy session JWT fallback only
- `OAUTH_REDIRECT_BASE` - Public URL the browser sees (needed behind proxy, e.g. `http://localhost:5173`)
- `OPENROUTER_API_KEY` - single external AI credential for structured extraction, exceptional scanned-PDF fallback, and 768-dimensional Gemini embeddings. Runtime flow is Scoutpost → OpenRouter → Google Vertex.
- `LLM_MODEL` - full OpenRouter model identifier (default: `google/gemini-2.5-flash-lite`).
- `FIRECRAWL_API_KEY` - Web scraping
- `APIFY_API_TOKEN` - Apify API token (social media scraping)
- `RESEND_API_KEY` - Email notifications
- `INTERNAL_SERVICE_KEY` - internal Edge Function service auth

All OpenRouter requests restrict routing to `only: ["google-vertex"]`, require
ZDR, deny provider data collection, and send `X-OpenRouter-Cache: false`.
Account-level OpenRouter logging/data-sharing controls are defense in depth.
Provider usage is recorded as OpenRouter usage with the upstream route metadata
when returned. Track the separately documented Gemini 2.5 Flash-Lite retirement
date of 2026-10-16; changing models is a distinct lifecycle change.

### Frontend (Build-time)
- `PUBLIC_MAPTILER_API_KEY` - Geocoding
