# Agnostic Database Manager Setup

## Context

The `/setup` page currently presents Scoutpost self-hosting as a Supabase-only
path. That matches the working OSS runtime today: SvelteKit builds against a
Supabase Functions API, data lives in Supabase Postgres, auth depends on
Supabase Auth, scheduled work uses `pg_cron`, and the installer applies the
SQL files under `supabase/migrations/`.

That is too narrow for larger organizations. Some newsroom or media-company
CTOs will want to bring their own database, auth, hosting, policy controls, or
cloud platform. Scoutpost should support that conversation without claiming
that every platform is already a drop-in runtime.

The right product move is a two-path setup model:

- **Supabase**: the supported managed/default path.
- **Manual / bring your own platform**: a CTO-owned integration path where
  Scoutpost produces the canonical schema/runtime requirements and an
  agent-readable porting packet, but does not auto-apply provider-specific
  infrastructure.

This deliberately removes separate "Existing Supabase" and "Self-hosted
Supabase" choices from the setup UI. Those are Supabase implementation details,
not user-facing database-manager categories.

## Goals

- Make `/setup` less Supabase-branded while preserving the current supported
  Supabase install path.
- Give technical operators a clear manual path for non-Supabase platforms.
- Treat the existing Supabase migrations as the canonical product data model.
- Generate instructions that tell an agent how to inspect, translate, and
  propose provider-specific migrations for human review.
- Avoid implying that Firebase, Cloud SQL, Neon, Postgres, or any other
  provider is already fully supported unless a provider adapter exists.
- Keep the Docker installer safe by refusing to run Supabase-specific
  operations for manual provider manifests.

## Non-Goals

- Do not build a Firebase-specific integration in this work.
- Do not translate all Supabase Edge Functions to another runtime.
- Do not introduce a second production data store implementation.
- Do not apply provider-specific migrations automatically for the manual path.
- Do not remove Supabase support or weaken the current tested installer path.

## Product Model

The setup page should offer one database/runtime section with two choices:

1. **Supabase**
   - Label: "Supabase managed stack" or similar.
   - This is the supported path.
   - It may still collect the Supabase values needed by the existing installer,
     but the UI should hide unnecessary mode language where possible.
   - Advanced Supabase operational distinctions can stay in expandable
     controls or documentation, not as top-level product choices.

2. **Manual / bring your own platform**
   - Label: "Manual / bring your own platform".
   - Collects provider name, operator notes, optional docs URLs, optional
     database/API endpoint placeholders, and the desired app URL.
   - Makes clear that the operator's technical team owns the integration.
   - Generates a provider porting packet instead of an auto-installer.

## Manifest Model

Keep backward compatibility with existing manifests, but add a neutral platform
section.

Recommended extension:

```json
{
  "version": 1,
  "data_platform": {
    "provider": "supabase",
    "provider_name": "Supabase",
    "integration_mode": "managed"
  },
  "supabase": {
    "mode": "cloud-create"
  }
}
```

Manual example:

```json
{
  "version": 1,
  "data_platform": {
    "provider": "manual",
    "provider_name": "Internal platform",
    "integration_mode": "manual",
    "docs_urls": [
      "https://internal.example.com/platform/database"
    ],
    "operator_notes": "Use company auth, managed Postgres, and approved CI."
  }
}
```

Validation rules:

- Supabase path keeps the existing required service keys, auth domains, and
  Supabase credential requirements.
- Manual path still requires product-level services that Scoutpost needs:
  Gemini, Firecrawl, Apify, Resend, MapTiler, admin email, and signup domains.
- Manual path requires a provider name or operator note.
- Manual path does not require Supabase URL, anon key, service role key, JWT
  secret, project ref, org id, region, database password, or access token.

## Generated Artifacts

Supabase path should keep producing:

- `scoutpost-setup.json`
- `scoutpost-docker-install.sh`
- `scoutpost-docker-install.md`
- `scoutpost-agent-prompt.md`
- `newsroom-onboarding.md`

Manual path should produce:

- `scoutpost-setup.json`
- `scoutpost-agent-prompt.md`
- `scoutpost-provider-porting.md`
- `newsroom-onboarding.md`

The manual path should not present the Docker installer as the primary call to
action unless the Docker behavior has been made manual-safe.

## Agent Prompt Requirements

For Supabase, preserve the existing prompt behavior: read the manifest, prefer
Docker, use Supabase CLI non-interactively, run the doctor path, and avoid
hosted `scoutpost.ai` operational targets.

For manual providers, the generated prompt must tell the agent to:

