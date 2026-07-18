# Scoutpost Self-Hosted Setup

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
- `OPENROUTER_API_KEY`
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

3. Link the Supabase project:

```bash
supabase link --project-ref <project-ref>
```

4. Set and verify function secrets before activating new functions:

```bash
supabase secrets set \
  OPENROUTER_API_KEY=... \
  FIRECRAWL_API_KEY=... \
  RESEND_API_KEY=... \
  RESEND_FROM_EMAIL=... \
  APIFY_API_TOKEN=... \
  PUBLIC_MAPTILER_API_KEY=... \
  ADMIN_EMAILS=... \
  INTERNAL_SERVICE_KEY=...
```

5. Run Supabase migrations:

```bash
supabase db push
```

6. Seed the signup allowlist created by the migrations:

```bash
selfhost/adopt-signup-allowlist.sh \
  --admin <ADMIN_EMAIL> \
  --domain <ALLOWED_DOMAIN> \
  --project-ref <project-ref>
```

7. Deploy Edge Functions only after their secrets and database are ready:

```bash
supabase functions deploy
```

8. Write the project `.env` with the Supabase and frontend values:
- `DEPLOYMENT_TARGET=supabase`
- `OPENROUTER_API_KEY=<OPENROUTER_API_KEY>`
- `LLM_MODEL=google/gemini-2.5-flash-lite`
- `PUBLIC_DEPLOYMENT_TARGET=supabase`
- `PUBLIC_SUPABASE_URL=<SUPABASE_URL>`
- `PUBLIC_SUPABASE_ANON_KEY=<SUPABASE_ANON_KEY>`
- `PUBLIC_MAPTILER_API_KEY=<PUBLIC_MAPTILER_API_KEY>`
- optional: `PUBLIC_SELF_HOST_LOGIN_NOTE=Use your @example.org newsroom email.`

9. Build and deploy the frontend:

```bash
cd frontend
npm ci
npm run build
```

10. If the user wants the optional Python API add-on, deploy `backend/` separately or use `deploy/render/render.yaml`.

11. Install the upstream sync workflow by default:

```bash
mkdir -p .github/workflows
cp selfhost/sync-upstream.yml .github/workflows/sync-upstream.yml
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
- Before production traffic, enable OpenRouter ZDR/account privacy controls,
  disable prompt/response logging and data sharing, and constrain the key to
  Scoutpost's expected usage. Runtime requests pin `google-vertex`, require
  ZDR, deny provider data collection, and disable OpenRouter response caching.
- Treat OpenRouter and Google Vertex as separate processors in disclosures;
  the routing change reduces runtime credentials, not processor count.
- Keep `LLM_MODEL` in the `google/...` namespace. The runtime rejects models
  that cannot use the pinned Google Vertex route.
- Install the sync workflow by default and push it to `origin master`.
- Do not ask the user to paste secrets into AI chat. Prefer the generated
  `scoutpost-setup.json` manifest and `selfhost/setup-from-manifest.sh`.
- For existing deployments, run `selfhost/selfhost-doctor.sh` before merging
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
