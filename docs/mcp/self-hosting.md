# MCP self-hosting

What an OSS adopter needs to wire up to make `https://<their-host>/mcp` work as
a custom connector for their users.

## Required env vars

### On `mcp-server` Edge Function

| Var                         | Required | Example                              | Notes                                                                                                                                                                                                                                                                |
| --------------------------- | -------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_SERVER_BASE_URL`       | yes      | `https://newsroom.example.com/mcp`   | Exact public URL of the MCP surface, no trailing slash. The OAuth `issuer` and the protected-resource `resource` MUST equal this string. Without it, the function self-references via `SUPABASE_URL` and Anthropic-side OAuth metadata validators reject the issuer. |
| `MCP_STATE_SECRET`          | yes      | 64-char hex (`openssl rand -hex 32`) | HMAC key for the `mcp_state` JWT exchanged with `mcp-auth`. Same value on both functions.                                                                                                                                                                            |
| `SUPABASE_URL`              | yes      | (auto)                               | Supabase auto-injects.                                                                                                                                                                                                                                               |
| `SUPABASE_ANON_KEY`         | yes      | (auto)                               | Supabase auto-injects.                                                                                                                                                                                                                                               |
| `SUPABASE_SERVICE_ROLE_KEY` | yes      | (auto)                               | Supabase auto-injects. Used to insert `mcp_oauth_codes` rows.                                                                                                                                                                                                        |

### On `mcp-auth` Edge Function

| Var                                                              | Required   | Example                        | Notes                                                                            |
| ---------------------------------------------------------------- | ---------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `MCP_STATE_SECRET`                                               | yes        | matches `mcp-server`           | Verifies signed state from `mcp-server`                                          |
| `SESSION_SECRET`                                                 | yes        | 64-char hex                    | Broker's own state cookie + nonce                                                |
| `MUCKROCK_CLIENT_ID`                                             | yes (SaaS) | from MuckRock                  | OIDC handshake                                                                   |
| `MUCKROCK_CLIENT_SECRET`                                         | yes (SaaS) | from MuckRock                  | OIDC handshake                                                                   |
| `OAUTH_REDIRECT_BASE`                                            | yes        | `https://newsroom.example.com` | Public host for MuckRock callbacks. Must match the URL registered with MuckRock. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | yes        | (auto)                         |                                                                                  |

OSS adopters who don't use MuckRock can swap `mcp-auth` for any other
Supabase-Auth-aware broker — the contract `mcp-server ↔ broker` is just the
signed `mcp_state` JWT and the eventual `code` insert into `mcp_oauth_codes`.
See [`oauth.md`](oauth.md) §"Broker" for the contract.

### On the FastAPI proxy (Render or wherever)

| Var                 | Required | Example | Notes                                                                                                                       |
| ------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| (none MCP-specific) |          |         | The proxy reads the Supabase URL from `SUPABASE_URL` and forwards `/mcp*` to `${SUPABASE_URL}/functions/v1/mcp-server/...`. |

## Redirect-URL allowlists you have to update

OSS adopters often miss these; they're config, not code.

### Supabase Auth → Authentication → URL Configuration → Redirect URLs

Add the app origin used by `PUBLIC_APP_URL` / Supabase Site URL. `mcp-auth`
resolves the magiclink server-side and uses that app URL only as the Supabase
`redirectTo` value; there is no `/mcp/authorize-callback` browser hop in the
current flow.

### MuckRock OIDC → registered application → redirect URIs

Add the OAuth callback your `mcp-auth` broker uses
(`https://<your-host>/api/auth/callback` or equivalent). Production MuckRock
callbacks must already be on this list; verify it covers the new MCP path.

## DB migration

`supabase/migrations/00024_mcp_oauth.sql` creates `mcp_oauth_clients`,
`mcp_oauth_codes`, and the `cleanup_mcp_oauth_codes()` RPC. OSS deploys get this
automatically via `supabase db push`. See
[`docs/supabase/mcp-oauth.md`](../supabase/mcp-oauth.md) for schema details.

