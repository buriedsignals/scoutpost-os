# `scout` CLI

## Project-Wide Rules

Read the nearest parent `AGENTS.md` / `AGENTS.md` before editing; its session preflight points to the canonical coding-rules skill. This file only adds directory-specific context.

## ⚠️ Release pipeline — read before you tag

**The full playbook lives in the `native-cli-npm-release` skill**
(`kit/native-cli-npm-release/SKILL.md`, loaded globally as a Claude Code
skill). It captures the hard-won lessons from the `scoutpost-cli`
0.1.0→0.1.7 saga — macOS JIT entitlements, notarization-that-doesn't-hang,
Intel-runner avoidance, cross-repo release tokens, npm granular-token/2FA
auth, the deno+npm coexistence trap, and the meta-rule **green CI ≠ working
binary**. Read it before touching `.github/workflows/cli-release.yml`.

Scoutpost-specific non-negotiables (do NOT regress — the skill explains *why*):

- **Codesign MUST pass `--entitlements cli/scout.entitlements`** (`allow-jit` +
  `allow-unsigned-executable-memory`). Without it the macOS binaries crash on
  launch with `Failed to reserve virtual memory for CodeRange` on strict macOS
  (e.g. macOS 26) — yet still pass notarization AND the CI smoke (older runner).
  The build greps the signature for `allow-jit` and fails if it's absent.
- **Both macOS legs run on `macos-latest`** (arm64 cross-compiles + signs the
  x86_64 target). No `macos-13` leg in build OR smoke — the Intel pool is
  deprecated and queues indefinitely.
- **Release uses `secrets.MIRROR_PAT`** (the proven scoutpost-os write token),
  `generate_release_notes: false`, and `target_commitish: master` (the mirror's
  default branch). `OSS_RELEASE_PAT` is broken/unused (lacks `Contents: write`).
- **Public release tag is `scout-v<version>`** (private git tag is
  `cli-v<version>`); the npm postinstall URL in `cli/scripts/release.js` must
  match the `scout-v` prefix.
- **npm publish needs a Granular Access Token with 2FA-bypass** in
  `secrets.NPM_TOKEN` (classic/"Automation" token types are gone from npm).
- **Notarize**: split submit → UUID-poll + `timeout-minutes`; macOS legs
  `continue-on-error`. macOS runners bill at **10×** — cancel stuck runs
  (`gh run cancel <run-id>`) and check Apple notary status
  (`https://developer.apple.com/system-status/`) before tagging during an outage.
- **After publish: install `scoutpost-cli@<version>` and run it on the newest
  macOS you can reach** before declaring done — the CI smoke runs on older macOS
  and will not catch a JIT-entitlement regression.

To **deprecate a broken published version**, dispatch the `npm-deprecate`
workflow (`gh workflow run npm-deprecate.yml -f spec=scoutpost-cli@X.Y.Z -f
message="…"`). `npm deprecate` from a plain shell 404s — it needs owner auth;
the workflow uses `NPM_TOKEN`.

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
   where the Apple + npm secrets live):
   - 4 matrix builds (mac arm/x86, linux arm/x86)
   - macOS binaries are code-signed + notarized via Apple
   - `release` job publishes on the PUBLIC mirror
     (`buriedsignals/scoutpost-os`) under the tag **`scout-v<version>`**
     (the private git tag is `cli-v<version>`; the public release uses
     `scout-v` to match the binary asset names and the npm postinstall
     download URL) with 4 binaries + 4 sha256 files, via `OSS_RELEASE_PAT`.
     Anyone can `curl` the assets without auth.
   - `npm-publish` job publishes the **`scoutpost-cli`** npm package
     (`npm i -g scoutpost-cli` → `scout` on PATH). It sets the package
     version from the tag, HEAD-verifies all four `scout-v<version>`
     binaries are attached (so it never ships a package whose macOS
     postinstall would 404 when notary legs stalled), then `npm publish`.
     Needs the `NPM_TOKEN` secret (see Secrets below). The postinstall
     download coordinates live in `cli/scripts/release.js` — the
     `scout-v` prefix and `buriedsignals/scoutpost-os` slug there MUST
     stay in sync with the `release` job's `tag_name`.
   - `smoke` job installs `scoutpost-cli@<version>` from npm on all four
     platforms and asserts `scout --help` works and `scout` resolves in
     the npm global bin dir.
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
  scouts, units, snapshots, ingest, export). `snapshots` = Page Archive
  retrieval (`list`/`download`/`url`); archive on/off is a `scouts add/update`
  flag (`--archive-enabled`/`--wayback-enabled`)
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
| `MIRROR_PAT` | PAT with `contents: write` on `buriedsignals/scoutpost-os`. Used by `mirror-oss.yml` (push commits) AND `cli-release.yml`'s `release` job (create the `scout-v*` release + upload binaries). Single proven write token for the mirror. |
| `OSS_RELEASE_PAT` | **Unused / broken.** Was intended as the release token but lacks `contents: write` on `scoutpost-os` (403s on create-a-release). Safe to delete, or fix its Contents permission to `Read and write` if you want a separate release token again. |
| `NPM_TOKEN` | npm **automation** token for an account with publish rights to the unscoped `scoutpost-cli` package. Used by the `npm-publish` job as `NODE_AUTH_TOKEN`. **One-time prerequisite:** create the token, `npm publish` the name once to reserve it (or let the first tagged release do it), and add the secret to `buriedsignals/scoutpost`. Without it, `npm-publish` fails and no package ships. |

Cert valid 5 years (renew 2031). Renewal reminder: `2027-04-15` decide
whether to keep paying Apple Developer Program ($109/yr).