- Read `scoutpost-setup.json` from disk and avoid printing secrets.
- Read `docs/supabase/migrations.md`.
- Inspect `supabase/migrations/` in numeric order.
- Treat those migrations as the canonical Scoutpost data model and operational
  contract.
- Identify Supabase-specific constructs that need provider decisions:
  Supabase Auth, RLS policies, Edge Functions, PostgREST conventions,
  `pgvector`, `pg_cron`, `pg_net`, Vault secrets, RPCs, and service-role access.
- Fetch current official provider documentation before proposing a translation.
- Produce proposed migration/runtime changes in a reviewable artifact.
- Ask for explicit human approval before applying any database, auth, or
  production infrastructure change.
- Keep unimplemented provider assumptions visible instead of hiding them behind
  optimistic generated commands.

The prompt should use the selected provider name and docs URLs from the
manifest, but it should not contain provider-specific invented instructions.

## Provider Porting Packet

`scoutpost-provider-porting.md` should include:

- Selected provider name and operator notes.
- Current Scoutpost runtime assumptions.
- Pointer to `docs/supabase/migrations.md`.
- Pointer to `supabase/migrations/`.
- A migration translation checklist:
  - tables and constraints
  - indexes and vector search
  - row-level access control
  - auth identity mapping
  - API key validation
  - scheduled jobs
  - HTTP background dispatch
  - secrets management
  - RPC/function equivalents
  - local and CI validation
- A required human-review gate before applying changes.

## Installer Behavior

`automation/setup-from-manifest.sh` should branch on
`data_platform.provider`.

For `supabase` or missing `data_platform`, preserve current behavior.

For `manual`:

- Validate common non-Supabase fields.
- Skip `resolve_supabase`.
- Skip Supabase CLI link, config push, db push, functions deploy, secret set,
  and Vault setup.
- Do not write Supabase-specific production env files unless the operator has
  explicitly supplied compatible endpoints.
- Print or generate the provider porting checklist.
- Exit successfully only if the manual packet was generated; otherwise fail
  clearly.

The Docker image can still include the Supabase CLI for the supported path, but
manual mode must not invoke it. Generic tools such as `jq`, `git`, `openssl`,
Node, Deno, and GitHub CLI remain useful. Provider-specific CLIs should be
added later behind explicit provider modules, not installed by default.

## Setup Skill Changes

`frontend/static/skills/scoutpost-setup.md` should explain:

- Supabase is the supported managed setup path.
- Manual / bring your own platform is a planning and porting path.
- For manual providers, agents must use the generated manifest and porting
  packet, inspect the canonical Supabase migrations, fetch official provider
  docs, and prepare reviewable changes.
- Agents must not treat unported Supabase migrations as directly applicable to
  other providers.

The static setup skill should stay generic. Provider-specific details belong in
the generated prompt and the operator-managed integration work.

## Frontend UX

Recommended `/setup` changes:

- Rename the section from "SUPABASE" to "DATABASE AND RUNTIME".
- Replace the three Supabase radio choices with:
  - "Supabase"
  - "Manual / bring your own platform"
- Move Supabase Cloud fields under the Supabase choice.
- Show manual provider fields only under the manual choice.
- Change the cost estimate copy from "managed Supabase" to "Supabase managed
  stack by default; manual platforms vary by provider."
- Disable or relabel the Docker installer card for manual mode:
  - Supabase: "Download Docker installer"
  - Manual: "Download porting packet"

## Test Plan

Frontend unit tests:

- Supabase manifest validation remains unchanged for the supported path.
- Manual manifests do not require Supabase credentials.
- Manual generated prompts mention `docs/supabase/migrations.md` and
  `supabase/migrations/`.
- Manual generated prompts require official provider docs and human review.
- Redaction still covers all secrets.
- Existing Supabase onboarding and agent target derivation do not regress.

Automation tests:

- `automation/setup-from-manifest.sh` keeps current Supabase behavior.
- Manual manifests skip Supabase CLI commands.
- Manual manifests generate or print the provider porting packet.
- Docker entrypoint remains compatible with `install`, `doctor`, and `update`.

Documentation checks:

- `/skills/scoutpost-setup.md` describes both paths.
- Manual path language does not imply supported provider parity.
- Supabase path still points to the canonical supported installer.

## Acceptance Criteria

- `/setup` presents only two database/runtime options: Supabase and Manual /
  bring your own platform.
- Existing Supabase setup artifacts still work.
- Manual setup artifacts give CTOs and their agents enough information to plan
  a provider integration without pretending Scoutpost can already deploy there.
- Manual mode cannot accidentally run Supabase migrations against an unrelated
  provider.
- The generated agent instructions consistently point to the canonical
  migration index and migration directory.
