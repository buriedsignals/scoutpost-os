# Crawler Workflow cutover

Use this runbook to move hosted Crawl4AI traffic from the temporary Render web
service to Render Workflows. It does not change Docker self-hosting.

## Preconditions

- The change is merged and required CI is green.
- The Page production burst and 100% out-of-cohort canary are recorded in the
  Render Workflows PRD.
- Save the current `SCRAPE_SERVICE_URL` as the rollback value. Do not copy
  bearer tokens into logs or documents.
- Before retirement, keep `scoutpost-scrape` healthy until the retirement gate
  is closed.

## Deploy without routing traffic

1. Apply `20260810144721_crawler_workflow_proxy.sql`.
2. Deploy `crawler-proxy` and `crawler-dispatch` from the merged revision.
3. Deploy the callers that bundle the updated shared client: `scouts`,
   `scout-web-execute`, `scout-beat-execute`, `beat-search`, `civic`,
   `civic-test`, `civic-execute`, `civic-extract-worker`, and `ingest`.
4. Confirm unauthenticated `GET /crawler-proxy/health` returns only
   `{status:"ok",backend:"render-workflows"}` and protected routes reject a
   missing or bad token.

## Direct canary — notifications impossible

Call the proxy directly with the existing bearer token and both server-owned
headers: `X-Scoutpost-Workload-Class: system` and a stable
`X-Scoutpost-Tenant-Key: system:operator-canary`. Workload mapping is fixed:

- scheduled Scout work: `scout` plus the verified user UUID (normal admission);
- user-triggered preview/ingest work: `utility` plus the verified user UUID;
- operator canaries: `system` plus a stable `system:<consumer>` key.

Run:

- one ordinary scrape against an owned static page;
- one snapshot scrape against an owned page and verify both hashes;
- one small known PDF and one non-PDF URL through `/parse`. The late non-PDF
  response is HTTP 200 with `_scoutpost_workflow_error.status=415`; the shared
  document client restores the logical legacy 415/fallback behavior.

Require exact response-contract parity, a terminal successful `proxy` job, a
real Render task ID, a one-job immediate batch, no retry or duplicate batch,
and removal of Storage artifacts after the bounded replay-retention window. Capture
`X-Scoutpost-Proxy-Request-Id` from the streamed response and join it exactly
to `crawler_jobs.continuation_key`:

```sql
SELECT id, status, batch_id, continuation_key
FROM public.crawler_jobs
WHERE continuation_key = '<X-Scoutpost-Proxy-Request-Id>';
```

These calls do not create Scout runs and cannot notify. Once streaming has
started, failures use the private HTTP-200 error envelope because status and
headers are already committed by heartbeat bytes. `_shared/scrape_crawl4ai.ts`
and `_shared/docparse.ts` translate that envelope back to the legacy logical
error semantics; it is not a public API contract.

## Hosted cutover and Scout canaries

1. Set `SCRAPE_SERVICE_URL` to
   `https://<project-ref>.supabase.co/functions/v1/crawler-proxy`. Keep
   `SCRAPE_SERVICE_TOKEN` unchanged.
2. Run one disposable Beat, Civic, and archive-enabled Page Scout with
   notifications explicitly disabled. Use owned or approved fixtures and
   clean them up after evidence capture.
3. Confirm each crawl has a `proxy` ledger row and real Workflow batch, the
   Scout result matches its existing contract, no email/event was emitted,
   and the old hosted service received no request.
4. Watch queue age, terminal failures, retries, fallbacks, duplicate effects,
   and oldest proxy artifact. Roll back on any new terminal class, contract
   mismatch, notification, or queue age approaching ten minutes.

## Rollback

After retirement, restore the `scoutpost-scrape` service definition from
[`scoutpost-scrape-recovery.render.yaml`](scoutpost-scrape-recovery.render.yaml)
to root `render.yaml` in a reviewed change and merge it. Set new Render and
Supabase `SCRAPE_SERVICE_TOKEN` values, verify authenticated `/scrape` and
`/parse` round-trips, then restore the saved `SCRAPE_SERVICE_URL` for
`scoutpost-scrape`. Do not route traffic to an unverified recovery service.

Do not delete ledger rows, batches, or in-flight artifacts; ordinary
reconciliation and the orphan sweeper own them. The schema and proxy can
remain deployed while the fault is diagnosed.

## Retirement gate

Remove the paid hosted web service only after all hosted consumers show zero
old-service traffic and run successfully at 100% for seven consecutive days,
including one Monday peak. Retain the HTTP adapter, Dockerfile, self-host
configuration, and tested recovery manifest.

### Closure record

