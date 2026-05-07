# scoutpost.ai Domain Migration Runbook

Canonical app URL: `https://www.scoutpost.ai`

MuckRock OAuth callback URL: `https://scoutpost.ai/api/auth/callback`

Legacy URL during migration: `https://www.cojournalist.ai`

## Cutover Order

1. Keep `cojournalist.ai` serving production until `scoutpost.ai` passes auth, MCP, API, and email smoke tests.
2. Add `scoutpost.ai` to Cloudflare as a full DNS zone.
3. Point GoDaddy nameservers to the two Cloudflare nameservers assigned to the `scoutpost.ai` zone.
4. Add `scoutpost.ai` and `www.scoutpost.ai` as Render custom domains for the existing production service.
5. Ask MuckRock to add:
   - OAuth callback: `https://scoutpost.ai/api/auth/callback`
   - Webhook: `https://www.scoutpost.ai/api/auth/webhook`
6. Verify Resend domain records for `scoutpost.ai`, then send one test email from `updates@scoutpost.ai` and one alert-style test from `alerts@scoutpost.ai`.
7. Update Supabase Edge Function secrets:
   - `PUBLIC_APP_URL=https://www.scoutpost.ai`
   - `APP_POST_LOGIN_REDIRECT=https://www.scoutpost.ai/auth/callback`
   - `MUCKROCK_CALLBACK_URL=https://scoutpost.ai/api/auth/callback`
   - `MCP_SERVER_BASE_URL=https://www.scoutpost.ai/mcp`
8. Deploy the app branch and run the smoke checklist below.
9. Only after smoke passes, redirect browser traffic from `cojournalist.ai` to `scoutpost.ai`. Do not redirect `/api/auth/callback` or `/api/auth/webhook` until MuckRock confirms the old URLs are no longer used.

## GoDaddy to Cloudflare

Cloudflare says a domain must be added to Cloudflare and become active before the registrar transfer can proceed. GoDaddy says the auth/EPP code is available from the domain transfer flow and is also sent to the registrant email address.

Steps:

1. In GoDaddy, open the `scoutpost.ai` domain settings.
2. Check DNSSEC or DS records. If DNSSEC is enabled, disable it before changing nameservers.
3. In Cloudflare, add `scoutpost.ai` as a new site using full DNS setup.
4. Copy the two assigned Cloudflare nameservers.
5. In GoDaddy, replace the current nameservers with the assigned Cloudflare nameservers.
6. Wait for the Cloudflare zone status to become `Active`. Cloudflare says this can take a few minutes and up to 24 hours.
7. In GoDaddy, unlock the domain for transfer.
8. In GoDaddy, choose transfer to another registrar and copy the authorization code.
9. In Cloudflare Registrar, start the transfer and enter the auth code.
10. Approve the outgoing transfer at GoDaddy if GoDaddy offers an approval step. Transfers can take several days.

Official docs:

- Cloudflare transfer to Cloudflare Registrar: https://developers.cloudflare.com/registrar/get-started/transfer-domain-to-cloudflare/
- Cloudflare nameserver update docs: https://developers.cloudflare.com/dns/nameservers/update-nameservers/
- GoDaddy auth code docs: https://www.godaddy.com/help/get-the-auth-code-for-my-domain-1685
- Cloudflare Single Redirects: https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-dashboard/

## DNS Records

Add these records after Render gives the exact targets:

| Name | Type | Target | Proxy |
| --- | --- | --- | --- |
| `www` | `CNAME` | Render custom-domain target | Proxied after Render verifies |
| `@` | `CNAME` or Cloudflare flattening target | Render custom-domain target | Proxied after Render verifies |

Add the Resend verification records exactly as Resend shows them. Expect DKIM `CNAME` records, an SPF-related `TXT` record if Resend asks for one, and a DMARC `TXT` record such as:

```txt
Name: _dmarc
Value: v=DMARC1; p=none; rua=mailto:updates@scoutpost.ai
```

Keep `p=none` for the migration window. Tighten later after confirming normal delivery.

## Wrangler Help I Can Provide

I can help inspect and apply Cloudflare config with Wrangler after you authenticate:

```bash
npx wrangler login
npx wrangler whoami
```

Useful Wrangler/API-backed work after login:

- List zones and confirm `scoutpost.ai` is active.
- Add DNS records if the account token has `Zone:DNS:Edit`.
- Add redirect rules if the account token has ruleset edit access.
- Verify the final DNS state before Render and Resend checks.

If Wrangler is not authorized, use the Cloudflare dashboard for DNS and redirects. Do not paste Cloudflare API tokens into the repo.

## Redirect Plan

Preferred behavior:

- `https://cojournalist.ai/*` -> `https://www.scoutpost.ai/$1`
- `https://www.cojournalist.ai/*` -> `https://www.scoutpost.ai/$1`
- Preserve path and query string.
- Exclude `/api/auth/callback` and `/api/auth/webhook` until MuckRock confirms the old URLs are no longer configured.

Use Cloudflare Single Redirects or Bulk Redirects on the `cojournalist.ai` zone. Keep the redirect disabled until the new-domain smoke checklist passes.

## Smoke Checklist

Run these before enabling old-domain redirects:

```bash
curl -sI https://www.scoutpost.ai/ | head
curl -s https://www.scoutpost.ai/_app/env.js
curl -s https://www.scoutpost.ai/functions/v1/openapi-spec | head
curl -s https://www.scoutpost.ai/mcp/.well-known/oauth-authorization-server
curl -s https://www.scoutpost.ai/.well-known/oauth-protected-resource/mcp
curl -sI https://www.scoutpost.ai/api/auth/has-users | head
```

Manual checks:

- `/login` starts MuckRock sign-in.
- MuckRock redirects to `https://scoutpost.ai/api/auth/callback`.
- Browser lands on `https://www.scoutpost.ai/auth/callback`, then enters the workspace.
- `/docs`, `/skills/cojournalist.md`, `/swagger`, `/mcp`, and `/functions/v1/openapi-spec` load from the new domain.
- One Resend test email arrives from `updates@scoutpost.ai`.
- One Scout alert test email arrives from `alerts@scoutpost.ai`.

## Rollback

If auth fails:

1. Disable redirects from `cojournalist.ai`.
2. Restore Supabase secrets:
   - `PUBLIC_APP_URL=https://www.cojournalist.ai`
   - `APP_POST_LOGIN_REDIRECT=https://www.cojournalist.ai/auth/callback`
   - `MUCKROCK_CALLBACK_URL=<old MuckRock callback URL>`
   - `MCP_SERVER_BASE_URL=https://www.cojournalist.ai/mcp`
3. Ask MuckRock to keep the old callback/webhook active.
4. Redeploy the previous Render image or revert the PR.

## Announcement Email

Dry-run all resolved recipients:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
MUCKROCK_CLIENT_ID=... MUCKROCK_CLIENT_SECRET=... \
deno run --allow-env --allow-net --allow-read \
  scripts/send-domain-migration-email.ts --template USER_UPDATE_EMAIL.md
```

Send a single test:

```bash
CONFIRM_SEND=scoutpost-domain-migration RESEND_API_KEY=... \
deno run --allow-env --allow-net --allow-read \
  scripts/send-domain-migration-email.ts --to you@example.com
```

Send to users:

```bash
CONFIRM_SEND=scoutpost-domain-migration \
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
MUCKROCK_CLIENT_ID=... MUCKROCK_CLIENT_SECRET=... RESEND_API_KEY=... \
deno run --allow-env --allow-net --allow-read \
  scripts/send-domain-migration-email.ts --template USER_UPDATE_EMAIL.md
```
