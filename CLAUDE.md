# Scoutpost

## Session Preflight

Before coding in this project, read `/Users/tomvaillant/buried_signals/kit/coding-rules/SKILL.md`. It is the canonical source for workflow routing, coding standards, Jujutsu/version-control rules, GitHub operations, and parallel-agent isolation. Local instructions below add project-specific constraints.

## Deployment Workflow - MANDATORY

**NEVER push directly to `main`.** All changes go through a branch + PR. This is not optional.

1. **Check for worktrees first:**
   ```bash
   git worktree list
   ```
   If a worktree exists for the current task, work there.

2. **Create a branch** from `main` (or use `develop`):
   ```bash
   git checkout -b my-feature main
   ```

3. **Push the branch and open a PR to `main`:**
   ```bash
   git push -u origin my-feature
   gh pr create --title "..." --body "..."
   ```

4. **Wait for CI to pass** — 4 required checks must be green:
   - `build-frontend` — SvelteKit build
   - `test-frontend` — Vitest suite
   - `test-backend` — pytest unit tests
   - `lint` — svelte-check

5. **Merge the PR** — Render auto-deploys backend from `main`.

**Why:** Pushing to `main` triggers a Render deploy immediately with no safety net. The PR flow ensures CI passes and Claude reviews the code before anything reaches production.

---

## Node Version - IMPORTANT

**This project requires Node 22 LTS.** The Dockerfile and `frontend/.nvmrc` are pinned to Node 22. Using a different major version (especially Node 25+ with npm 11) will generate an incompatible `package-lock.json` that breaks the Render build (`npm ci` fails). Always run `nvm use` in `frontend/` before `npm install`.

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
curl -s https://www.scoutpost.ai/_app/env.js
# What URL the api-client will call (look at any chunk + grep)
curl -s "https://www.scoutpost.ai/_app/immutable/chunks/$(curl -s https://www.scoutpost.ai/ | grep -oE 'chunks/[A-Za-z0-9_-]+\.js' | head -1)" | grep -oE 'https://[^"]+supabase\.co[^"]*' | head -2
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
bash scripts/strip-oss.sh   # in throwaway copy/worktree
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

**Production URL:** `https://www.scoutpost.ai` — API at `/api/*`

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | SvelteKit (static SPA), TailwindCSS |
| Backend | FastAPI (Python), hosted on Render — production at `https://www.scoutpost.ai/api` |
| Database | DynamoDB (scout metadata + run history) |
| Scheduling | AWS EventBridge Scheduler |
| Auth | MuckRock OAuth 2.0 (SaaS, session cookies) / Supabase Auth (OSS, Bearer JWT) |
| AI | Gemini 2.5 Flash-Lite (default LLM, direct API), OpenRouter (fallback), Firecrawl (web search) |
| Email | Resend |
| Maps | MapTiler (geocoding) |

## Project Structure

```
/
├── frontend/          # SvelteKit SPA
├── backend/           # FastAPI Python backend
├── aws/               # Lambda functions + infrastructure
└── docs/              # Detailed architecture docs
```

## Key Documentation

- **AWS Architecture**: `docs/architecture/aws-architecture.md` - Lambda functions, DynamoDB schema, EventBridge
- **API Endpoints**: `docs/architecture/fastapi-endpoints.md` - All REST endpoints with examples
- **Page Scouts**: `docs/features/web-scouts.md` - Website change detection
- **Records & Dedup**: `docs/architecture/records-and-deduplication.md` - DynamoDB records, dedup layers
- **Entitlements & Credits**: `docs/muckrock/plans-and-entitlements.md` - MuckRock entitlement tiers, credit costs
- **MuckRock Integration**: `docs/muckrock/oauth-integration.md` - OAuth flow, session management
- **Team Plan**: `docs/muckrock/entitlements-team-design.md` - Shared credit pool, ORG# records, seat management
- **OSS / Self-Hosted**: `docs/oss/` - Architecture, adapters, Supabase, licensing, deployment, automation
- **AWS Deployment**: `aws/README.md` - Lambda deployment commands

## Service Documentation

Detailed docs for each sidebar service in `docs/features/`:

| Service | File | Description |
|---------|------|-------------|
| Page Scout (type `web`) | `web-scouts.md` | Firecrawl changeTracking, per-scout baselines, criteria analysis |
| Location Scout (type `beat`) | `beat.md` | Location-based monitoring — niche local sources by default |
| Beat Scout (type `beat`) | `beat.md` | Topic/criteria monitoring — reliable sources by default |
| Scrape | `scrape.md` | Firecrawl extraction, format options |
| Social Scout (type `social`) | `social.md` | Social media monitoring, post diffing, Apify scraping |
| Civic Scout (type `civic`) | `civic.md` | Council website monitoring, PDF parsing, promise extraction |
| Feed & Export | `feed.md` | Information units, export generation |

## Sidebar Services

| View | Internal Type | Primary Runtime | Orchestrator |
|------|---------------|-----------------|--------------|
| Page Scout | `web` | `scout-web-execute` | `scout_service.py` |
| Location Scout | `beat` | `scout-beat-execute` | `beat_pipeline.ts` |
| Beat Scout | `beat` | `scout-beat-execute` | `beat_pipeline.ts` |
| Social Scout | `social` | `social-kickoff` | `social_orchestrator.py` |
| Civic Scout | `civic` | `civic-execute` | `civic_orchestrator.py` |
| Scrape | N/A | `data_extractor.py` | `firecrawl_client.py` |
| Feed / Export | N/A | `export.py` | `export_generator.py` |

## Admin Dashboard (SaaS-only, stripped from OSS mirror)

Revenue reporting for MuckRock pilot invoicing. Accessible at `/api/admin/` (browser) by users in `ADMIN_EMAILS`.

