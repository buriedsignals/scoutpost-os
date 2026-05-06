# MCP debugging

What each failure mode looks like and how to triage.

## Symptom matrix

| Symptom                                                                                                  | Most likely cause                                                                      | Where to look first                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step=start_error` / "Couldn't reach the MCP server"                                                     | RFC 9728 path-suffix well-knowns return HTML instead of JSON                           | `curl -i https://<host>/.well-known/oauth-protected-resource/mcp` — must be `application/json`, not `text/html`                                                                                                       |
| Connector card defaults to **Configure** instead of **Connect** (no disconnect/reconnect dance fixes it) | Anthropic-side cached state from a prior failed attempt                                | Disconnect → Remove → quit app → re-add. If still wrong, `curl -I https://<host>/mcp` should return `401`; if it returns `200`, the HEAD auth gate is missing                                                         |
| Connect runs OAuth but tools list is empty                                                               | Missing scopes, or `tools/list` returns 401 inside HTTP 200                            | `curl -i -X POST https://<host>/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` — must be HTTP 401 with `WWW-Authenticate: Bearer`, not 200 with a JSON-RPC error inside |
| `initialize` succeeds but next request fails with "session expired"                                      | Server is generating a fresh session_id per request                                    | Sessions are stateless — this server doesn't issue session_ids. If a client demands one, return a stable per-bearer hash                                                                                              |
| OAuth runs but ends on a non-redirecting page on cojournalist.ai                                         | Old client-side HTML bounce path is still serving / `/authorize-callback` route exists | The 2026-05-04 server-side mint flow eliminates the bounce. If a client lands on a `/authorize-callback` URL, the broker isn't using the new `mcp-auth` function                                                      |
| `redirect URL not allowed` on the Supabase verify endpoint                                               | `PUBLIC_APP_URL` is not on Supabase Auth's allowlist                                   | Dashboard → Authentication → URL Configuration → Redirect URLs → add the app origin used by `PUBLIC_APP_URL`                                                                                                          |
| Token exchange returns `invalid_grant`                                                                   | Code was already used, expired (>10min), or PKCE verifier doesn't match the challenge  | Check `mcp_oauth_codes` row: `used_at` non-null = replay; `expires_at < NOW()` = expired                                                                                                                              |
| Connector works on Cowork but fails in Codex Desktop                                                     | Codex defaulted to STDIO tab in the connect dialog                                     | Switch to the **Streamable HTTP** tab; STDIO doesn't apply to remote servers                                                                                                                                          |
| Issuer mismatch warning                                                                                  | `MCP_SERVER_BASE_URL` not set, function self-references via `SUPABASE_URL`             | `supabase secrets set MCP_SERVER_BASE_URL=https://<host>/mcp --project-ref <ref>` then redeploy                                                                                                                       |

## Configure vs Connect — root cause checklist

Anthropic's Cowork connector card decides between **Connect** and **Configure**
before the user clicks anything. The decision logic, in priority order:

1. **HEAD `/mcp` response.** If 200, the card thinks "server reachable, no auth
   needed" → defaults to Configure. If 401 + `WWW-Authenticate: Bearer`,
   defaults to Connect.
