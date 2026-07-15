# MCP architecture

Two layers in front of the database, plus a separate broker for the MuckRock OIDC handshake.

## Request flow

```
User browser / Anthropic backend
        │
        ▼
Cloudflare ──► Render (FastAPI on uvicorn, https://scoutpost.ai)
                        │
                        ├── /.well-known/oauth-authorization-server               ─► self-served by FastAPI
                        ├── /.well-known/oauth-protected-resource                 ─► self-served by FastAPI
                        ├── /.well-known/oauth-{authorization-server,
                        │                       protected-resource}/mcp           ─► self-served by FastAPI (RFC 9728 §3.1 path-suffix form)
                        ├── /mcp/.well-known/...                                  ─► self-served by FastAPI (legacy form, kept for clients that didn't update)
                        └── /mcp* (everything else)                               ─► proxied to Supabase EF
                                                                                       │
                                                                                       ▼
                                                                supabase.co/functions/v1/mcp-server
                                                                       │
                                                                       └── /authorize 302 → /functions/v1/mcp-auth/login
                                                                                          │
                                                                                          ├── MuckRock OIDC sign-in
                                                                                          └── Supabase magiclink (resolved server-side)
                                                                                          ▼
                                                                                       302 → claude.ai/api/mcp/auth_callback?code=…&state=…
```

## Why two layers

**Why FastAPI in front, instead of pointing the URL at Supabase directly?**

1. **The public URL stays canonical.** Issuer in OAuth metadata, `resource` in protected-resource metadata, `WWW-Authenticate: Bearer resource_metadata=…` all need to advertise the same host MCP clients pasted. If we sent clients straight to `<project-ref>.supabase.co` they would either reject the issuer mismatch or hard-bind to the Supabase host (worse, since we lose the rebrand path for self-hosters).
2. **RFC 9728 §3.1 path-suffix well-knowns can be served as JSON.** The path-suffixed forms (`/.well-known/oauth-protected-resource/mcp`) sit on the *root* domain, not under `/mcp`. Without explicit handlers in FastAPI they fall through to SvelteKit's SPA fallback and return `text/html` 200 — Anthropic parses that as JSON, fails silently, and aborts the connect with `step=start_error`. The proxy registers explicit handlers for these paths with a path-tail allowlist so we don't advertise OAuth metadata for arbitrary URLs.
3. **Cookies stay first-party.** The MuckRock session cookie was issued on `scoutpost.ai`; sending users to `supabase.co` mid-flow would lose it.
4. **Future migration.** The proxy is a thin shim: when we move off Supabase Edge Functions, only the proxy's upstream URL changes — clients keep working unchanged.

## Critical files

### FastAPI proxy

- `backend/app/routers/public_edge_proxy.py` — `/mcp*` proxy, well-known handlers, `_is_mcp_well_known_tail()` allowlist (only `/mcp` or `/mcp/...`).

### Supabase Edge Functions

- `supabase/functions/mcp-server/index.ts` — top-level router. HEAD/GET on `/`, well-known endpoints (legacy form), `/register`, `/authorize`, `/token`, JSON-RPC POST.
- `supabase/functions/mcp-server/rpc.ts` — JSON-RPC dispatcher. Auth gate (`requireUserOrApiKey`) runs **before** every method, including `initialize`. Tool handlers fan out to the units/scouts/projects EFs.
- `supabase/functions/mcp-server/oauth/metadata.ts` — `baseUrl()`, RFC 8414 + RFC 9728 metadata documents.
- `supabase/functions/mcp-server/oauth/register.ts` — DCR (RFC 7591). PKCE-only by default.
- `supabase/functions/mcp-server/oauth/authorize.ts` — `/authorize` validates DCR client + PKCE, signs an `mcp_state` JWT, 302s to the broker.
- `supabase/functions/mcp-server/oauth/token.ts` — `/token` exchanges the authorization code (or refresh token) for the upstream Supabase JWT.
- `supabase/functions/mcp-server/oauth/state.ts` — HMAC-signed state tokens, prefix routing.
- `supabase/functions/mcp-auth/index.ts` — broker. Renders the MuckRock OIDC handshake, resolves the Supabase magiclink server-side (`fetch(redirect: 'manual')`), inserts a row into `mcp_oauth_codes`, 302s to claude.ai. Replaces the old client-side HTML bounce page entirely.

### Why `mcp-auth` is a separate Edge Function

`mcp-server` runs with `verify_jwt = false` so OAuth endpoints can be reached unauthenticated. The broker needs the same property and additionally needs to call Supabase Auth admin APIs with the service-role key. Splitting it out keeps the JSON-RPC surface (`mcp-server`) auditable as an isolated bundle.

The two functions share `MCP_STATE_SECRET` so `mcp-auth` can verify state tokens minted by `mcp-server`. There is no cross-EF import (Supabase's bundler doesn't support that); `mcp-auth` carries a copy of `state.ts` named `mcp_server_state.ts`.

## Tools surface

JSON-RPC `tools/list` returns the Scoutpost product surface grouped around:

- Scouts — list, create, inspect, update, run, pause, resume, and delete page, beat, social, civic, and Fleet scouts. `test_transport_config` is Fleet Step 1; agents pass its `baseline_ids` to `create_scout` as `transport_baseline_ids` in Step 2. New Social Scout creation defaults to criteria mode and requires criteria text unless the caller explicitly chooses summarize mode.
- Units — list, search, inspect, verify, reject, mark used, and soft-delete information units.
- Projects — list, create, inspect, update, and delete investigation projects.
- Ingest — `ingest_content` for manual URL/text ingestion into a project.
- Entities and reflections — search, inspect, merge entities, and create/list/update reflections.

Every tool runs through `requireUserOrApiKey` so RLS policies in the downstream tables are enforced as the connector user. The bridge does not bypass RLS.

The canonical tool definitions live in `supabase/functions/mcp-server/rpc.ts`. The `scout-mcp` stdio bridge at `mcp/` is deliberately dumb — it forwards JSON-RPC verbatim, so adding a tool to `rpc.ts` is automatically available to stdio-only clients without a bridge release.
