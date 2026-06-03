# Dependabot triage — 2026-05-24

Status of the 13 open Dependabot PRs at the time of post-stabilization cleanup.
All are `MERGEABLE` against `main`. None block stabilization — this triage is
maintenance scheduling, not a release-blocker review.

Verification still required per PR before merge: green CI on the PR after a
manual rebase to current `main`, plus the per-PR notes below.

## Tier 1 — safe to merge as a batch (patch + minor, internal/dev-only)

Merge order doesn't matter. Rebase, watch CI, merge.

| PR | Package | Bump | Why safe |
|---|---|---|---|
| #127 | `tzdata` | `>=2026.1` → `>=2026.2` | Data-only, no API surface. |
| #128 | `pyyaml` | `>=6.0` → `>=6.0.3` | Patch series, stable API. |
| #129 | `asyncpg` | `>=0.30.0` → `>=0.31.0` | Minor; we only use basic driver surface. |
| #130 | `vitest` | `4.1.2` → `4.1.6` | Test runner patch. |
| #133 | `postcss` | `8.5.10` → `8.5.12` | Patch only, transitive devdep. |

## Tier 2 — merge individually, watch one CI cycle each (minor/major, low usage)

| PR | Package | Bump | Risk | Action |
|---|---|---|---|---|
| #126 | `pydantic` | `>=2.11.2` → `>=2.13.3` | Pydantic 2.13 tightened a couple of validator paths. We use plain `BaseModel` + `Field`; risk is low but non-zero. | Merge, watch `audit-backend` and `test-backend`. |
| #132 | `@supabase/supabase-js` | `2.102.1` → `2.105.1` | Minor bumps may shift `auth.onAuthStateChange` event ordering; we've been bitten by Supabase client minor bumps before. | Merge, then exercise login + auth callback locally on `localhost:5173` before close. |
| #139 | `softprops/action-gh-release` | `v2` → `v3` | Only used by `cli-release.yml`. v3 dropped legacy input names; check action README. | Merge with `cli-release.yml` dry-run via `workflow_dispatch` before next CLI tag. |
| #140 | `actions/download-artifact` | `v4` → `v8` | Skipping 4 majors. Several syntax changes (path/pattern). Only used by `qa-matrix.yml` + `weekly-oss-benchmarks.yml`. | Merge after `grep` confirms no removed options used. |
| #141 | `actions/upload-artifact` | `v4` → `v7` | Same as #140 — multiple major bumps, retention/path semantics changed. | Same: confirm no removed options, then merge. |

## Tier 3 — defer (major bumps with real surface area)

| PR | Package | Bump | Why defer | Plan |
|---|---|---|---|---|
| #124 | `stripe` | `>=8.0.0` → `>=15.1.0` | Superseded. Scoutpost no longer has an active Stripe webhook integration. | Remove the dependency instead of migrating the SDK. |
| #125 | `lucide-svelte` | `0.468.0` → `1.0.1` | 0.x → 1.0 — verify Svelte 5 runes compatibility, prop names, tree-shaking. Used across most UI components. | Hold until Svelte 5 stack is otherwise quiet. Manual smoke: render every page that imports a Lucide icon. Roll out behind a one-shot PR with screenshots. |
| #131 | `marked` | `17.0.5` → `18.0.2` | Major. Used in `UnitDrawer.svelte` and `BeatScoutView.svelte`. 17→18 changed renderer API. We have a custom `Renderer` in `BeatScoutView.svelte`. | Hold until someone has time to migrate the custom renderer. Test rendering of unit summaries with code/tables/links. |

## Closing the loop

This is a tracked decision, not a one-time backlog. When a Tier-3 PR is acted
on, supersede with a fresh PR off latest `main` rather than rebasing the
months-old dependabot branch — they accumulate stale conflicts otherwise.

If a Tier-3 PR is intentionally never going to be acted on, close it with a
comment explaining why and update the relevant `dependabot.yml` ignore list so
it stops resurfacing the same version every week.
