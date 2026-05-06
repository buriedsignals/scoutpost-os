# MCP OAuth flow

Full server-side mint chain. Five hops, no client-side HTML bounce.

## Step-by-step

### 1. Discovery

Client fetches RFC 9728 §3.1 path-suffixed well-known:

```
GET https://www.cojournalist.ai/.well-known/oauth-protected-resource/mcp

200 application/json
{
  "resource": "https://www.cojournalist.ai/mcp",
  "authorization_servers": ["https://www.cojournalist.ai/mcp"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["mcp"],
  "resource_documentation": "https://www.cojournalist.ai/skills/cojournalist.md"
}
```

The legacy form (`/mcp/.well-known/oauth-protected-resource`) is also served —
some clients only fetch that.

Then the authorization-server metadata:

```
GET https://www.cojournalist.ai/.well-known/oauth-authorization-server/mcp

200 application/json
{
  "issuer": "https://www.cojournalist.ai/mcp",
  "authorization_endpoint": "https://www.cojournalist.ai/mcp/authorize",
  "token_endpoint": "https://www.cojournalist.ai/mcp/token",
  "registration_endpoint": "https://www.cojournalist.ai/mcp/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
  "scopes_supported": ["mcp"]
}
```

The `issuer` MUST equal the base URL clients pasted, exactly.
`MCP_SERVER_BASE_URL=https://www.cojournalist.ai/mcp` pins it; without that env
var the function self-references via `SUPABASE_URL` and clients reject the
issuer.

### 2. Dynamic Client Registration (RFC 7591)

Public, no auth. PKCE-only client:

```
POST https://www.cojournalist.ai/mcp/register
Content-Type: application/json

{
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "client_name": "Claude Cowork (MCP)"
}

201 Created
{
  "client_id": "59927b92-c4ff-…",
  "redirect_uris": [...],
  "token_endpoint_auth_method": "none",
  ...
}
```

Storage: `mcp_oauth_clients` table. `client_secret_hash` is NULL for PKCE-only
clients.

### 3. Authorize

```
GET https://www.cojournalist.ai/mcp/authorize?
    response_type=code&
    client_id=<dcr_id>&
    redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&
    state=<anthropic_state>&
    code_challenge=<pkce_s256>&
    code_challenge_method=S256
```

`mcp-server` validates:

- `client_id` exists in `mcp_oauth_clients`
- `redirect_uri` exact-matches one of the registered values
- `code_challenge_method=S256` (only S256 accepted)
- `state` is provided

It then signs an `mcp_state` JWT (HMAC `MCP_STATE_SECRET`, 10-min TTL) carrying
`{client_id, redirect_uri, anthropic_state, code_challenge, code_challenge_method}`
and 302s to the broker:

```
302 Location: https://<project-ref>.supabase.co/functions/v1/mcp-auth/login?
                  mcp_state=<signed-state>
```

### 4. Broker: MuckRock OIDC + Supabase magiclink (server-side)

`mcp-auth/login` verifies `mcp_state`, wraps it in the broker's own
`mcp.`-prefixed MuckRock state, and 302s the user to MuckRock:

```
302 Location: https://accounts.muckrock.com/openid/authorize?…
```

After the user signs in at MuckRock, the OIDC callback returns to
`mcp-auth/callback` with the MuckRock authorization code. The broker:

1. Exchanges the MuckRock code for tokens (server-side, with
   `MUCKROCK_CLIENT_SECRET`).
2. Fetches userinfo, resolves to a Supabase user (creates the row on first
   sign-in).
3. Mints a Supabase magiclink for that user.
4. **Resolves the magiclink server-side** with
   `fetch(magiclink, { redirect: 'manual' })` and parses the `access_token` /
   `refresh_token` from the `Location` URL fragment.
5. Inserts a row into `mcp_oauth_codes` carrying the Supabase JWT (`code`,
   `client_id`, `user_id`, `supabase_access_token`, `code_challenge`,
   `redirect_uri`, `expires_at = NOW() + 10 min`).
6. 302s the browser to
   `claude.ai/api/mcp/auth_callback?code=<our_code>&state=<anthropic_state>`.

