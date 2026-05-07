# coJournalist Self-Hosted Setup

Use this when the user wants to deploy `buriedsignals/scoutpost-os`.

## Deployment Model

Assume the OSS deployment is:
- Supabase Auth for login
- Supabase Postgres for storage
- Supabase Edge Functions for the default backend surface
- Static frontend on any host

FastAPI is optional. Treat it as an add-on only if the user explicitly wants the legacy/internal `/api/v1` surface.

## Required Inputs

Collect these before you start:
- `GEMINI_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `APIFY_API_TOKEN`
- `PUBLIC_MAPTILER_API_KEY`
- `ADMIN_EMAILS`
- `SIGNUP_ALLOWED_DOMAINS`

Supabase:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`
- `SUPABASE_JWT_SECRET`
- `SUPABASE_PROJECT_REF`

## Required Steps

1. Clone the OSS repo and use branch `master`.

```bash
git clone https://github.com/buriedsignals/scoutpost-os.git
cd scoutpost-os
git checkout master
```

2. Read the setup docs before changing anything:
- `deploy/SETUP.md`
- `deploy/docker/.env.example`
- `deploy/docker/docker-compose.yml`
- `deploy/render/render.yaml`

3. Run Supabase migrations:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

4. Deploy Edge Functions:

```bash
supabase functions deploy --all
```

5. Set the function secrets:

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

6. Seed the signup allowlist created by the migrations:

```bash
automation/adopt-signup-allowlist.sh \
  --admin <ADMIN_EMAIL> \
  --domain <ALLOWED_DOMAIN> \
  --project-ref <project-ref>
```

7. Write the project `.env` with the Supabase and frontend values:
- `DEPLOYMENT_TARGET=supabase`
- `PUBLIC_DEPLOYMENT_TARGET=supabase`
- `PUBLIC_SUPABASE_URL=<SUPABASE_URL>`
- `PUBLIC_SUPABASE_ANON_KEY=<SUPABASE_ANON_KEY>`
- `PUBLIC_MAPTILER_API_KEY=<PUBLIC_MAPTILER_API_KEY>`
- optional: `PUBLIC_SELF_HOST_LOGIN_NOTE=Use your @example.org newsroom email.`

8. Build and deploy the frontend:

```bash
cd frontend
npm ci
npm run build
```

9. If the user wants the optional Python API add-on, deploy `backend/` separately or use `deploy/render/render.yaml`.

10. Install the upstream sync workflow by default:

```bash
mkdir -p .github/workflows
cp automation/sync-upstream.yml .github/workflows/sync-upstream.yml
git add .github/workflows/sync-upstream.yml
git commit -m "ci: install sync-upstream GitHub Action"
git push origin master
```

Tell the operator to set these GitHub secrets so future maintenance can report
deployment readiness without secret values in chat:
- `SUPABASE_PROJECT_REF`
- `SUPABASE_ACCESS_TOKEN`
- optional: `RENDER_DEPLOY_HOOK`

The sync workflow opens an upstream-sync PR and reports migrations. It does not
run `supabase db push` or deploy functions automatically.

## Guardrails

- Do not assume Render is required.
- Do not assume same-origin `/api` is required.
- Do not use any license-key flow; the setup is public.
- Do not use `main` for the public OSS repo. Use `master`.
- Install the sync workflow by default and push it to `origin master`.
- Do not ask the user to paste secrets into AI chat. Prefer the generated
  `scoutpost-setup.json` manifest and `automation/setup-from-manifest.sh`.
- For existing deployments, run `automation/selfhost-doctor.sh` before merging
  upstream. Do not re-clone, overwrite `.env`, or accept upstream
  `supabase/config.toml` over a local auth hook without adopting the allowlist.

## Verification

Verify these:
- `/login` uses Supabase email/password auth
- the frontend can reach Supabase Edge Functions
- scouts can be created
- feed units load

If the optional FastAPI add-on was deployed, also verify:

```bash
curl https://<fastapi-host>/api/health
```
