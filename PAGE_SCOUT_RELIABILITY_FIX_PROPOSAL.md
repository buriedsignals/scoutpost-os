---
title: "fix: Repair three Page Scout audit failures"
type: fix
status: active
date: 2026-08-03
temporary: true
delete_after: "The three deployed checks in this proposal pass"
---

# Repair three Page Scout audit failures

> Temporary execution plan. Delete after the three deployed checks pass.

## Status

The bugs are diagnosed but not fixed. This proposal permits only changes that directly address:

1. Basel-Land measuring initial child following through units instead of captures.
2. Page benchmarks reading a legitimate transient `notification_status=pending`.
3. Neunkirch receiving artificially small OpenRouter request windows.

## Evidence

- The saved production report recorded Basel-Land as zero units and zero unit-source subpages, even though initial children are intentionally silent baselines.
- The executor writes `success/pending` before sending the email; the benchmark currently returns as soon as the content run becomes terminal.
- `evaluatePageScoutCriteria` divides the caller timeout by chunk count and two semantic stages. The shared OpenRouter client then reserves that reduced window across primary and fallback attempts. An injected two-chunk, 20-second probe produced four 5-second candidate/verifier budgets.

## Fix 1: Correct the Basel-Land benchmark

**Cause:** `benchmark-web.ts` uses units and unit source URLs as proof that listing children were followed. Initial children deliberately produce neither.

**Change:**

- In the Basel case, stop seeding a synthetic changed root baseline.
- Remove the initial unit-count and unit-source-subpage assertions for that case.
- Read existing `page_scout_coverage` metadata and same-run `raw_captures`.
- Pass only when:
  - at least one child candidate was discovered;
  - at least one child was checked;
  - no child source failed;
  - at least one same-run capture has a strict-descendant source URL; and
  - the notification is `skipped`.
- Leave discovery, filtering, child fetching, baseline behavior, and strict URL scope unchanged.

**Files:**

- `scripts/benchmarks/benchmark-web.ts`
- `scripts/benchmarks/_bench_shared.ts`
- `scripts/benchmarks/_bench_shared_test.ts`

**Focused test:** zero initial units with child coverage and a strict-descendant capture passes; zero checked children or zero child captures fails.

## Fix 2: Wait through transient notification state

**Cause:** `waitForScoutRun` returns on terminal content status without waiting for the subsequent notification status update.

**Change:**

- Add an opt-in positive-notification mode to the shared Page benchmark wait.
- After content becomes terminal, continue polling only while notification status is `pending`.
- Treat `sent`, `delivered`, and `delayed` as provider-accepted outcomes.
- Fail immediately on `failed`, `skipped`, `bounced`, `suppressed`, or `complained` for a positive case.
- Fail with the last status and reason if `pending` exceeds a short fixed grace period.
- Keep negative cases exact: they must still be `skipped`.
- Use this mode only for the positive cases in `benchmark-web.ts` and the matching/Any Change cases in `benchmark-subpage-follow.ts`.
- Do not change the executor, Resend submission, lifecycle persistence, or webhook processing.

**Files:**

- `scripts/benchmarks/_bench_shared.ts`
- `scripts/benchmarks/_bench_shared_test.ts`
- `scripts/benchmarks/benchmark-web.ts`
- `scripts/benchmarks/benchmark-subpage-follow.ts`

**Focused tests:** `pending → sent` passes; `pending → delivered` passes; persistent `pending` fails; `skipped` remains valid only for a negative case.

## Fix 3: Stop repeatedly dividing the criteria timeout

**Cause:** Page Scout criteria evaluation treats one caller budget as several independent smaller budgets before the shared OpenRouter client applies its own fallback reservation.

**Change:**

- In `evaluatePageScoutCriteria`, calculate one absolute deadline from the caller timeout.
- Before each existing request, calculate the remaining time. Give candidate generation a dynamic share that leaves time for its required verifier; give verifier requests the remaining bounded time. Pass both request ceilings through the existing OpenRouter client.
- Throw the existing fail-closed coverage error when no time remains.
- Keep current chunking, eight-batch cap, per-finding verification, schemas, model selection, fallback behavior, routing, and privacy controls unchanged.
- Do not modify the shared OpenRouter client.

**Files:**

- `supabase/functions/_shared/page_scout_criteria.ts`
- `supabase/functions/_shared/page_scout_criteria_test.ts`

**Focused tests:** a fake-clock candidate taking the observed 6.371 seconds still leaves time for verification inside the caller deadline instead of receiving the old roughly 5–6 second attempt fuse; a two-chunk path shares the same deadline; deadline exhaustion still fails closed; existing matching, rejection, noise, and fallback tests remain green.

## Explicitly out of scope

- Production crawler, discovery, URL-filter, or baseline changes.
- New Basel content-length thresholds or site-specific rules.
- Verifier batching, new candidate schemas, overflow policies, or early-stop behavior.
- Root/child failure-policy changes or new diagnostics frameworks.
- Notification idempotency, outboxes, lifecycle terminalizers, or resend recovery.
- Prompt redesign, new security work, database changes, or CI workflow rewiring.
- Scheduler, archive, credit, or unrelated benchmark changes.

If a targeted test disproves one of the three confirmed causes, stop and update this proposal before expanding implementation scope.

## Execution and verification

1. Add the focused regression tests and confirm they fail for the diagnosed reason.
2. Apply the three changes independently; run each focused test after its change.
3. Run the existing relevant Page Scout and OpenRouter tests without changing their expectations.
4. Push through the required Jujutsu branch and PR workflow; wait for the normal required checks and Edge Function tests.
5. Merge and deploy `scout-web-execute` from `main`.
6. From the merged checkout, run the deployed Page benchmark and confirm:
   - Basel-Land shows child coverage and child captures with zero required units;
   - Any Change and Specific Changes positives leave `pending` and reach a provider-accepted state; and
   - Neunkirch completes three runs without the criteria micro-timeout.
7. Run the existing weekly `benchmark (page)` job once and require it to pass.
8. Delete this proposal after all three deployed checks pass.

## Stop conditions

- Basel with zero candidates, zero checked children, child failures, or zero child captures remains a failure. Do not hide it by weakening the assertion or changing the crawler in this patch.
- A notification still `pending` after the grace period remains a failure. Do not mark it sent or add resend machinery in this patch.
- A Neunkirch timeout after removing nested division requires new evidence before changing verifier shape, models, or shared OpenRouter behavior.

## Done when

- Focused and existing regression tests pass.
- The normal PR, merge, and deployment workflow completes.
- Basel, positive notifications, and three Neunkirch runs pass against production.
- The weekly Page benchmark is green.
- This temporary file is deleted.
