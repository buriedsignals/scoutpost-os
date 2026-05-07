# scout — Scoutpost CLI

Command-line tool for Scoutpost. Speaks the REST API using a `cj_...` API
key or legacy JWT bearer token.

## Install

### From source via Deno (recommended until public release assets exist)

Requires [Deno](https://deno.com) v2.x on `$PATH`.

```bash
deno install -A -g -n scout https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/cli/scout.ts
```

Verify install:

```bash
scout --version
```

### Build a local binary

If you want a self-contained executable instead of a Deno shim:

```bash
git clone https://github.com/buriedsignals/scoutpost-os.git
cd scoutpost-os/cli
deno task compile-mac-arm        # or compile-mac-x86 on Intel
sudo mv dist/scout-darwin-arm64 /usr/local/bin/scout
sudo chmod +x /usr/local/bin/scout
```

Verify:

```bash
scout --version
```

### Release binaries

Release binaries will appear at
<https://github.com/buriedsignals/scoutpost-os/releases> once the public
mirror starts publishing signed assets.

### Homebrew

Coming soon.

## Configure

Config lives at `~/.scoutpost/config.json`. Set an api_url and **either** an
`api_key` (preferred — generated in the app at /api → Agents → API → Create key)
or a legacy `auth_token` JWT.

```bash
# Hosted Scoutpost — recommended
scout config set api_url=https://www.scoutpost.ai/functions/v1
scout config set api_key=cj_xxxxxxxxxxxxxxxxxx
scout config set supabase_anon_key=<SUPABASE_ANON_KEY>

# Self-hosted Supabase Edge Functions
scout config set api_url=https://<project-ref>.supabase.co
scout config set api_key=cj_xxxxxxxxxxxxxxxxxx
scout config set supabase_anon_key=<SUPABASE_ANON_KEY>

# Legacy JWT path
scout config set auth_token=<JWT>          # paste from browser devtools if needed
scout config show
```

### Auth precedence

`apiFetch` picks the first credential found, in this order:

1. `api_key` — sent as `Authorization: Bearer cj_…`. When `supabase_anon_key` is
   configured, it is also sent as the `apikey:` header. Hosted and raw Supabase
   Edge Functions can reject bearer tokens before the function sees the request
   without that header.
2. `auth_token` — sent as `Authorization: Bearer <jwt>`. Use this only for
   legacy SaaS sessions.

If both are set, `api_key` wins. If neither is set, every command exits with a
setup hint.

No OAuth flow in the CLI — tokens are pasted manually.

## Quick start

```bash
# Projects
scout projects list
scout projects add --name "City Hall Watch" --visibility private

# Scouts
scout scouts list
scout scouts add --name "Council agenda" --type web --url https://example.gov \
  --topic "council, agenda"
scout scouts add --name "Housing minutes" --type civic \
  --root-domain example.gov \
  --tracked-urls https://example.gov/minutes,https://example.gov/agendas \
  --topic "housing, council" \
  --description "Monthly council-minutes monitor for housing policy." \
  --criteria "housing policy votes" --regularity monthly --time 08:00 --day 1
scout scouts add --name "Local climate beat" --type beat \
  --topic "climate, adaptation" \
  --criteria "local policy decisions with budget or timeline impacts" \
  --location-json '{"displayName":"Bergen, Norway","latitude":60.39,"longitude":5.32}' \
  --source-mode niche --priority-sources examplelocal.no
scout scouts run <id>

# Information units
scout units list --verified
scout units show <id>
scout units verify <id> --notes "Cross-checked with minutes" --by "Tom"
scout units search --query "zoning variance"

# Ingest a URL or stdin text
scout ingest url https://example.com/article --project <id>
echo "raw notes" | scout ingest text --title "Field notes"

# Search and manage units directly
scout units search --query "zoning variance" --mode hybrid --project <id>
scout units mark-used <id> --url https://example.com/story
scout units delete <id>
```

Topic tags are for organization and UI filtering. Use 1-3 short comma-separated
tags, not long instructions. Put human context in `--description` and filtering
or notification rules in `--criteria`. A scout must have either topic tags or a
location.

When you create a scheduled scout (`--cron` or `--regularity` + `--time`), the
server establishes the initial baseline before scheduling it. `scout scouts run`
compares against that baseline and will not create the first baseline itself.

Run `scout <command> --help` for subcommand-specific usage.

## Development

```bash
cd cli
deno task run projects list     # run from source
deno task test                   # run unit tests
deno task compile-all            # build all 4 release targets locally
```

## Releasing

See `cli/CLAUDE.md` for the release procedure and conventions.
