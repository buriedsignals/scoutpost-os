---
title: Keep Scout Benchmarks On The Product Auth Path
date: 2026-06-03
category: docs/solutions/workflow-issues
module: benchmarks
problem_type: workflow_issue
component: testing_framework
severity: high
applies_when:
  - Changing Scoutpost benchmark scripts or weekly benchmark workflows
  - Adding a new scout-type benchmark or live health check
  - Debugging differences between local benchmark runs and GitHub weekly runs
  - Deciding whether a test belongs in the Scout health suite, worker smoke, or OSS Docker validation
tags: [benchmarks, authentication, supabase, scout-health, exa, oss]
---

# Keep Scout Benchmarks On The Product Auth Path

## Context

Scoutpost previously mixed several different health checks under the broad label "benchmarks": live scout-type checks, Apify actor diagnostics, page-subpage canaries, internal worker auth probes, smoke tests, offline QA checks, OSS Docker checks, and weekly GitHub runs. That made failures hard to reason about because some scripts used product user authentication while others required service-only secrets or local provider credentials.

The corrected model is: every scout-type benchmark should create and run real scouts through the same user-authenticated product surface used by the app, CLI, MCP, and public API. Internal worker auth remains valuable, but it is a separate smoke test because it validates service-to-service boundaries rather than the journalist workflow.

Service-role access may be used only to resolve or mint the benchmark owner session. Scout creation, Run Now, result inspection through product endpoints, and cleanup should use the temporary user session unless the operation is explicitly a database/admin setup step.

## Guidance

Use four categories and keep them separate:

| Category | Purpose | Representative files | Auth model |
| --- | --- | --- | --- |
| Scout health benchmarks | End-to-end health for Page, Beat, Civic, Social, and Fleet (transport) scouts | `scripts/benchmarks/benchmark-scout-suite.ts`, `scripts/benchmarks/benchmark-web.ts`, `scripts/benchmarks/benchmark-beat.ts`, `scripts/benchmarks/benchmark-civic.ts`, `scripts/benchmarks/benchmark-social.ts`, `scripts/benchmarks/benchmark-transport.ts`, `.github/workflows/weekly-scout-benchmarks.yml` | Benchmark owner resolved through Supabase Auth Admin, temporary user session for Edge Function calls |
| Internal worker smoke | Verify service-only functions reject missing/bad auth and accept valid internal service auth | `scripts/benchmarks/benchmark-internal-workers.ts` | `INTERNAL_SERVICE_KEY` plus Supabase target secrets |
| Offline QA matrix | Deterministic regression coverage that runs in CI without provider spend | `scripts/benchmarks/benchmark-qa-matrix.ts`, `.github/workflows/qa-matrix.yml` | No live Supabase user session required for the offline path |
| OSS Docker/open setup validation | Prove the open setup boots, migrates, serves functions, and supports minimal CLI/API use | `docs/oss/newsroom-docker-install.md`, external `scoutpost-os` workflow | Local/self-hosted Supabase setup |

Do not reintroduce separate weekly benchmark jobs for `page-subpage` or `apify-actors` as scout-type benchmarks. Page subpage following belongs inside the Page Scout benchmark as a canary. Social actor preview health belongs behind the deployed `/functions/v1/social-test` diagnostic because the deployed function owns Apify credentials and normalization.

Beat benchmark coverage must include Exa. The live Beat benchmark should fail if the deployed run never requests Exa, while still allowing Firecrawl fallback after low-coverage Exa detection. The current assertion is documented in `docs/supabase/benchmarks.md` and implemented in `scripts/benchmarks/benchmark-beat.ts`.

## Why This Matters

Benchmarks only answer the operational question they are designed to ask. If a scout-type benchmark uses internal service auth, it may pass while the product user path is broken. If a worker smoke is mixed into the weekly Scout health suite, it may fail because an internal secret is missing even though journalists can still create and run scouts. If OSS Docker validation is treated as equivalent to SaaS benchmarks, a hosted-provider regression can be hidden by a local setup pass, or vice versa.

Keeping the categories separate also clarifies secret ownership:

- GitHub weekly Scout health needs benchmark Supabase target/auth secrets.
- Provider secrets such as Firecrawl, Gemini, Exa, and Apify belong in deployed Supabase Edge Function secrets.
- `INTERNAL_SERVICE_KEY` is needed only for the optional internal worker smoke against remote service-only functions.

## When to Apply

- Adding or editing any file named `scripts/benchmarks/benchmark-*.ts`.
- Editing `.github/workflows/weekly-scout-benchmarks.yml` or `.github/workflows/qa-matrix.yml`.
- Investigating historical benchmark issues such as failed Page, Beat, Civic, Social, page-subpage, or apify-actors runs.
- Deciding whether a new diagnostic should run locally before PRs, weekly in GitHub, or only manually.

## Examples

Correct weekly Scout health shape:

```yaml
matrix:
  include:
    - name: page
      command: deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-web.ts
    - name: beat
      command: deno run --allow-env --allow-net --allow-read=. scripts/benchmarks/benchmark-beat.ts
    - name: civic
      command: deno run --allow-env --allow-net --allow-read=. --allow-write=scripts/reports scripts/benchmarks/benchmark-civic.ts
    - name: social
      command: deno run --allow-env --allow-net --allow-read=. --allow-write=scripts/reports scripts/benchmarks/benchmark-social.ts
```

Correct local dry-run shape before live execution:

```bash
deno run --allow-env --allow-run --allow-read=. scripts/benchmarks/benchmark-scout-suite.ts --dry-run
deno run --allow-env scripts/benchmarks/benchmark-qa-matrix.ts
deno run --allow-read scripts/benchmarks/benchmark-beat-offline.ts
```

Incorrect pattern:

```text
Add INTERNAL_SERVICE_KEY to the weekly Scout health suite because Civic execution eventually calls service-only workers.
```

That conflates product-path health with worker auth. Civic Scout health should create and run the Civic Scout through user-authenticated public functions, then observe queue/promises evidence. The separate worker smoke can verify that service-only functions enforce `X-Service-Key`.

## Related

- `docs/supabase/benchmarks.md`
- `.github/workflows/weekly-scout-benchmarks.yml`
- `.github/workflows/qa-matrix.yml`
- `scripts/benchmarks/_bench_shared.ts`
- `scripts/benchmarks/benchmark-scout-suite.ts`
- `scripts/benchmarks/benchmark-internal-workers.ts`
