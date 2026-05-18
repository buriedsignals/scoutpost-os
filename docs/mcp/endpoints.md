# MCP endpoint reference

Every public path with the canonical probe and expected response. Use this when
debugging.

Base URL: `https://www.scoutpost.ai/mcp`

## Discovery (RFC 9728 / RFC 8414)

### `GET /.well-known/oauth-protected-resource/mcp`

RFC 9728 §3.1 path-suffix form (the form Anthropic Cowork actually uses).

```
$ curl -i https://www.scoutpost.ai/.well-known/oauth-protected-resource/mcp

200 OK
Content-Type: application/json

{
  "resource": "https://www.scoutpost.ai/mcp",
  "authorization_servers": ["https://www.scoutpost.ai/mcp"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["mcp"],
  "resource_documentation": "https://www.scoutpost.ai/skills/scoutpost.md"
}
```

If this returns `text/html` instead of JSON, the FastAPI handler isn't catching
it and SvelteKit's SPA fallback is responding. That's the `step=start_error` bug
— fix `_is_mcp_well_known_tail()` in `public_edge_proxy.py`.

### `GET /mcp/.well-known/oauth-protected-resource`

Legacy form. Same JSON. Kept because some clients (older Codex builds, MCP
Inspector) still fetch only this form.

### `GET /.well-known/oauth-authorization-server/mcp`

```
200 OK
Content-Type: application/json

{
  "issuer": "https://www.scoutpost.ai/mcp",
  "authorization_endpoint": "https://www.scoutpost.ai/mcp/authorize",
  "token_endpoint": "https://www.scoutpost.ai/mcp/token",
  "registration_endpoint": "https://www.scoutpost.ai/mcp/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
  "scopes_supported": ["mcp"]
}
```

`issuer` MUST equal the URL clients pasted, character-for-character. Set
`MCP_SERVER_BASE_URL` on `mcp-server` and `mcp-auth` to pin it.

## Streamable HTTP discovery

### `HEAD /mcp`

```
$ curl -I https://www.scoutpost.ai/mcp

401 Unauthorized
WWW-Authenticate: Bearer realm="MCP", error="invalid_token", resource_metadata="https://www.scoutpost.ai/mcp/.well-known/oauth-protected-resource"
MCP-Protocol-Version: 2025-06-18
Allow: POST, HEAD, OPTIONS
```

This 401 is what makes Cowork's connector card default to **Connect** instead of
**Configure**. With a valid `Authorization: Bearer <token>` header, returns 200
(used as a liveness probe by post-auth clients).

### `GET /mcp`

```
405 Method Not Allowed
Allow: POST, HEAD, OPTIONS
MCP-Protocol-Version: 2025-06-18
Content-Type: application/json

{"error":"method_not_allowed","error_description":"MCP endpoint is POST-only. Use POST with JSON-RPC 2.0 over HTTP."}
```

405 (not 404) keeps the session alive. 404 would make Claude clients show
"Disconnected".

## OAuth endpoints

### `POST /mcp/register` — DCR (RFC 7591)

```
$ curl -i -X POST https://www.scoutpost.ai/mcp/register \
    -H 'content-type: application/json' \
    -d '{
      "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
      "token_endpoint_auth_method": "none",
      "grant_types": ["authorization_code", "refresh_token"],
      "response_types": ["code"],
      "client_name": "diag"
    }'

201 Created
{
  "client_id": "<uuid>",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "client_name": "diag"
}
```

Public. PKCE-only (`token_endpoint_auth_method=none`) is the supported path. We
do accept `client_secret_post` for clients that insist; behaviour is identical
except a `client_secret` is generated and returned.

### `GET /mcp/authorize`

Always 302 on success — never renders HTML. With invalid params returns a JSON
error with `400`/`401`/`403`.

```
$ CHALLENGE=$(echo -n verifier12345678901234567890123456789012345678901 | shasum -a 256 | cut -d' ' -f1 | xxd -r -p | base64 | tr '+/' '-_' | tr -d '=')
$ curl -i -G "https://www.scoutpost.ai/mcp/authorize" \
    --data-urlencode "client_id=$CLIENT_ID" \
    --data-urlencode "redirect_uri=https://claude.ai/api/mcp/auth_callback" \
    --data-urlencode "response_type=code" \
    --data-urlencode "state=teststate" \
    --data-urlencode "code_challenge=$CHALLENGE" \
    --data-urlencode "code_challenge_method=S256"

302 Found
Location: https://<project-ref>.supabase.co/functions/v1/mcp-auth/login?mcp_state=…
```

Required params: `response_type=code`, `client_id`, `redirect_uri` (exact
match), `state`, `code_challenge`, `code_challenge_method=S256`.

### `POST /mcp/token`

```
$ curl -i -X POST https://www.scoutpost.ai/mcp/token \
    -H 'content-type: application/x-www-form-urlencoded' \
    -d "grant_type=authorization_code&code=$CODE&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&client_id=$CLIENT_ID&code_verifier=$VERIFIER"

200 OK
{
  "access_token": "<supabase_jwt>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "<supabase_refresh>",
  "scope": "mcp"
}
```

`grant_type=refresh_token` is also supported; pass `refresh_token` and
`client_id`.

## JSON-RPC

### `POST /mcp` (no bearer)

```
$ curl -i -X POST https://www.scoutpost.ai/mcp \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}'

401 Unauthorized
WWW-Authenticate: Bearer realm="MCP", error="invalid_token", resource_metadata="https://www.scoutpost.ai/mcp/.well-known/oauth-protected-resource"

{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"missing bearer token"}}
```

### `POST /mcp` (with bearer)

`initialize` echoes the requested protocolVersion when supported (`2025-06-18`,
`2025-03-26`, `2024-11-05`); otherwise falls back to advertised `2025-06-18`.

```
$ curl -X POST https://www.scoutpost.ai/mcp \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}'

200 OK
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"scoutpost","version":"…"}}}
```

`tools/list` returns the union of all tools registered in `rpc.ts`. `tools/call`
dispatches by tool name and forwards `arguments` to the underlying EF.

`notifications/initialized` returns `202 Accepted` (no body) — JSON-RPC
notifications have no response.

## Cold-start latency check

Run this before changing anything in the proxy or EF — it catches both
regression-introduced 5xx and surprise cold-start spikes.

```bash
for i in 1 2 3; do
  curl -sS -o /dev/null -w "well-known protected: %{http_code}/%{time_total}s\n" \
    https://www.scoutpost.ai/.well-known/oauth-protected-resource/mcp
done
# Expect: all 200, sub-250ms.
```
