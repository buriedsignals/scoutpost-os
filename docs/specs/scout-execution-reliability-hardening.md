# Scout Execution Reliability Hardening

## Context

Scoutpost is now primarily a Supabase system: SvelteKit frontend, Supabase
Postgres, Edge Functions, pg_cron, Resend notifications, API keys, CLI, and MCP.
The AWS stack is no longer the main execution plane. Render remains residual and
should stay deliberately narrow until it is removed.

The AWS to Supabase migration was the right direction, but the current
execution architecture still has post-migration risk. Scout execution spans
scheduled dispatch, external scraping, LLM extraction, vector deduplication,
unit insertion, notification delivery, run lifecycle state, and failure
counters. These stages are not yet observed and classified consistently across
Page, Beat, Civic, and Social Scouts.

The pgvector search path incident after moving extensions into the `extensions`
schema showed the problem clearly: a shared unit path failed, but the observable
blast radius varied by scout type and error handling behavior.

## Goals

- Make every scout run terminal, inspectable, and comparable across scout types.
- Prevent platform errors from silently looking like "no findings."
- Keep alert delivery reliable and measurable.
- Preserve the current Supabase-first architecture while adding stronger job
  semantics, observability, and migration safety.
- Reduce residual Render ambiguity until it can be removed or explicitly owned.

## Non-Goals

- Do not move back to AWS EventBridge, Lambda, or DynamoDB.
- Do not introduce a second source of truth for scouts, runs, units, credits, or
  notification state.
- Do not rewrite all pipelines before adding observability and run lifecycle
  guarantees.

## Current Architecture Assessment

The current architecture is directionally correct:

- Supabase Postgres is the right source of truth.
- Edge Functions are appropriate for API, auth broker, MCP, CLI, and moderate
  IO-heavy orchestration.
- pg_cron is acceptable at the current schedule volume.
- CLI and MCP sharing the same REST surface is correct.
- OSS and hosted paths staying close is a strategic advantage.

The current weak point is operational rigor around execution:

- Page, Beat, Civic, and Social do not expose identical failure semantics.
- Some pipeline stages catch errors while others fail the run.
- Some failures increment scout failure counters even when caused by platform
  migration defects.
- Notification delivery is stored as a final boolean, but the path to that
  state is not decomposed enough for fast diagnosis.
- SQL function migrations that touch extensions, RLS, search paths, cron, or
  shared RPCs need production-like smoke tests before being considered done.

## Target Architecture

The target architecture remains Supabase-first:

```text
SvelteKit UI
  -> Supabase Edge Functions API
  -> durable scout run records
  -> scout-type workers
  -> shared extraction and canonical unit upsert
  -> Resend alert delivery
  -> CLI/MCP over the same API
```

Scout execution should behave like a durable job model even if implemented with
Edge Functions and Postgres tables:

- each run has a single authoritative lifecycle
- each stage records status, timing, and error class
- retries are idempotent
- notification send is separately observable
- platform failures are distinguishable from "no change" and "criteria did not
  match"

## Proposed Workstreams

### 1. Unified Run Lifecycle

Add a shared run-state contract used by every scout type.

Recommended fields:

- `status`: `queued`, `running`, `success`, `no_change`, `no_match`, `skipped`,
  `error`
- `stage`: `dispatch`, `scrape`, `diff`, `extract`, `dedup`, `insert_units`,
  `notify`, `credits`, `finalize`
- `error_class`: `platform`, `provider`, `auth`, `quota`, `validation`,
  `timeout`, `no_baseline`, `unknown`
- `error_message`: short human-readable detail
- `notification_status`: `not_applicable`, `pending`, `sent`, `skipped`,
  `failed`
- `units_created_count`
- `units_merged_count`
- `provider_request_id` or equivalent metadata where available

Acceptance criteria:

- Page, Beat, Civic, and Social all write the same lifecycle fields.
- A failed unit insert cannot be reported as a clean zero-finding success.
- Platform errors do not masquerade as no-change runs.

### 2. Shared Stage Instrumentation

Create a small shared helper for stage transitions.

Example API:

```ts
await markRunStage(svc, runId, "extract");
await markRunSuccess(svc, runId, {
  unitsCreated: 3,
  unitsMerged: 1,
  notificationStatus: "sent",
});
await markRunError(svc, runId, {
  stage: "dedup",
  errorClass: "platform",
  message: err.message,
});
```

Acceptance criteria:

- All scout workers use the helper.
- Failure counters are incremented only through the shared helper.
- Platform failures can be excluded from auto-pause or handled with a different
  threshold.

### 3. Notification Observability

Split "alert was possible" from "alert was sent."

Track:

- whether findings existed
- whether criteria matched
- whether notification was attempted
- Resend status
- Resend message id where available
- recipient lookup result
- user opt-out or missing email condition

Acceptance criteria:

- Every alert-capable run explains why `notification_sent` is true or false.
- Missing email, no findings, duplicate-only findings, Resend failure, and
  criteria miss are separate states.
- Notification failures are visible without reading Edge Function logs.

### 4. Durable Queue Semantics

Keep Supabase, but make the execution model more queue-like.

Recommended changes:

- central `scout_run_events` table for append-only stage events
- idempotency key per scout run and source item
- retry policy per stage
- explicit terminal-state reconciliation job
- separate provider callback state for Social and Civic queues

Acceptance criteria:

- A timed-out worker can be reconciled without guessing.
- Retrying a run cannot duplicate canonical units or duplicate email sends.
- Callback-driven Social/Civic jobs always resolve their linked `scout_runs`.

### 5. Migration Safety Gates

Any migration touching one of these areas needs a targeted smoke checklist:

- extensions
- vector columns or vector operators
- SQL functions/RPCs
- RLS
- function `search_path`
- pg_cron
- run lifecycle tables
- notification state

Required smoke tests:

- RPC smoke for vector operator resolution.
- Page Scout controlled diff smoke.
- Beat notification smoke.
- Civic notification smoke.
- Social notification smoke.
- Failure counter audit after the smoke window.

Acceptance criteria:

- The migration PR includes the smoke evidence.
- Production hotfixes are followed by a PR that records the applied migration.
- Existing active scouts are audited for failure counter damage after platform
  fixes.

### 6. Residual Render Boundary

Render should be kept only for explicitly documented residual responsibilities.

Acceptance criteria:

- Each remaining Render route has an owner and removal decision.
- No scout execution responsibility remains ambiguous between Render and
  Supabase.
- Public docs and agent setup point at the Supabase/Scoutpost API surface.

## Priority Plan

1. Add shared run lifecycle helpers and event table.
2. Normalize Page and Beat workers first because they are the highest-volume
   scheduled paths.
3. Normalize Civic and Social callback behavior so insert failures cannot hide.
4. Add dashboard/admin queries for unhealthy runs and notification failures.
5. Add migration smoke checklist to the deployment workflow.
6. Remove or explicitly document remaining Render responsibilities.

## Open Questions

- Should platform failures increment scout failure counters at all, or should
  they be tracked separately from user/source/provider failures?
- Should duplicate-only runs notify users in any scout type, or should they
  always remain silent?
- Should Social alerts be based on changed posts even if unit extraction fails,
  or should unit insertion remain the alert gate?
- Should Civic notify on merged recurring promises, or only newly created
  canonical promises?

## Success Criteria

Scoutpost is in the desired operating state when:

- every run has a clear terminal status and stage history
- alert absence is explainable from database state alone
- production smoke tests cover all scout types
- platform migration defects do not auto-pause user scouts
- support/debugging does not require manual log spelunking for normal failures