The cleanup cron is registered in
`supabase/migrations/<later>_mcp_oauth_cleanup_cron.sql`. Daily.

## FastAPI proxy: well-known handlers

`backend/app/routers/public_edge_proxy.py` registers handlers for:

- `/mcp/.well-known/oauth-authorization-server`
- `/mcp/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server/mcp`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server/{tail:path}` (with allowlist that
  only accepts `mcp` / `mcp/...`)
- `/.well-known/oauth-protected-resource/{tail:path}` (same allowlist)

The path-suffixed forms (RFC 9728 §3.1) are the form Anthropic Cowork actually
fetches. Without them, the SvelteKit SPA fallback returns HTML 200 and Anthropic
aborts with `step=start_error`.

## Sanity checks for a fresh deploy

```bash
HOST=https://<your-host>

# 1. Path-suffix well-knowns return JSON, not HTML
curl -i $HOST/.well-known/oauth-protected-resource/mcp | head -3
curl -i $HOST/.well-known/oauth-authorization-server/mcp | head -3

# 2. HEAD returns 401 with WWW-Authenticate
curl -I $HOST/mcp
# Expect: status 401, WWW-Authenticate: Bearer realm="MCP", ... resource_metadata="$HOST/.well-known/oauth-protected-resource"

# 3. Issuer in the metadata equals the URL clients pasted
curl -s $HOST/.well-known/oauth-authorization-server/mcp | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['issuer']==f'$HOST/mcp', d['issuer']"

# 4. DCR works
curl -s -X POST $HOST/mcp/register \
  -H 'content-type: application/json' \
  -d '{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"selfhost-test"}' \
  | python3 -m json.tool
# Expect: client_id, redirect_uris, token_endpoint_auth_method=none

# 5. /authorize 302s to the broker
CLIENT_ID=<from above>
curl -i -G "$HOST/mcp/authorize" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=https://claude.ai/api/mcp/auth_callback" \
  --data-urlencode "response_type=code" \
  --data-urlencode "state=test" \
  --data-urlencode "code_challenge=$(echo -n verifier12345678901234567890123456789012345678901 | shasum -a 256 | cut -d' ' -f1 | xxd -r -p | base64 | tr '+/' '-_' | tr -d '=')" \
  --data-urlencode "code_challenge_method=S256" \
  | grep -i location
# Expect: 302 Location: $SUPABASE_URL/functions/v1/mcp-auth/login?…
```

If any of (1)–(5) fails, see [`debugging.md`](debugging.md) for the matching
diagnosis.

## What changes are kept where

- **Code change** (any `*.ts` in `supabase/functions/mcp-server/` or
  `mcp-auth/`): redeploy with `supabase functions deploy <name>`.
- **Env var change**: redeploy doesn't pick up secrets. Use
  `supabase secrets set KEY=value` then redeploy.
- **Allowlist change** (Supabase Auth Redirect URLs): dashboard, instant.
- **MuckRock callback change**: MuckRock dashboard, instant.
- **Proxy code change** (FastAPI): merge to `main`, Render auto-deploys.

## Domain pinning checklist

When migrating to a new public host (e.g. you bought `mynewsroom.com`):

- [ ] Update `MCP_SERVER_BASE_URL` on both EFs.
- [ ] Add the `PUBLIC_APP_URL` / Supabase Site URL origin to Supabase Auth
      allowlist.
- [ ] Add the new MuckRock callback URL.
- [ ] Update DNS, deploy proxy, verify the well-known endpoints respond with the
      new issuer.
- [ ] Have at least one user test a full Cowork connect end-to-end before you
      tear down the old host. The `mcp_oauth_codes` table doesn't carry hosts;
      existing connections will keep working until refresh_token expiry.
