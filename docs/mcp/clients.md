# MCP client setup

The hosted server URL is always `https://scoutpost.ai/mcp`. Remote recipes use
OAuth on first connection; follow the client-specific caveats below. Never
paste a `client_id`, `client_secret`, API key, or bearer token into configuration
or chat.

The agent-connection modal in the app (`/api` → Connect Agent) generates the same recipes dynamically per client. Catalog-backed recipes for Claude Code, Claude Desktop, ChatGPT Desktop, Codex, Antigravity, Gemini CLI, Goose, OpenCode, LM Studio, and generic MCP come from Engine `@buriedsignals/agent-connect`. These docs own the detailed walkthroughs and troubleshooting.

## Claude Cowork (claude.ai web, Claude Desktop, Cowork)

Cowork is Anthropic's umbrella surface for the cloud-brokered custom-connector flow. The same steps work in Claude Desktop, claude.ai web, and the Cowork desktop app.

1. Open Settings → **Connectors** → **+ Add custom connector**.
2. Paste `https://scoutpost.ai/mcp` as the Remote MCP Server URL → **Add**. Do not open Advanced Settings.
3. Click **Connect** on the new card. (If the card defaults to **Configure**: click **⋯** → **Disconnect**, then **⋯** → **Remove**, quit and reopen the app, then re-add. Anthropic-side state cached against a previous failed attempt is the most common cause of Configure-default — see [`debugging.md`](debugging.md).)
4. The MuckRock sign-in opens. Approve. The card flips to connected and tools list populates.

A separate desktop browser does NOT pop up — Anthropic brokers OAuth from their cloud. Claude Code is the only Anthropic surface that opens a local browser (different recipe below).

## Claude Code (CLI)

```bash
claude mcp add --transport http scoutpost https://scoutpost.ai/mcp
```

If Claude Code returns 401, open `/mcp` and complete OAuth. After OAuth, `claude mcp list` shows scoutpost with its tool count.

## ChatGPT Desktop (Codex)

The ChatGPT desktop app **is** the Codex app: bundle id `com.openai.codex`, it ships the `codex` binary at `Contents/Resources/codex`, and it shares `~/.codex` with the standalone CLI. Use the Codex Desktop MCP settings flow below; the terminal commands in the [Codex CLI](#codex-cli-terminal) section reach the same configuration.

## Codex Desktop (OpenAI)

Codex Desktop speaks Streamable HTTP natively with OAuth.

1. Open Codex Desktop → Settings → MCP Servers → **Connect to a custom MCP**.
2. Switch to the **Streamable HTTP** tab. The dialog defaults to STDIO — that's the wrong tab for remote servers.
3. Name: `scoutpost`. URL: `https://scoutpost.ai/mcp`. Leave Authorization blank — Codex runs the OAuth handshake on first use. Save.
4. Approve the Scoutpost sign-in in the browser tab Codex opens. The connector flips to connected and tools appear in the Sources/Tools panel.

## Codex CLI (terminal)

```bash
codex mcp add scoutpost --url https://scoutpost.ai/mcp
codex mcp login scoutpost
```

Skip `add` if `codex mcp list` already shows scoutpost. Reference: <https://developers.openai.com/codex/mcp>.

## Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "scoutpost": {
      "url": "https://scoutpost.ai/mcp"
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
    "scoutpost": {
      "serverUrl": "https://scoutpost.ai/mcp"
    }
  }
}
```

Reference: <https://docs.windsurf.com/windsurf/cascade/mcp>.

## Antigravity CLI and Antigravity 2.0/IDE

These are separate client surfaces and their QA results are not interchangeable.
Use the Scoutpost **Product CLI** as the default path on macOS and Windows:

```text
npm install --global scoutpost-cli
scout auth login --site https://scoutpost.ai --label "Antigravity"
```

Approve the browser request, then use `scout scouts list` or
`scout scouts list --active` from Antigravity. This path does not put a
credential in Antigravity configuration.

Remote MCP is an explicit alternative. Open **Settings → Customizations → MCP
Servers → Add MCP server**, or add Scoutpost to the shared
`~/.gemini/config/mcp_config.json` file:

```json
{
  "mcpServers": {
    "scoutpost": {
      "serverUrl": "https://scoutpost.ai/mcp"
    }
  }
}
```

Then complete Antigravity's official DCR flow:

1. Open **Manage MCP Servers** and click **Authenticate** for Scoutpost.
2. Complete Scoutpost authorization in the browser.
3. Copy the authorization code displayed by the browser.
4. Paste that code into Antigravity's authorization-code field and click
   **Submit**.
5. Reconnect or refresh the Scoutpost server and confirm its tools appear.

Do not substitute a pasted bearer, API key, or client secret if this flow fails.
Remote MCP through the shared configuration has passed in Antigravity CLI on
macOS. A separate Windows Antigravity 2.0/IDE run completed the visible
authorization flow but sent `initialize` without a bearer, so that combination
remains an unresolved client/server interoperability issue. Capture Antigravity
client MCP/OAuth logs and correlate them with Scoutpost `mcp-server` and
`mcp-auth` traces as described in [`debugging.md`](debugging.md); use Product
CLI in the meantime.

Reference: <https://antigravity.google/docs/mcp/>.

## Goose

Run `goose configure` and choose **Add Extension** → **Streamable HTTP**. Name: `scoutpost`. URL: `https://scoutpost.ai/mcp`. Authorize in the browser window that opens. Reference: <https://block.github.io/goose/docs/mcp/>.

## Hermes (Mac mini ambient agent)

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  scoutpost:
    url: https://scoutpost.ai/mcp
    transport: streamable_http
```

Reload Hermes. Reference: <https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>.

## Langdock

Langdock supports custom MCP integrations with OAuth and Dynamic Client Registration. Use that path for Scoutpost; do not use API-key auth or advanced/manual OAuth unless Langdock's DCR path is unavailable.

1. Open Langdock's integrations area for adding an MCP server.
2. Create a custom MCP integration or server connection.
3. Choose OAuth authentication with Dynamic Client Registration.
4. Paste `https://scoutpost.ai/mcp` as the MCP server URL.
5. Save/connect the integration and approve the Scoutpost OAuth sign-in.
6. Enable the connected Scoutpost integration for the assistant or workspace that should use it.

Reference: <https://docs.langdock.com/resources/integrations/mcp>.

## OpenClaw

Native MCP client support is in active beta. Tracked upstream at openclaw/openclaw#29053. Once it lands, paste `https://scoutpost.ai/mcp` into the MCP extensions panel.

## Generic (any MCP-speaking client)

Paste `https://scoutpost.ai/mcp` and follow the client's OAuth prompt. Spec reference: <https://modelcontextprotocol.io>.

## Local stdio bridge (`scout-mcp`)

For clients that don't speak Streamable HTTP (legacy Claude Desktop configs without the cloud broker, some local agent frameworks). The bridge installs from the public OSS mirror's release page; the binary connects via stdio and forwards JSON-RPC verbatim to the hosted server using a `cj_…` API key for auth.

See [`mcp/CLAUDE.md`](../../mcp/CLAUDE.md) for release procedure and binary install. Prefer each client's documented hosted path; for Antigravity, use Product CLI by default while the Windows IDE remote-MCP boundary remains unresolved. The bridge is a transport shim, not a feature.
