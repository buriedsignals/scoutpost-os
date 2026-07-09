# Newsroom Docker Install

This is the recommended self-host install path for newsrooms. It keeps the
operator machine simple: install Docker, create a local setup manifest, then run
the installer container. The public `/setup` page does not collect API keys or
service credentials.

## What gets installed

Scoutpost self-hosting uses this stack:

| Layer            | Technology              | Purpose                                                |
| ---------------- | ----------------------- | ------------------------------------------------------ |
| Frontend         | SvelteKit static build  | Newsroom web app                                       |
| Backend runtime  | Supabase Edge Functions | REST API, MCP endpoint, scout execution                |
| Database         | Supabase Postgres       | Scouts, findings, users, audit records                 |
| Scheduling       | Supabase/Postgres cron  | Recurring scout runs                                   |
| Auth             | Supabase Auth           | Newsroom user accounts and domain allowlist            |
| AI extraction    | Gemini 2.5 Flash-Lite   | Summaries, structured extraction, classification       |
| Web scraping     | Firecrawl               | Page/civic source fetching and change detection        |
| Beat retrieval   | Exa                     | Beat Scout search port (Exa-only; no Firecrawl fallback) |
| Social scraping  | Apify                   | Social scout actor runs                                |
| Email            | Resend                  | Scout notifications                                    |
| Maps/geocoding   | MapTiler                | Location scout UI and geocoding                        |
| Operator tooling | Docker image            | Git, GitHub CLI, Supabase CLI, Deno, Node, jq, OpenSSL |
| End-user CLI     | `scout`                 | Optional journalist/agent client after deployment      |

FastAPI is optional for self-hosting. The normal OSS path uses Supabase Edge
Functions directly.

## Local manifest

Start from the committed example manifest:

```bash
curl -fsSLO https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/deploy/installer/scoutpost-setup.example.json
cp scoutpost-setup.example.json scoutpost-setup.json
chmod 600 scoutpost-setup.json
$EDITOR scoutpost-setup.json
```

`scoutpost-setup.json` contains API keys, Supabase config, auth domains, and
hosting choices. It is gitignored and must stay local. Credentials are not baked
into the Docker image; the manifest is mounted read-only into the container at
runtime.

## Required accounts and keys

Before running install, collect:

- Supabase Cloud access token for managed Supabase installs
- Supabase project ref, URL, anon key, service role key, and JWT secret for an
  existing Supabase project
- Gemini API key
- Firecrawl API key
- Exa API key (Beat Scout retrieval port — Beat search is Exa-only, so Beat
  Scout runs fail without it; not needed if you do not use Beat Scout)
- Apify API token
- Resend API key and sender email
- MapTiler public API key
- GitHub access for the newsroom fork if you want update PRs
- Optional Page Archive trust layer (only if you enable evidence archiving on Page
  Scouts — all optional, archiving degrades gracefully without them):
  - `TSA_URL` — RFC 3161 timestamp authority endpoint (defaults to a public TSA;
    unset/unreachable → snapshots store with `tsa_status` unset, no `.tsr`)
  - `SPN_ACCESS_KEY` + `SPN_SECRET_KEY` — Internet Archive "Save Page Now" S3-style
    keys (from your archive.org account); absent → `wayback_status` unset, no public
    submission. Set both or neither.
  - `PUBLIC_APP_URL` — your deployment's app origin; already required for auth, and
    reused for the "View archived snapshot" email deep link (see `docs/features/page-archive.md`)

For Supabase Cloud, the manifest field `supabase.access_token` is used as
`SUPABASE_ACCESS_TOKEN`. Docker should not start browser-based Supabase login.

## Initial install

Put `scoutpost-setup.json` in an install directory, then run:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \
  ghcr.io/buriedsignals/scoutpost-installer:latest install
```

If the prebuilt image cannot be pulled, build the same installer image locally
from a Scoutpost checkout:

```bash
docker build -f deploy/installer/Dockerfile -t scoutpost-installer .
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \
  scoutpost-installer install
```

## What install does

The installer:

1. Finds or clones the Scoutpost OSS checkout.
2. Reads `scoutpost-setup.json`.
3. Authenticates Supabase CLI with `supabase.access_token` when present.
4. Creates or links the Supabase project depending on the manifest mode.
5. Pushes Supabase config and migrations when a project ref is available.
6. Deploys Supabase Edge Functions.
7. Sets Supabase Edge Function secrets.
8. Seeds Supabase Vault values used by scheduled jobs.
9. Writes local env files:
   - `.env`
   - `frontend/.env.production.local`
10. Builds the static frontend.
11. Installs `.github/workflows/sync-upstream.yml` for update PRs.

Generated local env files and setup artifacts are gitignored.

## Validation

After install:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \
  ghcr.io/buriedsignals/scoutpost-installer:latest doctor
```

Doctor checks for:

- unresolved merge conflicts
- dirty/untracked deployment files
- hosted Scoutpost Supabase references accidentally copied into self-host config
- root/frontend Supabase URL mismatches
- Supabase signup hook state
- GitHub CLI and Supabase CLI availability/auth warnings

Warnings are not always blockers. A blocker means fix the issue before deploy.

## Downstream updates

Run updates from the newsroom fork checkout:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.config/gh:/root/.config/gh:ro" \
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \
  ghcr.io/buriedsignals/scoutpost-installer:latest update
```

The update command:

1. Refuses to run from a dirty checkout.
2. Runs doctor before the merge.
3. Fetches upstream Scoutpost OSS.
4. Creates a dated maintenance branch.
5. Merges upstream.
6. Refreshes the sync workflow.
7. Runs doctor again.
8. Opens a GitHub PR when `gh` auth is mounted.

It does not silently push database changes to production. Review migration
changes before applying them.

## `scout` CLI

The Docker installer is the deployment and maintenance operator. It does not
install the `scout` CLI onto journalists' machines.

After deployment, install `scout` per editor or agent machine:

```bash
deno install -A -g -n scout https://raw.githubusercontent.com/buriedsignals/scoutpost-os/main/cli/scout.ts
scout config set api_url=https://<your-supabase-url>/functions/v1
scout config set supabase_anon_key=<SUPABASE_ANON_KEY>
scout config set api_key=cj_...
scout scouts list
```

Use the newsroom deployment URL, API base, MCP URL, and API keys generated by
the self-host install. Do not point a self-hosted newsroom at `scoutpost.ai`
unless it is intentionally using the hosted SaaS.

## Security model

- The Docker image is public and contains no newsroom credentials.
- `scoutpost-setup.json` contains secrets and must not be committed.
- The manifest is mounted read-only into Docker.
- Generated env files are local and gitignored.
- Firecrawl browser authentication is not run inside Docker; the manifest API
  key is used as the deployment credential.
- Supabase browser login is not run inside Docker; use `supabase.access_token`
  or `SUPABASE_ACCESS_TOKEN`.

## Troubleshooting

If Docker pull fails with `no matching manifest`, rebuild/publish the installer
image for both `linux/amd64` and `linux/arm64`.

If Docker pull fails with `unauthorized`, the GHCR package is not public or the
organization blocks public package visibility.

If Supabase commands fail with authentication errors, regenerate the setup
manifest with a valid Supabase access token.

If the frontend points at the hosted Scoutpost Supabase project, rerun setup
with the newsroom Supabase URL and rerun doctor.