The operator closed the gate on 2026-08-17 at 12:04 UTC after the Monday peak.
The [weekly live smoke](https://github.com/buriedsignals/scoutpost/actions/runs/32021113093)
completed successfully at 11:12 UTC and every hosted consumer was routed
through the Workflow proxy. The final hosted-consumer request to service
`srv-d95mb2favr4c73ajd02g` was `/scrape` at 2026-08-10 16:29:06 UTC; no hosted
`/parse` request arrived after cutover. Two requests on 2026-08-17 at 11:33 and
11:34 UTC were operator diagnostics, identified by their Deno user agent, and
were excluded from consumer traffic.

The exact 168-hour mark was 16:29:06 UTC; the operator explicitly accepted the
remaining 4 hours 25 minutes of observation-window risk and authorized
retirement. The HTTP adapter, Dockerfile, self-host configuration, and
validated recovery Blueprint remain in the repository.

## Page reliability rollout and operator replay

This rollout stays on Render Workflows. It does not restore the retired hosted
HTTP service, change customer URLs or schedules, or unpause customer Scouts.

Before applying `20260914131000_page_crawler_cancellation.sql`, stop new internal
Scout dispatch admission and let existing Page executions and their crawler jobs
finish. Record the internal cron rows before holding `drain-scout-dispatch`;
keep crawler dispatch and continuations running while those executions drain.
Queued, not-yet-started runs may remain queued. Do not proceed while an old Page
executor can still spend an unclaimed fallback. Once drained, hold the internal
crawler-dispatch schedule too. Leave individual `scout-<uuid>` schedules intact.

Apply the four `2026091413*` migrations in order. Release the reviewed Render
Workflow revision and deploy every affected Edge Function bundle, including
`scout-web-execute`, `crawler-worker` and `crawler-proxy`. Deploy the upgraded
`crawler-dispatch` last: it explicitly enables terminal-parent cancellation in
reconciliation. Restore the saved internal cron state only after confirming the
new schema and deployed versions. Do not roll back to an old unclaimed native
fallback caller against the new ownership contract.

Include the Beat executor and every caller of the changed shared modules in the
bundle deployment; do not deploy only the Page entrypoint. The release also
changes Page probing/creation and the MCP error contract. Verify the 150,000
normalized-character limit and the Beat all-stale, zero-net-credit outcome.
Retain the existing Page and Beat benchmark assertions and run their deployed
canaries. A local regression pass does not replace these deployment checks.

Verify the deployed paths with operator-owned canaries before customer replay:
ordinary HTML, a download response, a truthful invalid/error page, and exhausted
navigation-timeout recovery. Record job/batch IDs, actual Workflow revision,
attempts, queue wait, provider duration, served provider and terminal state.
Local tests or a standalone provider CLI response do not prove the deployed
native path.

Preview abandoned work with the service-role-only RPC:

```sql
SELECT * FROM public.cancel_terminal_page_crawler_jobs(
  p_limit := 100, p_apply := false
);
```

Inspect parent status, child/fallback status and both leases. Apply the same
bounded predicate with `p_apply := true`, then preview again. Cancellation
preserves attempts, errors, manifests and parent links; it does not delete jobs
or turn failed runs into successes. Active parents and live leases are excluded.

For an explicitly selected paused Page Scout, use a private preview path and
the service environment (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`):

```sh
deno run --allow-env --allow-net --allow-write --allow-run=jj \
  scripts/ops/replay-paused-web-scouts.ts preview \
  --scout-id "$SCOUT_ID" --output "$PREVIEW"
```

Repeat `--scout-id` for each approved candidate. The preview includes fixed run
IDs, original URLs, paused configuration, baseline capture snapshots, intended
writes and maximum credits. Record the current Render Workflow and affected
Edge Function deployment versions alongside it; `source_version` identifies
the local recorded commit, not a deployed version or uncommitted changes.
Obtain explicit approval for the total maximum credits and recheck deployment
versions before applying. Stop on deployment or configuration drift.

```sh
deno run --allow-env --allow-net --allow-read \
  scripts/ops/replay-paused-web-scouts.ts apply \
  --preview "$PREVIEW" --approve-maximum-credits "$APPROVED_MAXIMUM_CREDITS"
```

Apply keeps the Scouts paused and durably disables both change and deactivation
emails. Normal workflow persistence and idempotent charging/refunding remain
active. After a partial or uncertain submission, retry the same preview and
approval, not a new preview with new run IDs. A queued acknowledgement is not a
successful run: inspect final status, baseline eligibility, billing entries and
notification state separately. A still-invalid target remains a truthful error.
