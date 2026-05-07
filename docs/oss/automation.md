# OSS Automation

The public OSS automation surface is now:
- `automation/setup.sh`
- `automation/SETUP_AGENT.md`
- `automation/sync-upstream.yml`
- `automation/selfhost-doctor.sh`
- `automation/adopt-signup-allowlist.sh`
- `deploy/installer/Dockerfile`

These files are public and no longer use any license-gated flow.

## Current model

- Supabase is the default runtime.
- Supabase Edge Functions are the default backend surface.
- Static frontend hosting is the default deployment path.
- FastAPI is optional and only kept for newsrooms that want the legacy/internal Python API add-on.

## Sync workflow

`automation/sync-upstream.yml` is designed for forks of `buriedsignals/scoutpost-os` on branch `master`.

It opens or updates a PR from `cojournalist/sync-upstream` to `master`.
It does not push directly to `master`, run `supabase db push`, or redeploy
services. The PR body lists the upstream commit, changed migrations, and
whether optional deployment secrets are configured.

For first-time installs or manual catch-up pulls, use
`automation/upstream-maintenance-codex-prompt.txt`. That prompt is intentionally
conservative for newsroom deployments:
- it searches for a nested Git checkout before editing, instead of assuming the
  current directory is the repo root
- it sets a repository-local Git committer identity if the server has none
- it preserves local `.env`, Supabase config, and deployment-specific edits
- it refuses to run `supabase db push` while local or untracked migration files
  are present
- it reports missing `gh` or GitHub push credentials instead of asking anyone to
  paste secrets into chat

## Existing installs

Do not re-clone or reset an existing newsroom deployment. Update the fork in
place:

```bash
git fetch upstream master
git switch -c cojournalist/upstream-maintenance-$(date -u +%Y-%m-%d)
automation/selfhost-doctor.sh
git merge upstream/master
```

If `automation/selfhost-doctor.sh` reports a custom
`[auth.hook.before_user_created]` hook, move the newsroom's local signup policy
into the upstream allowlist table before switching hooks:

```bash
automation/adopt-signup-allowlist.sh --domain example.org --admin editor@example.org --project-ref <project-ref>
```

Then set `supabase/config.toml` to the upstream hook:

```toml
[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/public/hook_restrict_signup_by_allowlist"
```

Review changed and untracked migration files before applying anything to the
live database:

```bash
supabase db push
supabase functions deploy --all
```

Never accept upstream `supabase/config.toml` blindly over a local auth hook, and
never overwrite `.env`, `frontend/.env.production.local`, `.env.production`, or
deployment-specific secrets during an upstream merge.

## Dockerized installer

For operators who do not want to install the local toolchain, download
`scoutpost-setup.json` and `scoutpost-docker-install.sh` from `/setup`,
keep them in the same directory, and run:

```bash
bash scoutpost-docker-install.sh install
```

The script pulls the prebuilt image when available. If the registry image cannot
be pulled, it clones `scoutpost-os` into the workspace and builds the same
installer image locally.

The raw equivalent is:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \
  ghcr.io/buriedsignals/scoutpost-installer:latest install
```

The container runs the same `automation/setup-from-manifest.sh` path as the
non-Docker installer. If `/workspace` is not already a coJournalist checkout,
the image clones `buriedsignals/scoutpost-os` into
`/workspace/scoutpost-os`.
Generated frontend secrets are written to `frontend/.env.production.local`,
which is gitignored and keeps downstream update PRs cleaner than writing to the
tracked `frontend/.env.production`.
The installer skips optional local/provider CLI installs by default and never
launches Firecrawl browser authentication inside Docker; the manifest
`FIRECRAWL_API_KEY` is enough for deployment. Set
`COJOURNALIST_INSTALL_AGENT_TOOLING=true` only when deliberately provisioning an
operator machine with local CLIs.
For Supabase Cloud, the setup manifest must include `supabase.access_token` or
the environment must provide `SUPABASE_ACCESS_TOKEN`; the Docker installer
refuses to start browser-based `supabase login`.

It also exposes:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \
  ghcr.io/buriedsignals/scoutpost-installer:latest doctor

docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \
  -v "$HOME/.config/gh:/root/.config/gh:ro" \
  ghcr.io/buriedsignals/scoutpost-installer:latest update
```

Run `update` from the downstream newsroom fork checkout. It prepares a
maintenance branch and opens a PR when GitHub CLI auth is mounted.

## Local self-host smoke

CI runs a local Supabase smoke test that stays inside the CLI stack. It applies
the migrations, waits for the local Edge Runtime, seeds the signup allowlist,
checks that disallowed signup is rejected, and performs an authenticated scouts
create/list/delete round-trip. It deliberately avoids Firecrawl, LLM, email,
Apify, and live newsroom data.

To run the same check manually from a clean local Supabase stack:

```bash
supabase start
supabase db reset --local --yes
supabase status -o env > /tmp/scout-supabase.env
```

In another terminal:

```bash
set -a
source /tmp/scout-supabase.env
set +a
SCOUT_SELFHOST_RUNTIME_SMOKE=1 deno test --allow-env --allow-net supabase/functions/_shared/selfhost_runtime_smoke_test.ts
```

If you changed `[auth.hook.before_user_created]` in `supabase/config.toml` on
an already-running local stack, run `supabase stop --no-backup` and
`supabase start` before the smoke so GoTrue reloads the hook configuration.

## What changed

Removed from the OSS story:
- license validation
- license portal downloads
- `main` branch assumptions for the public mirror
- Render as the required/default deployment target
