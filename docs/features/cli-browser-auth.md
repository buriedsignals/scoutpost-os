# Scout CLI browser authentication

Scoutpost connects shell-capable agents through a user-run terminal command:

```bash
npm install --global scoutpost-cli &&
  scout auth login --site 'https://scoutpost.ai' --label 'Claude Code'
```

The command contains no credential. `scout auth login` discovers the selected
Scoutpost deployment, creates a ten-minute device authorization, opens the
deployment's approval page, and polls at the server-provided interval. The user
must deliberately allow the request even when the browser already has a valid
session.

On hosted Scoutpost, that browser sign-in applies the same Indicator
eligibility policy as the web app. Under the current `paid` policy, an active
paid Indicator member receives Scoutpost Pro and the generated `cj_…` key
belongs to that Pro account. A future manual Lab-only switch also applies to
existing CLI keys through the shared admission check; see
`docs/operations/indicator-access-policy.md`.

After approval, the first valid redemption atomically creates one independently
revocable `cj_…` API key. The raw key is returned once to the requesting CLI,
verified with `GET /user/me`, and written to `~/.scoutpost/config.json` with
private permissions. The key is never displayed or placed in the command,
browser URL, environment, or process arguments.

## Commands

```bash
scout auth login [--site URL] [--label NAME] [--switch] [--no-browser]
scout auth status [--site URL]
scout auth logout
```

- `login` is a no-op when the existing credential is valid for the requested
  site. A different active site requires the explicit `--switch` flag.
- `status` validates the credential and shows only the site, account, key
  prefix, and label.
- `logout` asks the current key to revoke itself, then clears both `api_key` and
  legacy `auth_token` locally. If the service cannot be reached, it reports that
  only local removal succeeded and links to key management.
- `--no-browser` supports remote shells. The CLI always prints the safe
  verification URL and short matching code, then continues polling.

Manual API-key and legacy JWT configurations remain compatible for scripts and
recovery, but secret values are accepted only through protected stdin:

```bash
printf '%s\n' "$SCOUTPOST_API_KEY" | scout config set api_key --stdin
printf '%s\n' "$SCOUTPOST_AUTH_TOKEN" | scout config set auth_token --stdin
```

Browser login is the recommended interactive path.

## Connect Agent modal

Shell-capable agents default to one “Copy terminal command” action. The modal
explicitly says to run the command in a terminal rather than agent chat. API
keys, REST setup, Deno installation, and MCP are subordinate alternatives.

MCP-only clients retain their existing OAuth-first setup. Clients supporting
both paths default to CLI and expose one low-emphasis “Use MCP instead” action.

## Browser and service flow

1. The CLI fetches `/.well-known/scoutpost-cli.json` from the selected site.
2. It rejects plaintext non-loopback targets, redirects, credentials in URLs,
   malformed documents, and endpoints outside the declared site/API origin
   pair.
3. `POST /cli-auth/v1/device/authorize` returns an opaque device code, a short
   unambiguous user code, a verification URL, expiry, and polling interval.
4. `/cli/authorize?user_code=…` uses the existing deployment auth:
   hosted MuckRock/Supabase in SaaS and Supabase Auth in OSS. A strict
   session-storage allowlist preserves only this same-origin return route.
5. Lookup requires a valid session. Allow and Deny are authenticated POSTs, and
   the service accepts them only when the browser `Origin` exactly matches the
   request's site.
6. Redemption locks the request row and the user's API-key namespace. At most
   one caller receives the raw key and at most one key row is inserted.

The approval page shows the application, controlled agent/device labels, site,
matching code, requested access, and explicit Allow/Deny actions. It never
shows the API key.

## Limits and cleanup

- Device requests expire after ten minutes.
- Creation, polling, and browser code actions are rate-limited in Postgres.
- User codes exclude visually ambiguous characters; only hashes of user and
  device codes are stored.
- Every creation path shares an advisory-lock-protected five-key limit. At the
  limit, the user must choose a key to revoke; Scoutpost never removes one
  automatically.
- A five-minute cron marks requests expired and removes terminal requests after
  24 hours. It never deletes active API keys.

## Self-hosting

The frontend emits its own versioned discovery document. For a direct Supabase
deployment it advertises the public project URL and anon/publishable gateway
key. Service-role keys are never included.

Set the Edge Function secret below to pin authorizations to the public app
origin:

```text
SCOUTPOST_SITE_URL=https://newsroom.example
```

If omitted, `cli-auth` uses the existing `PUBLIC_APP_URL` deployment value
before considering the site advertised by the requesting CLI.

HTTP is accepted only for `localhost`, `127.0.0.0/8`, or `::1` development.
Deploy `cli-auth` with gateway JWT verification disabled; its public routes are
intentionally unauthenticated while browser lookup/decisions verify the session
inside the handler.

## Verification

The feature has three test layers:

- CLI tests cover discovery trust, browser fallback, polling/backoff, safe
  output, existing credentials, site switching, failure outcomes, status, and
  logout.
- pgTAP covers RLS, hashed state, denial, expiry, key limits, one-shot
  redemption, key identity, cleanup registration, and rate limiting.
- A gated local Supabase HTTP smoke races two redemptions, validates the winning
  key, self-revokes it, and confirms subsequent API rejection.

See also:

- [Edge Functions](../supabase/edge-functions.md)
- [RPC reference](../supabase/rpc-reference.md)
- [Auth and users](../supabase/auth-users.md)
- [CLI README](../../cli/README.md)
