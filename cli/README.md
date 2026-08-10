# scout — Scoutpost CLI

Command-line tool for Scoutpost. Speaks the REST API using a `cj_...` API key or
legacy JWT bearer token.

## Install

### npm package (recommended)

The package downloads the signed native binary for supported macOS, Linux, and
Windows x86_64 platforms. Windows installs an Authenticode-signed `.exe`:

```bash
npm install --global scoutpost-cli
scout --version
```

### From source via Deno

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
deno task compile-mac-arm        # or compile-mac-x86 / compile-linux-x86 / compile-windows-x86
sudo mv dist/scout-darwin-arm64 /usr/local/bin/scout
sudo chmod +x /usr/local/bin/scout
```

Verify:

```bash
scout --version
```

### Release binaries

Release binaries will appear at
<https://github.com/buriedsignals/scoutpost-os/releases> once the public mirror
starts publishing signed assets.

### Homebrew

Coming soon.

## Sign in

Browser login is the recommended interactive setup:

```bash
scout auth login --site https://scoutpost.ai --label "My terminal"
scout auth status
```

The CLI opens a Scoutpost approval page or prints its URL for a remote/headless
shell. Approval creates a dedicated API key, but the key is never displayed.
It is verified before storage. Windows keeps `api_key` and legacy `auth_token`
in Windows Credential Manager for the current user; only non-secret settings
are written under `%APPDATA%\\Scoutpost\\config.json`. macOS and Linux retain
the owner-only `~/.scoutpost/config.json` compatibility path.

Re-running login against the same site is a no-op while the credential remains
valid. Use `--switch` to explicitly replace a configuration for another site, or
`--no-browser` to suppress browser launch.

```bash
scout auth logout
```

Logout revokes the current API key before removing it locally. If remote
revocation fails, the CLI says so and gives a key-management recovery link.

## Manual configuration and recovery

Public configuration lives at `~/.scoutpost/config.json` on macOS/Linux and
`%APPDATA%\\Scoutpost\\config.json` on Windows. Set an api_url and **either** an
`api_key` (created under Connect Agent → API keys & REST) or a legacy
`auth_token` JWT. On Windows, those two credential fields are stored in
Credential Manager rather than the JSON file. This path remains for scripts,
CI, and recovery:

```bash
# Hosted Scoutpost — recommended
scout config set api_url=https://scoutpost.ai/functions/v1
printf '%s\\n' \"$SCOUTPOST_API_KEY\" | scout config set api_key --stdin
printf '%s\\n' \"$SUPABASE_ANON_KEY\" | scout config set supabase_anon_key --stdin

# Self-hosted Supabase Edge Functions
scout config set api_url=https://<project-ref>.supabase.co
printf '%s\\n' \"$SCOUTPOST_API_KEY\" | scout config set api_key --stdin
printf '%s\\n' \"$SUPABASE_ANON_KEY\" | scout config set supabase_anon_key --stdin

# Legacy JWT path
printf '%s\\n' \"$SCOUTPOST_AUTH_TOKEN\" | scout config set auth_token --stdin
scout config show
```

Load those environment variables from a password manager or a hidden prompt;
do not put credential values directly in command arguments or shell history.

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

See [browser authentication](../docs/features/cli-browser-auth.md) for the
device flow, self-host discovery, key limits, and security contract.

## Quick start

```bash
# Projects
scout projects list
scout projects add --name "City Hall Watch" --visibility private

# Scouts
scout scouts list
scout scouts add --name "Council agenda" --type web --url https://example.gov \
  --topic "council, agenda" --archive-enabled true   # capture evidence snapshots (Pro/Team)
scout scouts add --name "Housing minutes" --type civic \
  --root-domain example.gov \
  --tracked-urls https://example.gov/minutes,https://example.gov/agendas \
  --topic "housing, council" \
  --description "Monthly council-minutes monitor for housing policy." \
  --criteria "housing policy votes" --regularity monthly --time 08:00 --day 1
scout civic discover --root-domain example.gov
scout civic preview --tracked-urls https://example.gov/minutes --criteria "housing policy votes"
scout civic items --kind promise --status in_progress
scout civic runs
scout scouts add --name "Local climate beat" --type beat \
  --topic "climate, adaptation" \
  --criteria "local policy decisions with budget or timeline impacts" \
  --location-json '{"displayName":"Bergen, Norway","latitude":60.39,"longitude":5.32}' \
  --source-mode niche --priority-sources examplelocal.no

# Fleet Scouts: test live data first, then name and schedule with that baseline
scout scouts test-transport --mode vessel --watch-ids 636019825 \
  --center-lat 26.55 --center-lon 56.25 --radius-km 40
scout scouts add --name "Hormuz vessel watch" --type transport --mode vessel \
  --watch-ids 636019825 --center-lat 26.55 --center-lon 56.25 --radius-km 40 \
  --baseline-ids 636019825 --regularity 6h
# If the test returns no baseline IDs, preserve that result with --baseline-ids ''.
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

# Page snapshots (evidence archive — Page Scouts created with --archive-enabled)
scout snapshots list --scout <scout_id>
scout snapshots download <snapshot_id> --artifact mhtml -o page.mhtml
scout snapshots url <snapshot_id> --artifact screenshot   # print a signed link instead
# Turn archiving on/off on an existing scout:
scout scouts update <scout_id> --archive-enabled true --wayback-enabled false
```

The UI calls topic tags **Project labels**. They are for organization and UI
filtering, and are distinct from investigation Projects / `project_id`. Use 1-3
short comma-separated tags, not long instructions. Put human context in
`--description` and filtering or notification rules in `--criteria`. A scout
must have either topic tags or a location.

For a Fleet Scout, run `test-transport` and pass its `baseline_ids` through
`--baseline-ids` when creating the schedule. Other scheduled scout types
establish their initial baseline during creation. `scout scouts run` compares
against that baseline and will not create the first baseline itself.

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

The Windows `cli-v*` release leg signs with Azure Artifact Signing through
short-lived GitHub OIDC. Before creating a release tag, configure repository
secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`, plus
repository variables `AZURE_ARTIFACT_SIGNING_ENDPOINT`,
`AZURE_ARTIFACT_SIGNING_ACCOUNT`, `AZURE_ARTIFACT_SIGNING_PROFILE`, and
`AZURE_ARTIFACT_SIGNING_PUBLISHER_SUBJECT`. The publisher value must be the
exact `SignerCertificate.Subject` issued by the approved public certificate
profile. The workflow refuses to publish a missing, invalid, untimestamped, or
differently signed Windows executable. Do not store an Azure client secret or
exportable signing key in GitHub.
