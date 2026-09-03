# MCP client setup

The hosted server URL is always `https://scoutpost.ai/mcp`. Remote recipes use
OAuth on first connection; follow the client-specific caveats below. Never
paste a `client_id`, `client_secret`, API key, or bearer token into configuration
or chat.

The agent-connection modal in the app (`/api` → Connect Agent) generates the same
recipes dynamically per client from Engine `@buriedsignals/agent-connect`. The
menu lists exactly these clients, in this order, and OSINT Navigator lists the
same ones: Claude Code, Claude Desktop, ChatGPT Desktop, Codex CLI, Cursor,
Antigravity, Gemini CLI, Goose, OpenCode, and any other MCP client. Clients
outside that list live in [`other-clients.md`](other-clients.md).

Two audiences. Desktop-app clients (Claude Desktop, ChatGPT Desktop, Cursor,
Goose, Antigravity) get click-through steps or a one-click install link and are
never asked to open a terminal as the recommended step. Terminal clients
(Claude Code, Codex CLI, Gemini CLI, OpenCode) get the Scout CLI first and the
client's own `mcp add` command as the alternative. Every card reads Install,
then Onboard your agent, then a check line.

## Claude Desktop (claude.ai web, Claude Desktop, Cowork)

The same custom-connector flow works in Claude Desktop (Chat, Cowork, and Code
tabs), claude.ai web, and Cowork. A connector added here also loads in Claude
Code when you sign in with the same account.

1. Open Settings → **Connectors** → **+ Add custom connector**.
2. Paste `https://scoutpost.ai/mcp` as the Remote MCP Server URL → **Add**. Do not open Advanced Settings.
3. Click **Connect** on the new card. (If the card defaults to **Configure**: click **⋯** → **Disconnect**, then **⋯** → **Remove**, quit and reopen the app, then re-add. Anthropic-side state cached against a previous failed attempt is the most common cause of Configure-default — see [`debugging.md`](debugging.md).)
4. The MuckRock sign-in opens. Approve. The card flips to connected and tools list populates.

A separate desktop browser does NOT pop up — Anthropic brokers OAuth from their cloud. Free plans get one custom connector; Pro, Max, Team, and Enterprise are unlimited.

## Claude Code (terminal)

Scout CLI first (the modal's recommended path), or the MCP server:

```bash
claude mcp add --scope user --transport http scoutpost https://scoutpost.ai/mcp
```

`--scope user` makes the server available in every folder. Start `claude`, run
`/mcp`, select `scoutpost`, and choose **Authenticate** if it says Needs
authentication. After OAuth, `claude mcp list` shows scoutpost with its tool count.

## ChatGPT Desktop

The ChatGPT desktop app **is** the Codex app: bundle id `com.openai.codex`
(the standalone Codex app merged into it on 2026-07-09), and it shares
`~/.codex/config.toml` with Codex CLI. No terminal is needed.

1. Open ChatGPT Desktop → Settings → **MCP servers** → **Add server**.
2. Choose **Streamable HTTP** as the transport. Name: `scoutpost`. URL: `https://scoutpost.ai/mcp`. Leave the authorization fields empty; the app signs you in on first use.
3. Save, then choose **Restart** when the app asks.
4. Approve the Scoutpost sign-in when it opens, then ask ChatGPT to use `scoutpost`. Type `/mcp` in the composer to confirm it is connected.

Reference: <https://learn.chatgpt.com/docs/extend/mcp>.

## Codex CLI (terminal)

```bash
codex mcp add scoutpost --url https://scoutpost.ai/mcp
codex mcp login scoutpost
```

Skip `add` if `codex mcp list` already shows scoutpost. Connecting here also
connects the ChatGPT desktop app (shared `~/.codex`). Reference:
<https://learn.chatgpt.com/docs/extend/mcp?surface=cli>.

## Cursor

One click: the modal's **Add to Cursor** link opens
`cursor://anysphere.cursor-deeplink/mcp/install?name=scoutpost&config=<base64 of {"url":"https://scoutpost.ai/mcp"}>`
and Cursor asks you to confirm the server.

By hand: Cursor Settings → **Tools & MCP** → **New MCP server**, then add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "scoutpost": {
      "url": "https://scoutpost.ai/mcp"
    }
  }
}
```

When `scoutpost` shows **Needs login**, click it and approve the sign-in in your
browser. Cursor Agent in the terminal reads the same `mcp.json`: run
`agent mcp login scoutpost` there. Reference: <https://cursor.com/docs/mcp>.

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

## Gemini CLI (terminal)

Scout CLI first, or the MCP server:

```bash
gemini mcp add --transport http --scope user scoutpost https://scoutpost.ai/mcp
```

Start `gemini` and run `/mcp`; Gemini CLI discovers the OAuth sign-in on its own
and opens your browser on first use. Reference:
<https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md>.

## Goose

One click: the modal's **Add to Goose** link opens
`goose://extension?type=streamable_http&url=https%3A%2F%2Fscoutpost.ai%2Fmcp&id=scoutpost&name=Scoutpost&description=Scoutpost%20MCP%20server`;
approve the extension when Goose asks, then approve the sign-in in the browser.

By hand in Goose Desktop: open the sidebar → **Extensions** → **Add custom
extension**. Type: **Streamable HTTP**. Endpoint URL: `https://scoutpost.ai/mcp`.
ID: `scoutpost`. Name: `Scoutpost`. Leave the timeout at its default and click
**Add**.

Goose CLI: run `goose configure` → **Add Extension** → **Remote Extension
(Streamable HTTP)** and answer the prompts with the same name and URL. Desktop
and CLI share `~/.config/goose/config.yaml`. Reference:
<https://goose-docs.ai/docs/getting-started/using-extensions>.

## OpenCode (terminal)

Scout CLI first, or the MCP server:

```bash
opencode mcp add scoutpost --url https://scoutpost.ai/mcp
opencode mcp auth scoutpost
```

Approve the browser sign-in; `opencode mcp list` shows scoutpost as connected.
Reference: <https://opencode.ai/docs/mcp-servers/>.

## Generic (any MCP-speaking client)

Paste `https://scoutpost.ai/mcp` and follow the client's OAuth prompt. Spec reference: <https://modelcontextprotocol.io>.
