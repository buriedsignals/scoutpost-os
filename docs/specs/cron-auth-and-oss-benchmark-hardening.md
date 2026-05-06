# Cron Auth and OSS Benchmark Hardening

## Summary

Determine and remove the remaining risk from the May 1 failure mode by making cron-to-Edge auth independent of Supabase service-role secret shape, then reduce OSS benchmark cost so live audits cannot accidentally burn production Firecrawl/newsroom credits.

Current assessment: something is still necessary before this is safe.

Verified locally/remotely during planning:

- Remote Supabase has migration `00053` applied.
- Remote Edge secrets include `INTERNAL_SERVICE_KEY`.
- Remote `execute-scout` accepts the currently loaded short service-role bearer key: probing with a fake scout returned `404`, meaning auth passed.
- Remote `execute-scout` with local `X-Service-Key` returned `401`.
- Remote `scout-beat-execute` and `scout-web-execute` with local `X-Service-Key` returned `401`.
- Local `.env` has duplicate `SUPABASE_SERVICE_ROLE_KEY`; the later value is the short `sb_secret_...` form, matching the drift pattern.
- The current tracked migration intends to move DB cron to `X-Service-Key`, but the current `execute-scout` source still gates cron-style requests on service-role bearer or user JWT.

## Key Changes

- Update `execute-scout` to accept `X-Service-Key` via shared `requireServiceKey()` in addition to user JWT for browser-triggered runs.
- Update internal dispatcher calls so `execute-scout -> scout-*` sends `X-Service-Key: INTERNAL_SERVICE_KEY`; keep service-role bearer fallback only for operator tooling where already supported.
- Align `scout-web-execute` with the other worker functions by using shared `requireServiceKey()` rather than exact service-role bearer only.
- Add a redacted production verification query/runbook that checks:
  - migration `00053` is applied,
  - Vault has `project_url` and `internal_service_key`,
  - active `cron.job.command` rows contain `X-Service-Key`,
  - no active scout cron rows still contain `Authorization: Bearer`.
- Simplify OSS beat benchmark defaults:
  - default to fixture/dry-run or non-live contract smoke,
  - require explicit `COJO_LIVE_BENCHMARK=1` for live Firecrawl/Gemini paths,
  - reduce live beat scenarios to 1-2,
  - set attempts to 1,
  - use only the `news` preview category by default,
  - refuse production Supabase or production Firecrawl unless a second override is set.

## Test Plan

- Unit-test `requireServiceKey()` accepted paths: matching `X-Service-Key`, service-role bearer fallback, bad key rejected.
- Edge function tests:
  - `execute-scout` accepts `X-Service-Key` and reaches scout lookup,
  - `execute-scout` still accepts valid user JWT for run-now flow,
  - `scout-web-execute` accepts `X-Service-Key`.
- Run Deno/Supabase function tests for changed functions.
- Run benchmark script in default OSS mode and confirm it does not call live Firecrawl/Gemini.
- Run one explicit live benchmark against a non-production project/key only.

## Assumptions

- The desired long-term boundary is `X-Service-Key` from DB Vault to Edge Functions, not Supabase service-role bearer.
- Service-role bearer remains acceptable as an operator/tooling fallback, but cron should not depend on it.
- OSS benchmarks should be cheap and safe by default; full live audits are internal/operator-only.