This is the key difference vs. the original implementation: there is no HTML
bounce page that reads the magiclink fragment client-side. The browser sees only
one redirect and never visits `cojournalist.ai`'s SPA mid-flow. The previous
chain (browser → magiclink → HTML page that reads `location.hash` → POSTs hidden
form → server inserts code → 302) had 11+ hops and broke when (a) Supabase
delivered the error in the query string instead of the fragment, (b) the
magiclink redirect URL wasn't on Supabase Auth's allowlist, or (c) the inline JS
errored and left the user on a non-redirecting page.

### 5. Token exchange

Anthropic POSTs back to claude.ai's callback, which calls our token endpoint:

```
POST https://www.cojournalist.ai/mcp/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=<our_code>&
redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&
client_id=<dcr_id>&
code_verifier=<pkce_verifier>
```

`mcp-server`:

1. Looks up `code` in `mcp_oauth_codes`.
2. Verifies it isn't `used_at IS NOT NULL` and `expires_at > NOW()`.
3. PKCE-verifies `S256(code_verifier) === code_challenge`.
4. Returns the wrapped Supabase JWT as the OAuth access_token + a refresh_token:

```
200 application/json
{
  "access_token": "<supabase_jwt>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "<supabase_refresh>",
  "scope": "mcp"
}
```

5. Marks `used_at = NOW()` (idempotency guard — re-exchange returns 400).

### 6. Refresh

Standard `grant_type=refresh_token`. Forwards to Supabase Auth's refresh
endpoint and returns the rotated pair.

## Auth gate on JSON-RPC

Every method (including `initialize` and `notifications/initialized`) requires
`Authorization: Bearer <supabase_jwt>`. Without it:

```
HTTP 401
WWW-Authenticate: Bearer realm="MCP", error="invalid_token", resource_metadata="https://www.cojournalist.ai/mcp/.well-known/oauth-protected-resource"
Content-Type: application/json

{"jsonrpc":"2.0","id":<reqid>,"error":{"code":-32001,"message":"missing bearer token"}}
```

This is the trigger MCP clients use to start DCR + OAuth. Returning HTTP 200
with a JSON-RPC error inside (the old behaviour) silently aborted the OAuth flow
because clients only kick off DCR on a real HTTP 401 with a
`WWW-Authenticate: Bearer` challenge whose `resource_metadata` points at our
protected-resource document.

The HEAD `/` probe is gated identically (Anthropic's Cowork connector card uses
the HEAD response to decide between **Configure** and **Connect**). HEAD with a
valid bearer returns 200 + `MCP-Protocol-Version` so post-auth clients can use
HEAD as a cheap liveness probe.

GET `/` returns 405 + `Allow: POST` (not 404) so clients understand "POST-only
by design" and keep the session.

## State and signed tokens

- `MCP_STATE_SECRET` — HMAC-SHA256 key for the `mcp_state` JWT exchanged between
  `mcp-server` and `mcp-auth`. 10-min TTL. Required on both EFs.
- `SESSION_SECRET` — used by `mcp-auth` for the broker's own state cookie
  (MuckRock OIDC nonce).
- The Supabase access/refresh tokens are stored only in transit.
  `mcp_oauth_codes.supabase_access_token` is short-lived; the row is wiped by
  `cleanup_mcp_oauth_codes()` (see `docs/supabase/mcp-oauth.md`).

## Idempotency and replay

- DCR is idempotent only if the client repeats the exact same request body and
  gets the same row back; we don't dedupe — DCR is cheap and clients re-register
  on cache miss.
- `/token` is one-shot per code. Second exchange of the same code returns
  `400 invalid_grant`.
- Refresh tokens rotate on each use. Old refresh token returns
  `400 invalid_grant`.

## What the server does NOT do

- Issue its own JWTs. The OAuth `access_token` is the Supabase JWT verbatim —
  the upstream user identity stays consistent everywhere.
- Persist Supabase tokens beyond the 10-min code window.
- Maintain server-side sessions or cookies. Stateless.
- Trust the `Authorization` header without verifying signature against
  Supabase's JWKS.
