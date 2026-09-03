# Other MCP clients (not in the Connect Agent menu)

These clients are not listed in the app's Connect Agent modal or in OSINT
Navigator's; the menu on both sites is the Engine `@buriedsignals/agent-connect`
catalog and the two stay identical by construction. The notes below are kept
for people who already run one of these clients. The hosted server URL is
`https://scoutpost.ai/mcp`; never paste a `client_id`, `client_secret`, API key,
or bearer token into configuration or chat.

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

## Local stdio bridge (`scout-mcp`)

For clients that don't speak Streamable HTTP (legacy Claude Desktop configs without the cloud broker, some local agent frameworks). The bridge installs from the public OSS mirror's release page; the binary connects via stdio and forwards JSON-RPC verbatim to the hosted server using a `cj_…` API key for auth.

See [`mcp/CLAUDE.md`](../../mcp/CLAUDE.md) for release procedure and binary install. Prefer each client's documented hosted path; for Antigravity, use Product CLI by default while the Windows IDE remote-MCP boundary remains unresolved. The bridge is a transport shim, not a feature.
