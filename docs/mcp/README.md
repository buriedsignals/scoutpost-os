# MCP — Scoutpost remote MCP server

Public, OAuth-protected MCP server at `https://scoutpost.ai/mcp`. MCP clients (Claude Cowork, Claude Desktop, claude.ai, Codex Desktop, Cursor, Windsurf, Antigravity, Goose, Hermes, Langdock) connect via Streamable HTTP, authenticate via OAuth 2.1 + RFC 7591 Dynamic Client Registration + PKCE, and call JSON-RPC tools that fan out to the rest of the platform (units search, scout management, project ingest).

**Spec versions:**
- MCP Authorization spec `2025-06-18` (Streamable HTTP)
- OAuth 2.1 / RFC 6749
- RFC 7591 (Dynamic Client Registration)
- RFC 7636 (PKCE S256)
- RFC 8414 §3 (Authorization Server Metadata)
- RFC 9728 §3.1 (Protected Resource Metadata, path-suffix construction)

## In this directory

| File | Purpose |
|------|---------|
| [`architecture.md`](architecture.md) | What's in front of what — FastAPI proxy, Supabase EF, MuckRock broker, request flow |
| [`oauth.md`](oauth.md) | The full DCR + PKCE + magiclink + server-side-mint chain end-to-end |
| [`endpoints.md`](endpoints.md) | Every public endpoint with `curl` probes and expected responses |
| [`clients.md`](clients.md) | Per-client setup recipes (Cowork, Desktop, Codex Desktop, codex-cli, Cursor, Windsurf, Antigravity, Goose, Hermes, Langdock) |
| [`self-hosting.md`](self-hosting.md) | Required env vars, redirect-URL allowlists, domain pinning, OSS adopter checklist |
| [`debugging.md`](debugging.md) | Configure-vs-Connect, request_id correlation, common failure modes and what each one means |

## Related docs (kept where they live)

- [`docs/supabase/mcp-oauth.md`](../supabase/mcp-oauth.md) — DB tables (`mcp_oauth_clients`, `mcp_oauth_codes`) + cleanup cron
- [`docs/supabase/edge-functions.md`](../supabase/edge-functions.md) — Edge Function inventory
- [`mcp/CLAUDE.md`](../../mcp/CLAUDE.md) — `scout-mcp` stdio bridge (legacy local-stdio path; superseded by the remote server for hosted clients)
- [`MCP_SPECFILE.md`](../../MCP_SPECFILE.md) — frozen session debug log from the 2026-05-05 OAuth bring-up; untracked, kept for the next person

## 30-second overview

```
MCP client                    scoutpost.ai/mcp                   Supabase EF
─────────                     ──────────────────                    ──────────────
HEAD /                        →  401 + WWW-Authenticate            ─►  mcp-server
GET /.well-known/oauth-…/mcp  →  200 JSON metadata                     mcp-server
POST /register                →  201 client_id (DCR, PKCE-only)        mcp-server
GET /authorize?…              →  302 → MuckRock OIDC                   mcp-server → mcp-auth
   ↳ MuckRock sign-in
   ↳ Supabase magiclink
   ↳ mcp-auth resolves magiclink server-side, mints code, 302s to claude.ai
POST /token                   →  200 access_token (Supabase JWT)       mcp-server
POST / (JSON-RPC)             →  200 tool result                       mcp-server → units / scouts / projects EFs
```

The whole point: the user pastes the URL, clicks Connect, and OAuth runs. No client_id/secret prompt. No manual config.

## Surfaces verified working

- **Claude Cowork** (claude.ai web + desktop "Cowork" surface) — primary target. RFC 9728 path-suffix metadata required.
- **Claude Desktop** — same as Cowork; shares Anthropic's cloud-brokered OAuth flow.
- **claude.ai** chat with custom connector — same.
- **Claude Code** (`claude mcp add --transport http`) — opens local browser for OAuth (different surface, same server).
- **Codex Desktop** — Streamable HTTP tab + native OAuth handshake.
- **codex-cli** — `codex mcp login scoutpost` after a `[mcp_servers.scoutpost]` block in `~/.codex/config.toml`.
- **Cursor / Windsurf / Antigravity / Goose / Hermes / Langdock** — config-file and custom-integration paths described in [`clients.md`](clients.md).

ChatGPT is **not** supported as a self-serve target — OpenAI gates custom MCP to Business/Enterprise/Edu plans, useless for individual journalists.
