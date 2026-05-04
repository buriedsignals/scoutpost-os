# coJournalist setup skill

Use this when the user wants to install, self-host, configure, or validate
coJournalist. For day-to-day newsroom use, prefer the product skill at
`https://www.cojournalist.ai/skills/cojournalist.md`.

## Public surfaces

For hosted SaaS, the public app is `https://www.cojournalist.ai`.

For self-hosted deployments, use the newsroom's own deployed app URL and the
Supabase/API/MCP targets generated during setup. Do not point newsroom agents at
the hosted cojournalist.ai Supabase project.

## Hosted agent setup

1. Open coJournalist and create a `cj_...` API key from the Agents API panel.
2. Configure the agent to use either MCP or the CLI.
3. Verify with a read-only operation first: list scouts or list units.
4. Do not run scouts or create scheduled monitors until the user confirms credit
   spend.

## CLI setup

Use Deno 2.x to install directly from the public mirror:

Hosted example:

```bash
deno install -A -g -n cojo https://raw.githubusercontent.com/buriedsignals/cojournalist-os/master/cli/cojo.ts
cojo config set api_url=https://www.cojournalist.ai/functions/v1
cojo config set api_key=<cj_... API key>
cojo scouts list
```

Self-hosted example:

```bash
cojo config set api_url=https://<project-ref>.supabase.co/functions/v1
cojo config set supabase_anon_key=<SUPABASE_ANON_KEY>
cojo config set api_key=<cj_... API key>
cojo scouts list
```

## MCP setup

Hosted remote MCP endpoint:

```text
https://www.cojournalist.ai/mcp
```

The MCP server uses OAuth discovery at:

```text
https://www.cojournalist.ai/mcp/.well-known/oauth-authorization-server
https://www.cojournalist.ai/mcp/.well-known/oauth-protected-resource
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

Before treating a self-hosted install as ready:

- apply all Supabase migrations
- deploy Edge Functions
- create the required Supabase secrets
- confirm MapTiler is configured; location scouting depends on it
- confirm auth mode is intentionally set for hosted or local/demo use
- open `/setup` and verify the instructions match the target deployment
- verify REST list endpoints return `{ "items": [...], "pagination": ... }`
- verify MCP `initialize` and `tools/list` against the self-hosted MCP URL
- verify a read-only CLI call with a `cj_...` API key

## Dockerized setup option

If the operator wants a containerized installer, use the Docker path instead of
installing the toolchain on the host. It still reads the local
`cojournalist-setup.json` manifest and runs the same setup script:

```bash
docker build -f deploy/installer/Dockerfile -t cojournalist-installer .
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$PWD/cojournalist-setup.json:/config/cojournalist-setup.json:ro" \
  cojournalist-installer install
```

Use `cojournalist-installer doctor` for read-only validation and
`cojournalist-installer update` for upstream maintenance PR preparation.

## Upstream maintenance checks

When a newsroom asks for current OSS updates, use
`automation/upstream-maintenance-codex-prompt.txt`.

Before merging upstream:

- run `automation/selfhost-doctor.sh` from the checkout or parent deployment
  directory
- if the starting directory is not a Git worktree, look for a nested checkout
  such as `cojournalist-os/`
- set a repository-local Git identity if `user.name` or `user.email` is missing
- keep local `.env`, `frontend/.env.production`, Supabase config, and local
  migrations out of the upstream merge commit unless the operator explicitly
  asks to commit them
- if `supabase/config.toml` uses a local signup hook, run
  `automation/adopt-signup-allowlist.sh --domain <domain> --admin <email>`
  before switching to the upstream allowlist hook
- do not run `supabase db push` while untracked or locally modified migration
  files exist; list them and ask the operator to review
- if `gh` or GitHub HTTPS credentials are missing, prepare the branch locally
  and give exact `git push`, `gh pr create`, and `gh secret set` commands

## Canonical location

Canonical URL: `https://www.cojournalist.ai/skills/cojournalist-setup.md`
