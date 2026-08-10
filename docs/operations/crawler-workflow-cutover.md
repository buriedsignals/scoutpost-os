# Crawler Workflow cutover

Use this runbook to move hosted Crawl4AI traffic from the temporary Render web
service to Render Workflows. It does not change Docker self-hosting.

## Preconditions

- The change is merged and required CI is green.
- The Page production burst and 100% out-of-cohort canary are recorded in the
  Render Workflows PRD.
- Save the current `SCRAPE_SERVICE_URL` as the rollback value. Do not copy
  bearer tokens into logs or documents.
- Keep `scoutpost-scrape` healthy until the retirement gate passes.

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
and removal of consumed Storage artifacts. Capture
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

Restore the saved `SCRAPE_SERVICE_URL` for `scoutpost-scrape`. Do not delete
ledger rows, batches, or in-flight artifacts; ordinary reconciliation and the
orphan sweeper own them. The schema and proxy can remain deployed while the
fault is diagnosed.

## Retirement gate

Remove the paid hosted web service only after all hosted consumers show zero
old-service traffic and run successfully at 100% for seven consecutive days,
including one Monday peak. Retain the HTTP adapter, Dockerfile, self-host
configuration, and tested recovery manifest.
