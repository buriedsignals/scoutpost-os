# `scout` CLI

## Project-Wide Rules

Read the nearest parent `CLAUDE.md` / `AGENTS.md` before editing; its session preflight points to the canonical coding-rules skill. This file only adds directory-specific context.

## ⚠️ Release cost controls — read before you tag

GitHub Actions macOS runners bill at **10×** the Linux rate. A stuck
macOS job eats 10 minutes of quota for every 1 wall-clock minute. One
runaway `notarytool submit --wait` hang on 2026-04-22 consumed ~1,650
billable minutes before we caught it.

Guardrails in `.github/workflows/cli-release.yml` that must stay in place:

1. **Notarize step has `timeout-minutes: 25`** (outer backstop) **and an
   inner 20-minute poll loop**. The tool will exit cleanly at 20 min with
   `notarization did not finish in 20 minutes (last status: X)` rather
   than long-polling Apple indefinitely. Don't remove these.
2. **macOS matrix legs are `continue-on-error: true` + `required: false`**
   in the matrix `include:` blocks. A stuck macOS job does not block the
   Linux release. Don't flip these to required without a plan for Apple
   notary outages.
3. **Release job uses `if: always() && …`** so the Linux binaries publish
   even when macOS legs fail or time out. macOS binaries re-attach on a
   workflow rerun once Apple's queue is healthy.
4. **Do NOT switch notarization back to `xcrun notarytool submit --wait`
   (single call).** That's the long-poll pattern that hangs; we split it
   into submit → explicit UUID polling. See electron/notarize#179 for
   the canonical write-up.

**Budget check before tagging:** if you're about to burn runner minutes
on a release and Apple's notary service looks stuck
(`https://developer.apple.com/system-status/` → "Developer ID Notary
Service"), wait. A failed macOS arm64 leg + x86 leg together burn
~400 billable minutes at the 20-min cap.

**Cancelling stuck runs saves money:**
```bash
gh run cancel <run-id>
```

## Release procedure

1. Ensure `main`/`migration` is clean and tests pass:
   ```bash
   cd cli && deno task test && deno task compile-all
   ```
2. Pick the next semver. First release: `0.1.0`.
3. Tag and push:
   ```bash
   git tag cli-v0.1.0 -m "scout 0.1.0 — <headline>"
   git push origin cli-v0.1.0
   ```
4. `.github/workflows/cli-release.yml` fires (on the private monorepo,
   where the Apple secrets live):
   - 4 matrix builds (mac arm/x86, linux arm/x86)
   - macOS binaries are code-signed + notarized via Apple
   - Release published on the PUBLIC mirror
     (`buriedsignals/scoutpost-os`) with 4 binaries + 4 sha256 files,
     via `OSS_RELEASE_PAT`. Anyone can `curl` the assets without auth.
5. Smoke test after public assets exist: `curl -fsSL https://github.com/buriedsignals/scoutpost-os/releases/latest/download/scout-darwin-arm64 -o /tmp/scout && chmod +x /tmp/scout && /tmp/scout --version`.
   Until then, smoke test the source install: `deno install -A -g -n scout https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/cli/scout.ts && scout --version`.

## Tag naming

- Release: `cli-v<MAJOR>.<MINOR>.<PATCH>` (e.g. `cli-v0.1.0`)
- Pre-release (workflow marks as prerelease on GitHub):
  - `cli-v0.1.0-rc1`, `cli-v0.1.0-beta2`, `cli-v0.1.0-alpha1`

The workflow injects the version string into `cli/lib/version.ts` via
`sed` before `deno compile`, so `scout --version` reports the real tag
in shipped binaries. Local dev builds stay `"dev"`.

## Structure

- `scout.ts` — entry point, subcommand dispatch, `--version` handling
- `commands/<name>.ts` — one file per subcommand (config, projects,
  scouts, units, ingest, export)
- `commands/_test.ts` — Deno unit tests
- `lib/client.ts` — REST client (`apiFetch`), `resolvePath` dual-backend
  shim, arg parser, table/json output helpers
- `lib/version.ts` — `VERSION` string rewritten by CI at release time
- `deno.json` — tasks: test, run, compile-mac-arm, compile-mac-x86,
  compile-linux-arm, compile-linux-x86, compile-all

## Dual-backend shim

`resolvePath` in `lib/client.ts` strips `/functions/v1/` from paths when
`api_url` doesn't contain `supabase.co`. Lets the same CLI talk to both the
pre-cutover FastAPI backend (`https://scoutpost.ai/api`) and the
post-cutover Supabase Edge Functions (`https://*.supabase.co`). Remove the
shim after the cutover is complete and all users have migrated.

**api_url convention:** use the Edge Functions base when talking to Scoutpost
or Supabase, for example `https://scoutpost.ai/functions/v1` or
`https://x.supabase.co/functions/v1`. `resolvePath` still accepts older bare
Supabase hosts and FastAPI `/api` bases so existing scripts do not fail during
the migration.

## Auth — api_key vs auth_token

Two credentials are accepted:

- `api_key` (preferred) — `cj_…` key generated in the app at /api →
  Agents → API. Sent as `Authorization: Bearer cj_…`. When talking to
  hosted or raw Edge Functions, `supabase_anon_key` is **also** required
  and sent as the `apikey:` header — the front door can reject bearer
  tokens before the function sees them without it.
- `auth_token` (legacy) — Supabase JWT pasted from browser devtools.
  Sent as `Authorization: Bearer <jwt>`. Used only for legacy SaaS
  sessions.

If both are set, `api_key` wins. Both can coexist for fallback flexibility
during migration.

The four valid config keys are: `api_url`, `auth_token`, `api_key`,
`supabase_anon_key`. `scout config show` redacts all credentials.

## Secrets

All on the private `buriedsignals/scoutpost` repo:

| Secret | Purpose |
|---|---|
| `APPLE_CERT_P12` | base64 of Developer ID Application `.p12` |
| `APPLE_CERT_PASSWORD` | `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | Cert Common Name (full string with team ID) |
| `APPLE_TEAM_ID` | 10-char team ID |
| `APPLE_API_KEY_P8` | App Store Connect API key file contents |
| `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER_ID` | Issuer ID |
| `OSS_RELEASE_PAT` | Fine-grained PAT with `contents: write` on `buriedsignals/scoutpost-os` — publishes release assets on the public mirror |

Cert valid 5 years (renew 2031). Renewal reminder: `2027-04-15` decide
whether to keep paying Apple Developer Program ($109/yr).