2. **POST `/mcp` `initialize` response without auth.** Same logic; 200 means
   Configure, 401 means Connect. Anthropic checks both — gating only one is not
   enough (the bug we shipped on 2026-05-05; PR #155 added the HEAD gate).
3. **Cached state from a previous attempt.** Cowork persists card state in
   Anthropic's cloud; **Disconnect** alone keeps it. **Remove** is supposed to
   clear it but doesn't always — quit and reopen the app, or remove from
   claude.ai web first if you originally added it there.

Quick verification:

```bash
$ curl -I https://www.cojournalist.ai/mcp
HTTP/2 401
www-authenticate: Bearer realm="MCP", error="invalid_token", resource_metadata="https://www.cojournalist.ai/mcp/.well-known/oauth-protected-resource"
mcp-protocol-version: 2025-06-18
allow: POST, HEAD, OPTIONS
```

If you see HTTP 200 here, redeploy `mcp-server`. If you see anything else (404,
502, HTML), the FastAPI proxy isn't forwarding correctly.

## Tracing a flow end-to-end

Every request through `mcp-server` and `mcp-auth` is tagged with a `request_id`
in structured logs. To trace a single user's session:

1. Get the `request_id` from the user's browser (or, post-deploy, from the
   connector card's "Reauthenticate" error reference).
2. Filter Supabase EF logs by that `request_id`. Either via dashboard:
   - <https://supabase.com/dashboard/project/<project-ref>/functions/mcp-server/logs>
   - <https://supabase.com/dashboard/project/<project-ref>/functions/mcp-auth/logs>
3. Filter Render request logs to `path=/mcp*` + `path=/api/auth/*` for the same
   time window.

Logs never include token values; they include scheme + length only
(`auth_scheme="Bearer"`, `auth_len=178`). If you need to inspect a specific
token, decode it from the user's browser devtools — never from logs.

## Self-hosted deploy returns 502 / Cloudflare error

Probably an Edge Function cold-start hitting a misconfigured secret. Run:

```bash
supabase functions list --project-ref <ref>
supabase secrets list --project-ref <ref> | grep -E 'MCP_SERVER_BASE_URL|MCP_STATE_SECRET|SESSION_SECRET'
```

All three must be set on both `mcp-server` and `mcp-auth`. Missing
`MCP_STATE_SECRET` makes `/authorize` or `mcp-auth/login` fail before the user
reaches MuckRock.

## Cloudflare cache poisoning

Watched once on 2026-04-24: a SPAStaticFiles bug returned HTML for `_app/*.js`,
Cloudflare cached it for 4h browser TTL, the fix shipped but users stayed broken
until cache purged. Code fix is necessary but not sufficient — purge Cloudflare
cache too:

- Dashboard → Caching → Configuration → **Purge Everything**.
- Or API one-liner with the right token (no token in `~/.hermes/.env` as of
  2026-04-24, so manual is fine).

## When you actually need to read the EF source

Common cases:

- **Adding a tool**: `supabase/functions/mcp-server/rpc.ts`. Add to the
  `tools/list` registry + `tools/call` switch. The stdio bridge picks it up
  automatically (it forwards verbatim).
- **Changing the OAuth flow**:
  `supabase/functions/mcp-server/oauth/{authorize,token,register,metadata,state}.ts`
  and `supabase/functions/mcp-auth/index.ts`.
- **Adding a new authorization server (not MuckRock)**: clone `mcp-auth` to a
  new EF, point `mcp-server`'s `/authorize` 302 at it, ensure the new broker
  honours the same `mcp_state` JWT contract.
- **Failing tests in CI**: `supabase/functions/mcp-server/_test.ts` is the
  source of truth for the contract. Tests requiring a live Supabase project are
  gated on `SUPABASE_URL` + `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY`.
  Pure-function tests (PKCE, state signing, `negotiateProtocolVersion`) run with
  dummy values.

## Past incidents (chronological, condensed)

- **2026-05-04 — `step=start_error`.** Path-suffix well-knowns returned HTML.
  Fix: `_is_mcp_well_known_tail()` allowlist in `public_edge_proxy.py` (PR
  #151).
- **2026-05-04 — Magiclink browser bounce died on a non-redirecting page.** 11+
  hop client-side flow with multiple silent failure paths. Fix: server-side mint
  in `mcp-auth` (PR #153).
- **2026-05-05 — Connector card defaulted to Configure even after server-side
  mint shipped.** `initialize` returned 200 without auth. Fix: auth gate before
  method dispatch (PR #154).
- **2026-05-05 — Configure-default persisted after PR #154.** HEAD `/mcp`
  returned 200 unconditionally. Cowork's pre-flight HEAD probe decided "no auth
  needed" before ever testing POST. Fix: HEAD gate (PR #155).
- **2026-05-05 — `WWW-Authenticate` advertised internal Supabase host.** First
  HEAD-gate fix used `url.origin` instead of `baseUrl()`. Fix: switched to
  `baseUrl()` (PR #156).

The `MCP_SPECFILE.md` at repo root carries the raw debug log from this period;
it's untracked and useful as a primary-source dump if you're trying to reproduce
a hypothesis I considered.
