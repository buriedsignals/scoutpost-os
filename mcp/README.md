# scout-mcp — stdio bridge for the Scoutpost MCP server

`scout-mcp` is a small, signed binary that lets stdio-only MCP clients
(Claude Desktop, Cursor with local configs, custom local agents) talk to
the hosted Scoutpost MCP Edge Function over HTTPS. It does one thing:
read newline-delimited JSON-RPC 2.0 on stdin, POST each line to the
configured `/mcp-server` Edge Function with your `cj_…` API key, and
write the response back to stdout.

Agents that already support remote HTTP MCP servers (e.g. the web app
versions of Claude and ChatGPT that accept a URL + OAuth) don't need
this bridge — they connect directly.

## Install

### From source

Needs [Deno](https://deno.com) v2.x (`brew install deno`). Release binaries are
planned, but do not use `releases/latest/download` until public assets exist.

```bash
git clone https://github.com/buriedsignals/scoutpost-os.git
cd scoutpost-os/mcp
deno task compile-mac-arm        # or compile-mac-x86 on Intel
sudo mv dist/scout-mcp-darwin-arm64 /usr/local/bin/scout-mcp
sudo chmod +x /usr/local/bin/scout-mcp
# Gatekeeper blocks unsigned binaries — strip the quarantine attr:
sudo xattr -d com.apple.quarantine /usr/local/bin/scout-mcp
```

Verify: `scout-mcp --version`.

## Configure

Reuse the scout CLI's config file at `~/.scoutpost/config.json`. If
you don't have the CLI, write it yourself.

```bash
scout config set api_url=https://www.scoutpost.ai/functions/v1
scout config set api_key=cj_<your api key>

# Raw Supabase/self-hosted example:
scout config set api_url=https://<project-ref>.supabase.co/functions/v1
scout config set supabase_anon_key=<public anon key>
scout config set api_key=cj_<your api key>
```

Or override per-launch with env vars:

| Variable | Default | Required |
|---|---|---|
| `SCOUTPOST_API_URL` | `https://www.scoutpost.ai/functions/v1` | no |
| `SCOUTPOST_API_KEY` | — | yes |
| `SCOUTPOST_SUPABASE_ANON_KEY` | — | yes, when `api_url` is a Supabase host |

Generate a `cj_…` API key from the Connect Agent → API panel in the instance you are
connecting to. Hosted users use [scoutpost.ai](https://www.scoutpost.ai);
self-hosted users use their own deployed frontend.

## Wire it into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and
add:

```json
{
  "mcpServers": {
    "scoutpost": {
      "command": "scout-mcp"
    }
  }
}
```

If you don't want to rely on `~/.scoutpost/config.json` (e.g. multiple
Claude profiles), pass credentials via env instead:

```json
{
  "mcpServers": {
    "scoutpost": {
      "command": "scout-mcp",
      "env": {
        "SCOUTPOST_API_URL": "https://<project-ref>.supabase.co/functions/v1",
        "SCOUTPOST_API_KEY": "cj_...",
        "SCOUTPOST_SUPABASE_ANON_KEY": "..."
      }
    }
  }
}
```

Restart Claude Desktop. It should advertise tools like `list_scouts`,
`verify_unit`, `search_units`, `list_snapshots`, and `get_snapshot_url` in the
tool picker.

## Wire it into Cursor / other local MCP clients

Most clients accept the same command/env shape. Example for Cursor:

```json
{
  "mcp.servers": {
    "scoutpost": {
      "type": "stdio",
      "command": "scout-mcp"
    }
  }
}
```

## Troubleshooting

- **`config error — Missing api_key`** — run `scout config set api_key=cj_...`
  or set `SCOUTPOST_API_KEY` in the client's `env` block.
- **`Supabase api_url requires supabase_anon_key`** — set the anon key.
  Find it in your Supabase project → Settings → API → `anon/public`.
- **Client shows zero tools** — double-check the bearer reaches the remote.
  Run `echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | scout-mcp` —
  you should see a JSON line with `serverInfo.name = "scoutpost"`.
- **`command not found: scout-mcp`** — install didn't land. Re-run the
  `curl` one-liner above.
- **`401` or `403` in the client error log** — API key was rotated or
  revoked. Mint a fresh one in the app and update the config.

## Build from source

Requires [Deno](https://deno.com) v2.x.

```bash
cd mcp
deno task test             # unit tests
deno task run              # run bridge against stdin
deno task compile-all      # build mac arm/x86 + linux arm/x86 binaries
```

## Release

Push a `mcp-v*` tag on the private monorepo — the
[`mcp-release.yml`](../.github/workflows/mcp-release.yml) workflow
compiles for all four platforms, codesigns + notarizes macOS binaries
with the Apple Developer cert, and publishes the release on
[`buriedsignals/scoutpost-os`](https://github.com/buriedsignals/scoutpost-os/releases)
so anyone can `curl` the assets without GitHub auth.

```bash
git tag mcp-v0.1.0 -m "scout-mcp 0.1.0 — initial release"
git push origin mcp-v0.1.0
```