| File | Purpose |
|------|---------|
| `backend/app/routers/admin.py` | Dashboard HTML + JSON API endpoints |
| `backend/app/services/admin_report_service.py` | Report generation, metrics, email template |
| `backend/app/adapters/aws/admin_storage.py` | USAGE# record storage + aggregate queries |
| `backend/app/schemas/admin.py` | Pydantic response models |
| `backend/app/dependencies/auth.py` | `require_admin` dependency (ADMIN_EMAILS check) |

**USAGE# records:** Written on every credit decrement (fire-and-forget from `decrement_credit()` in `billing.py`). Stored in DynamoDB with 90-day TTL. PK is `ORG#{id}` or `USER#{id}`, SK is `USAGE#{timestamp}#{uuid}`.

**Endpoints:**
- `GET /api/admin/` — Browser dashboard (metrics + current month invoice)
- `GET /api/admin/usage?start_date=X&end_date=Y` — Query usage records
- `GET /api/admin/metrics` — Users by tier, orgs, scouts
- `POST /api/admin/report/monthly?year=X&month=Y` — Invoice JSON
- `POST /api/admin/report/send-email?year=X&month=Y` — Send report via Resend

## Directory-Specific Guides

- `/aws/CLAUDE.md` - AWS infrastructure and Lambda details
- `/backend/CLAUDE.md` - FastAPI structure and services
- `/cli/CLAUDE.md` - `scout` CLI release procedure and conventions
- `/frontend/CLAUDE.md` - SvelteKit components and stores
- `/docs/CLAUDE.md` - Documentation structure and guidelines

## CLI: `scout`

Shipping product — a Deno-based CLI that talks to the REST API with a JWT
bearer token or `cj_...` API key. Until public release assets exist, install
directly from the public mirror with Deno.

- Source: `cli/` (see `cli/CLAUDE.md` for full detail)
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
- Apple secrets (on this repo only) are listed in `cli/CLAUDE.md`. Cert
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

**Page Scout change detection:** Uses Firecrawl `changeTracking` with per-scout `tag` parameter. Each scout has its own baseline. See `docs/features/web-scouts.md`.

**Page Scout first-run extraction:** Users control whether to import existing page data via "Import current page data" toggle. OFF (default) establishes baseline only; ON extracts content to knowledge base.

## Data Flow

```
User creates scout → FastAPI → AWS API Gateway → Lambda creates:
                                                  ├── EventBridge Schedule (cron)
                                                  └── DynamoDB SCRAPER# record

On schedule → EventBridge → scraper-lambda → FastAPI scouts endpoint:
                                             ├── Execute scout logic
                                             ├── AI analysis
                                             ├── Send notification (Resend)
                                             └── Decrement credits (MuckRock entitlements)
                            ↓
              scraper-lambda stores TIME# record in DynamoDB
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

See `backend/tests/CLAUDE.md` and `frontend/src/tests/CLAUDE.md` for details.

**OSS mirror check — required when adding SaaS-only files or routes:**

This project ships an OSS mirror via `scripts/strip-oss.sh`. When you add any of the following, you MUST update `strip-oss.sh` to exclude it from the mirror:

- New backend routers, services, or schemas that are SaaS-only (admin, billing, MuckRock, Linear)
- New frontend routes that are SaaS-only (`/admin`, `/pricing`, `/terms`)
- New frontend components that reference MuckRock, credits, or upgrade flows
- New test files for SaaS-only code

**Verify before pushing:**
```bash
bash scripts/strip-oss.sh  # Run in a throwaway worktree or after git stash
```
CI also runs this validation (`OSS mirror validation` check), but catching it locally is faster.

## CI/CD Pipeline

CI runs automatically on push to `develop` and on PRs to `main`. See **Deployment Workflow** above for the mandatory process.

### GitHub Actions Workflows

| File | Purpose | Trigger |
|------|---------|---------|
| `ci.yml` | Build, test, lint (4 required checks) | Push to `develop`, PR to `main` |
| `claude.yml` | Claude PR assistant (`@claude` in issues/PRs) | Issue/PR comments |
| `claude-code-review.yml` | Auto-review on PRs | PR opened/synchronized |
| `cli-release.yml` | Build + sign + notarize + publish `scout` CLI binaries | Push of `cli-v*` tag (or manual dispatch) |
| `mirror-oss.yml` | Strip SaaS-only code and push to public OSS mirror | Push to `main` |

### Deploy pipeline

```
feature branch → push → CI runs
                          ↓
               PR to main → CI + Claude review
                          ↓
               merge → Render auto-deploys backend
```

## Environment Variables

### Backend (Render)
- `MUCKROCK_CLIENT_ID` - MuckRock OAuth client ID
- `MUCKROCK_CLIENT_SECRET` - MuckRock OAuth client secret
- `SESSION_SECRET` - JWT session signing key
- `OAUTH_REDIRECT_BASE` - Public URL the browser sees (needed behind proxy, e.g. `http://localhost:5173`)
- `OPENROUTER_API_KEY` - AI access
- `LLM_MODEL` - LLM model identifier (default: `gemini-2.5-flash-lite`). Gemini models route to Google AI direct API; others route to OpenRouter.
- `GEMINI_API_KEY` - Gemini API key (LLM + multimodal embeddings)
- `FIRECRAWL_API_KEY` - Web scraping
- `APIFY_API_TOKEN` - Apify API token (social media scraping)
- `RESEND_API_KEY` - Email notifications
- `INTERNAL_SERVICE_KEY` - Lambda → FastAPI auth
- `AWS_API_BASE_URL` - AWS API Gateway URL

### Frontend (Build-time)
- `PUBLIC_MAPTILER_API_KEY` - Geocoding

### AWS Lambda
- See `aws/README.md` for Lambda-specific env vars
