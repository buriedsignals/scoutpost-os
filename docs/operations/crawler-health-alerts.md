# Crawler health alert release and rollback

This change separates recognized retrieval failures from crawler workflow health.
It does not change task sizes, worker concurrency, deadlines, retries, scout state,
credits or user notifications. The shared crawler serves Page, Beat/Location,
Civic, imports and snapshots; this is not a Page-only monitor.

## Release order

1. Pass required CI and review the migration against the target schema.
2. Apply `20260921131350_crawler_retrieval_health.sql` before deploying
   `operations-monitor`. The dispatcher policy extraction preserves current
   behavior and needs no coordinated scheduler rollout.
3. Verify the service-role observation RPC returns schema version 1, a current
   timestamp and consistent counts. Verify anonymous/authenticated roles cannot
   execute it. Do not substitute zero counts if telemetry is unavailable.
4. Deploy `operations-monitor`; inspect the next five-minute check, incident
   records and notification delivery/acknowledgment. This may resolve an existing
   workflow incident while opening a retrieval incident; that is reclassification,
   not proof that retrievals recovered.

Known retrieval failures warn at 3 and become critical at 10 within one hour.
Mixed clusters retain workflow visibility when any failure is unclassified or
infrastructure-related. Queue and expired-lease alerts remain independent.
Caller-abandonment timestamps may reflect cleanup, not the original timeout.
Group details show only the top ten requested hostnames, not complete attribution.

## Rollback

Redeploy the previous monitor first. It can still use the unchanged
`crawler_operations_health()` RPC. Retain the additive schema and incident kind;
do not drop a constraint value while historical rows still use it.

The old monitor does not manage `crawler_retrieval_failures`. After confirming
the old monitor is writing the combined workflow observation, explicitly retire
that incident through the service-role writer with a summary such as
“Superseded by combined crawler workflow monitoring after rollback” and details
recording that reason, then acknowledge its pending notification. This is an
operator handoff, not evidence that the underlying failures recovered. Do not
send a generic recovery email for that administrative retirement.

No scout replay or reactivation is part of release or rollback. Any later
recovery action must inspect each scout's current state and avoid duplicate runs.

## Host memory

`crawler_operations_observation().blocked_hosts` counts hosts currently routed
away from crawl4ai by `scrape_host_policy`. A sudden rise across many hosts
points at the renderer or the anti-bot detector, not at the sites; inspect the
table before treating it as many independent blocks. Rows expire after fourteen
days and are cleared by any crawl4ai success for the host.
