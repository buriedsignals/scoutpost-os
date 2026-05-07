# coJournalist Deployment Guide

coJournalist OSS is now Supabase-first.

Default runtime:
- Supabase Auth for sign-in
- Supabase Postgres for storage
- Supabase Edge Functions for the public backend surface
- Static frontend on the host of your choice

Optional runtime:
- FastAPI on Render or another Python host if your newsroom wants the legacy/internal `/api/v1` add-on

The public OSS branch is `master`.

## Prerequisites

Required API keys:

| Service | Purpose | Required |
| --- | --- | --- |
| Gemini | LLM + embeddings | Yes |
| Firecrawl | Web scraping/search | Yes |
| Resend | Email notifications | Yes |
| Apify | Social media scraping | Yes |
| MapTiler | Geocoding/location autocomplete | Yes |

You also need:
- Node 22 LTS
- Git
- Supabase CLI
- Docker only if you self-host Supabase or run the full Docker stack

## Recommended Path: Managed Supabase + Static Frontend

### 1. Clone the OSS repo

```bash
git clone https://github.com/buriedsignals/scoutpost-os.git
cd scoutpost-os
git checkout master
```

### 2. Create or choose a Supabase project

Collect:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`
- `SUPABASE_JWT_SECRET`
- `SUPABASE_PROJECT_REF`

### 3. Run migrations

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

### 4. Deploy Edge Functions

```bash
supabase functions deploy --all
```

Set the secrets used by your functions:

```bash
supabase secrets set \
  GEMINI_API_KEY=... \
  FIRECRAWL_API_KEY=... \
  RESEND_API_KEY=... \
  RESEND_FROM_EMAIL=... \
  APIFY_API_TOKEN=... \
  PUBLIC_MAPTILER_API_KEY=... \
  ADMIN_EMAILS=... \
  INTERNAL_SERVICE_KEY=...
```

### 5. Configure the frontend

Create your root `.env`:

```bash
cat > .env <<'EOF'
DEPLOYMENT_TARGET=supabase
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
SUPABASE_ANON_KEY=...
SUPABASE_JWT_SECRET=...
GEMINI_API_KEY=...
LLM_MODEL=gemini-2.5-flash-lite
FIRECRAWL_API_KEY=...
RESEND_API_KEY=...
RESEND_FROM_EMAIL=...
APIFY_API_TOKEN=...
INTERNAL_SERVICE_KEY=...
ADMIN_EMAILS=admin@example.com
SIGNUP_ALLOWED_DOMAINS=example.com
PUBLIC_DEPLOYMENT_TARGET=supabase
PUBLIC_SUPABASE_URL=...
PUBLIC_SUPABASE_ANON_KEY=...
PUBLIC_MAPTILER_API_KEY=...
PUBLIC_SELF_HOST_LOGIN_NOTE=Use your @example.org newsroom email.
EOF
```

The OSS frontend defaults to `PUBLIC_SUPABASE_URL/functions/v1`, so you do not need to point it at same-origin `/api`.
`PUBLIC_SELF_HOST_LOGIN_NOTE` is optional; leave it blank to keep the default login copy.

### 6. Build and deploy the frontend

```bash
cd frontend
npm ci
npm run build
```

Publish `frontend/build/` to any static host:
- Render Static Site
- Cloudflare Pages
- Vercel
- Netlify
- S3/CloudFront

## Optional Path: Render Blueprint

If you want a ready-made Render configuration, use `deploy/render/render.yaml`.

That blueprint:
- deploys the static frontend
- optionally deploys the legacy FastAPI add-on

The FastAPI service is not required for OSS auth or the default workspace flows.

## Optional Path: Full Docker Self-Hosting

Use `deploy/docker/` if you want the whole stack locally or on your own infra:

```bash
cd deploy/docker
cp .env.example .env
docker compose up -d
```

Then run migrations against your database and deploy Edge Functions against that Supabase instance.

## Updates

Install the sync workflow in your fork:

```bash
mkdir -p .github/workflows
cp automation/sync-upstream.yml .github/workflows/sync-upstream.yml
git add .github/workflows/sync-upstream.yml
git commit -m "ci: install sync-upstream"
git push origin master
```

The workflow opens or updates a PR from `cojournalist/sync-upstream` to `master`.
It lists changed migrations and configured deployment secrets in the PR body,
but it does not apply migrations or redeploy services.

After reviewing and merging an upstream sync PR, run:

```bash
automation/selfhost-doctor.sh
supabase db push
supabase functions deploy --all
```

## Optional FastAPI Add-on

The Python backend remains available for newsrooms that want the legacy/internal API surface, especially `/api/v1`.

It is not required for:
- login
- user auth state
- feed unit browsing
- scouts CRUD/run
- ingest
- entities
- reflections

## Verification

Check the OSS frontend:
- open `/login`
- create or sign in with a Supabase email/password account
- create a scout
- confirm units load in the feed

If you also deployed the optional FastAPI add-on, verify:

```bash
curl https://your-fastapi-host/api/health
```

Expected:

```json
{"status":"healthy"}
```
