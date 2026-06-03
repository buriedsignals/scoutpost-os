# `scout-mcp` stdio bridge

## Project-Wide Rules

Read the nearest parent `CLAUDE.md` / `AGENTS.md` before editing; its session preflight points to the canonical coding-rules skill. This file only adds directory-specific context.

## ⚠️ Release cost controls — read before you tag

Same pattern + same guardrails as `cli/CLAUDE.md` §"Release cost
controls". Short version, re-stated so you don't miss it:

- macOS runners bill at **10× Linux**. One stuck `notarytool submit
  --wait` on 2026-04-22 burned ~1,650 billable minutes.
- `.github/workflows/mcp-release.yml` keeps `timeout-minutes: 25` on the
  Notarize step + a 20-min inner poll loop. Don't remove.
- macOS matrix legs are `continue-on-error: true` + `required: false`.
  A stuck macOS job does NOT block the Linux release. Don't change.
- Release job uses `if: always() && …` so Linux publishes even if macOS
  fails. Don't change.
- Never switch notarization back to `xcrun notarytool submit --wait` as
  a single call. Use the split submit + poll pattern.
- Before tagging, check Apple's Developer System Status — if
  "Developer ID Notary Service" looks stuck, wait.
- To cancel a stuck run: `gh run cancel <run-id>`.

## Architecture

```
MCP client (Claude Desktop) ──(stdio JSON-RPC)──> scout-mcp ──(HTTPS + Bearer + apikey)──> Supabase Edge Function mcp-server
```

- Read newline-delimited JSON-RPC on stdin
- For each line: validate it's JSON-RPC 2.0, forward body verbatim to the
  remote, write the remote's response back on stdout (one line)
- Notifications (no `id`) forward but emit no stdout line — per JSON-RPC
- Errors from the forwarder become JSON-RPC error responses so the
  framing stays intact; non-protocol diagnostics go to stderr

The bridge is **deliberately dumb** — it never parses, mutates, or
validates tool payloads. This keeps it forward-compatible with new tools
and new MCP protocol versions without needing a bridge release. Its only
jobs are (1) transport translation and (2) auth injection.

## Release procedure

Identical pattern to the CLI (see `cli/CLAUDE.md`):

1. Pick a semver. First release: `0.1.0`.
2. `git tag mcp-v0.1.0 -m "scout-mcp 0.1.0 — initial release"`
3. `git push origin mcp-v0.1.0`
4. `.github/workflows/mcp-release.yml` fires on the private monorepo:
   - 4 matrix builds (mac arm/x86, linux arm/x86)
   - macOS binaries are code-signed + notarized via the same Apple
     Developer cert used for `scout`
   - Release published on `buriedsignals/scoutpost-os` (public OSS
     mirror) with 4 binaries + 4 sha256 files, via `OSS_RELEASE_PAT`.
5. Smoke test after public assets exist: `curl -fsSL https://github.com/buriedsignals/scoutpost-os/releases/latest/download/scout-mcp-darwin-arm64 -o /tmp/scout-mcp && chmod +x /tmp/scout-mcp && /tmp/scout-mcp --version`.
   Until then, smoke test a source build from `mcp/`: `deno task compile-mac-arm && ./dist/scout-mcp-darwin-arm64 --version`.

## Tag naming

- Release: `mcp-v<MAJOR>.<MINOR>.<PATCH>` (e.g. `mcp-v0.1.0`)
- Pre-release (workflow marks as prerelease on GitHub):
  - `mcp-v0.1.0-rc1`, `mcp-v0.1.0-beta2`, `mcp-v0.1.0-alpha1`

CI injects the version string into `mcp/lib/version.ts` via `sed` before
`deno compile`. Local dev builds stay `"dev"`.

## Structure

- `scout-mcp.ts` — entry point; handles `--version` / `--help`, loads
  config, kicks off the bridge loop.
- `lib/bridge.ts` — `forwardOne` (single line) + `runBridge` (stdin loop).
- `lib/config.ts` — config loader + `remoteUrl` + `remoteHeaders`.
  Reads `~/.scoutpost/config.json` (same file as the scout CLI) with
  env-var overrides.
- `lib/version.ts` — `VERSION` constant rewritten by CI at release time.
- `lib/_test.ts` — unit tests for config, forwarding, and integration.
- `deno.json` — tasks: test, run, compile-mac-arm/x86, compile-linux-arm/x86, compile-all.

## Auth — reuses the CLI's config

- `api_key` (preferred) — `cj_…` key generated in the app at /api →
  Agents → API. Sent as `Authorization: Bearer cj_…`.
- `supabase_anon_key` — **required** when `api_url` is a Supabase host.
  Sent as the `apikey:` header. Without it, Kong rejects the request.
- `api_url` — API base. Trailing slash stripped. Default
  `https://www.scoutpost.ai/functions/v1` if unset.

Env-var overrides: `SCOUTPOST_API_URL`, `SCOUTPOST_API_KEY`,
`SCOUTPOST_SUPABASE_ANON_KEY`. Legacy `COJOURNALIST_*` names are still
accepted as a fallback.

## Why not embed the tools directly in the bridge?

Two reasons:

1. **Single source of truth.** Tools live in
   `supabase/functions/mcp-server/rpc.ts`. Bridge updates would need to
   ship every time a tool is added; forwarder updates never need to.
2. **Auth.** The `cj_…` key lives on the user's machine. If the bridge
   called sibling EFs directly it would need to understand each tool's
   RLS semantics. Forwarding through `mcp-server` means the same
   `requireUserOrApiKey` path gates every tool call.

## Secrets

Identical to the CLI release — `APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, `APPLE_API_KEY_P8`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `OSS_RELEASE_PAT`. All sit on
the private `buriedsignals/scoutpost` repo.
