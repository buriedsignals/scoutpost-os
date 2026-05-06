# MCP client setup

Per-client recipes. The hosted server URL is always `https://www.cojournalist.ai/mcp`. Every recipe below results in OAuth-on-first-use — no `client_id`/`client_secret` paste, ever.

The Agents modal in the app (`/api` → Agents) generates the same recipes dynamically per client. These docs are the canonical reference; the modal copy lives in `frontend/src/lib/utils/agent-recipes.ts`.

## Claude Cowork (claude.ai web, Claude Desktop, Cowork)

Cowork is Anthropic's umbrella surface for the cloud-brokered custom-connector flow. The same steps work in Claude Desktop, claude.ai web, and the Cowork desktop app.

1. Open Settings → **Connectors** → **+ Add custom connector**.
2. Paste `https://www.cojournalist.ai/mcp` as the Remote MCP Server URL → **Add**. Do not open Advanced Settings.
3. Click **Connect** on the new card. (If the card defaults to **Configure**: click **⋯** → **Disconnect**, then **⋯** → **Remove**, quit and reopen the app, then re-add. Anthropic-side state cached against a previous failed attempt is the most common cause of Configure-default — see [`debugging.md`](debugging.md).)
4. The MuckRock sign-in opens. Approve. The card flips to connected and tools list populates.

A separate desktop browser does NOT pop up — Anthropic brokers OAuth from their cloud. Claude Code is the only Anthropic surface that opens a local browser (different recipe below).

## Claude Code (CLI)

```bash
claude mcp add cojournalist --transport http https://www.cojournalist.ai/mcp
claude mcp login cojournalist   # opens local browser for OAuth
```

After OAuth, `claude mcp list` shows cojournalist with its tool count. Tokens land in Claude Code's keychain entry.

## Codex Desktop (OpenAI)

Codex Desktop speaks Streamable HTTP natively with OAuth.

1. Open Codex Desktop → Settings → MCP Servers → **Connect to a custom MCP**.
2. Switch to the **Streamable HTTP** tab. The dialog defaults to STDIO — that's the wrong tab for remote servers.
3. Name: `cojournalist`. URL: `https://www.cojournalist.ai/mcp`. Leave Authorization blank — Codex runs the OAuth handshake on first use. Save.
4. Approve the cojournalist sign-in in the browser tab Codex opens. The connector flips to connected and tools appear in the Sources/Tools panel.

## codex-cli (terminal)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.cojournalist]
url = "https://www.cojournalist.ai/mcp"
```

Then:

```bash
codex mcp login cojournalist
```

Older codex-cli builds may need `experimental_use_rmcp_client = true` in the same file. Reference: <https://developers.openai.com/codex/mcp>.

## Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cojournalist": {
      "url": "https://www.cojournalist.ai/mcp"
    }
  }
}
```

Reload Cursor; OAuth runs on first tool use. Reference: <https://cursor.com/docs/mcp>.

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "cojournalist": {
      "serverUrl": "https://www.cojournalist.ai/mcp"
    }
  }
}
```

Reference: <https://docs.windsurf.com/windsurf/cascade/mcp>.

## Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "cojournalist": {
      "httpUrl": "https://www.cojournalist.ai/mcp"
    }
  }
}
```

Reference: <https://geminicli.com/docs/tools/mcp-server/>.

## Goose

Run `goose configure` and choose **Add Extension** → **Streamable HTTP**. Name: `cojournalist`. URL: `https://www.cojournalist.ai/mcp`. Authorize in the browser window that opens. Reference: <https://block.github.io/goose/docs/mcp/>.

## Hermes (Mac mini ambient agent)

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  cojournalist:
    url: https://www.cojournalist.ai/mcp
    transport: streamable_http
```

Reload Hermes. Reference: <https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>.

## OpenClaw

Native MCP client support is in active beta. Tracked upstream at openclaw/openclaw#29053. Once it lands, paste `https://www.cojournalist.ai/mcp` into the MCP extensions panel.

## Generic (any MCP-speaking client)

Paste `https://www.cojournalist.ai/mcp` and follow the client's OAuth prompt. Spec reference: <https://modelcontextprotocol.io>.

## What about ChatGPT?

Not supported as a self-serve target. OpenAI gates "developer mode" custom MCP to Business/Enterprise/Edu plans, with an admin opt-in step per workspace. That makes it useless for individual journalists; the Agents modal does not include it. Reference: <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta>.

## Local stdio bridge (`cojo-mcp`)

For clients that don't speak Streamable HTTP (legacy Claude Desktop configs without the cloud broker, some local agent frameworks). The bridge installs from the public OSS mirror's release page; the binary connects via stdio and forwards JSON-RPC verbatim to the hosted server using a `cj_…` API key for auth.

See [`mcp/CLAUDE.md`](../../mcp/CLAUDE.md) for release procedure and binary install. Hosted clients listed above should always prefer the remote URL — the bridge is a transport shim, not a feature.
