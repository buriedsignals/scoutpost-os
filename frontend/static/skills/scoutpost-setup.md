---
name: scoutpost-setup
description: >
  Install, self-host, configure, or validate Scoutpost for hosted SaaS or
  self-hosted deployments, including MCP and CLI setup.
---

# Scoutpost setup skill

Use this when the user wants to install, self-host, configure, or validate
Scoutpost. For day-to-day newsroom use, prefer the product skill at
`https://www.scoutpost.ai/skills/scoutpost.md`.

## Public surfaces

For hosted SaaS, the public app is `https://www.scoutpost.ai`.

For self-hosted deployments, use the newsroom's own deployed app URL and the
API/MCP targets generated during setup. Supabase is the supported managed setup
path. Manual / bring your own platform is a CTO-owned planning and porting
path, not an automatic provider deployment. Do not point newsroom agents at the
hosted scoutpost.ai Supabase project.

## Hosted agent setup

1. Open Scoutpost, choose **Connect Agent**, then create a `cj_...` API key from the API panel.
2. Configure the agent to use either MCP or the CLI.
3. Verify with a read-only operation first: list scouts or list units.
4. Do not run scouts or create scheduled monitors until the user confirms credit
   spend.

## CLI setup

Use Deno 2.x to install directly from the public mirror:

Hosted example:

```bash
deno install -A -g -n scout https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/cli/scout.ts
scout config set api_url=https://www.scoutpost.ai/functions/v1
scout config set api_key=<cj_... API key>
scout scouts list
```

Self-hosted example:

```bash
scout config set api_url=https://<project-ref>.supabase.co/functions/v1
scout config set supabase_anon_key=<SUPABASE_ANON_KEY>
scout config set api_key=<cj_... API key>
scout scouts list
```

## MCP setup

Hosted remote MCP endpoint:

```text
https://www.scoutpost.ai/mcp
```

The MCP server uses OAuth discovery at:

```text
https://www.scoutpost.ai/mcp/.well-known/oauth-authorization-server
https://www.scoutpost.ai/mcp/.well-known/oauth-protected-resource
```

If OAuth is unavailable in the client, use a `cj_...` API key through the CLI or
REST API instead.

Self-hosted MCP endpoint:

```text
https://<project-ref>.supabase.co/functions/v1/mcp-server
```

If a self-hosted deployment fronts Supabase with its own domain, advertise and
use that public MCP URL consistently. Set `MCP_SERVER_BASE_URL` to the same
external URL so issuer, token, register, authorize, and protected-resource
metadata all match what the MCP client connects to.

## Self-hosted setup checks

Before treating a Supabase self-hosted install as ready:

- apply all Supabase migrations
- deploy Edge Functions
- create the required Supabase secrets
- confirm MapTiler is configured; location scouting depends on it
- confirm auth mode is intentionally set for hosted or local/demo use
- open `/setup` and verify the instructions match the target deployment
- verify REST list endpoints return `{ "items": [...], "pagination": ... }`
- verify MCP `initialize` and `tools/list` against the self-hosted MCP URL
- verify a read-only CLI call with a `cj_...` API key

## Manual provider setup

If `/setup` generated `scoutpost-provider-porting.md`, the operator selected
Manual / bring your own platform. In that mode:

- read the local `scoutpost-setup.json`
- read `scoutpost-provider-porting.md`
- inspect `docs/supabase/migrations.md`
- inspect `supabase/migrations/` in numeric order
- treat those migrations as Scoutpost's canonical data model and operational
  contract, not as provider-neutral commands
- fetch current official documentation for the selected provider before
  proposing migration or runtime translations
- prepare reviewable changes for the operator's technical team
- do not run `supabase db push`, deploy Edge Functions, or apply provider
  infrastructure changes unless the operator explicitly approves that exact
  action

Manual providers must account for Supabase-specific runtime assumptions:
Supabase Auth, RLS, Edge Functions, PostgREST conventions, `pgvector`,
`pg_cron`, `pg_net`, Vault secrets, SQL RPCs, service-role access, API keys,
CLI, and MCP.

## Dockerized setup option

Prefer the Docker path for Supabase self-hosted installs. It avoids installing
Node, Deno, Supabase CLI, GitHub CLI, jq, and OpenSSL on the operator's host.
It still reads the local `scoutpost-setup.json` manifest and runs the same
setup script. The easiest path is the `/setup` download:

```bash
bash scoutpost-docker-install.sh install
```

That wrapper pulls the prebuilt installer image when available and falls back to
building the same image locally from `scoutpost-os` when the registry image
cannot be pulled. The raw equivalent is:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \
  ghcr.io/buriedsignals/scoutpost-installer:latest install
```

Use the same image with `doctor` for read-only validation and `update` for
upstream maintenance PR preparation.
The same manifest should stay on disk and be mounted read-only; do not paste it
into chat.
Do not run interactive Firecrawl browser authentication in Docker. The manifest
API key is the deployment credential; optional local/provider CLIs are opt-in
with `COJOURNALIST_INSTALL_AGENT_TOOLING=true`.
For Supabase Cloud, use `supabase.access_token` in the manifest or
`SUPABASE_ACCESS_TOKEN` in the environment. Docker should not start browser
login for Supabase CLI authentication.

For manual provider manifests, the setup script writes
`scoutpost-provider-porting.md` and exits without running Supabase CLI commands.

## Upstream maintenance checks

When a newsroom asks for current OSS updates, use
`selfhost/upstream-maintenance-codex-prompt.txt`.

Before merging upstream:

- run `selfhost/selfhost-doctor.sh` from the checkout or parent deployment
  directory
- if the starting directory is not a Git worktree, look for a nested checkout
  such as `scoutpost-os/`
- set a repository-local Git identity if `user.name` or `user.email` is missing
- keep local `.env`, `frontend/.env.production.local`,
  `frontend/.env.production`, Supabase config, and local migrations out of the
  upstream merge commit unless the operator explicitly asks to commit them
- if `supabase/config.toml` uses a local signup hook, run
  `selfhost/adopt-signup-allowlist.sh --domain <domain> --admin <email>`
  before switching to the upstream allowlist hook
- do not run `supabase db push` while untracked or locally modified migration
  files exist; list them and ask the operator to review
- if `gh` or GitHub HTTPS credentials are missing, prepare the branch locally
  and give exact `git push`, `gh pr create`, and `gh secret set` commands

## Canonical location

Canonical URL: `https://www.scoutpost.ai/skills/scoutpost-setup.md`
