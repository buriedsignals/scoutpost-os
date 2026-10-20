---
title: Disk IO Budget Drained By pg_net And pg_cron System Tables
date: 2026-10-20
category: docs/solutions/performance-issues
module: supabase
problem_type: performance_issue
component: database
severity: high
applies_when:
  - Edge Functions or benchmarks fail with "canceling statement due to statement timeout"
  - Supabase emails that the project is depleting its Disk IO Budget
  - Writes (unit inserts, scout deletes, civic persistence, webhooks) time out together
tags: [supabase, disk-io, pg_net, pg_cron, statement-timeout, benchmarks]
---

# Disk IO Budget Drained By pg_net And pg_cron System Tables

## Symptom

The 2026-10-19 weekly benchmark failed its page, page-scheduler and civic legs.
Render crawler fetches all succeeded; every failure was a Postgres
`canceling statement due to statement timeout` (the `authenticated` role has an
8 s timeout) in `scout-web-execute`, the `scouts` API, Beat unit inserts,
`civic-extract-worker` and `resend-webhook`. Supabase then emailed that the
project (Small compute) was depleting its Disk IO Budget. Timeouts had been
appearing daily around 08:00 UTC, when 322 of 434 scout schedules fire on
Mondays.

## Cause

Two system tables nobody trims:

- `net._http_response` was 804 MB holding about 1,700 rows. pg_net's own TTL
  cleanup (`DELETE FROM net._http_response ... ORDER BY created LIMIT`) runs
  every few seconds and had read 22.3 billion shared blocks since January,
  roughly 500× the next query in `pg_stat_statements`.
- `cron.job_run_details` had no retention: 731k rows, 948 MB, since April.
  Table statistics still claimed 4,656 rows because they were last refreshed in
  April; count the rows instead of trusting `pg_stat_user_tables`.

## Fix (2026-10-20)

- One-off, in a single transaction: `TRUNCATE net._http_response` (nothing
  reads it; pg_net expires rows after 6 hours), and for `cron.job_run_details`
  copy the last 7 days to a temp table, `TRUNCATE`, re-insert. The database went
  from 2,247 MB to 531 MB.
- Migration `20261020111119`: daily `cleanup-cron-job-run-details` (03:55)
  keeps 7 days (see `docs/supabase/retention.md`).
- Weekly benchmarks moved to Wednesday.
- Leftover `bench-*` scouts whose cleanup had also timed out were deleted with
  `delete_scout_with_schedule`; four of them were still running daily.
- `pg_stat_statements` was reset at 12:02 UTC for a clean re-measure.

## Diagnosing next time

- Edge and Postgres logs: Management API
  `GET /v1/projects/<ref>/analytics/endpoints/logs` with ClickHouse SQL,
  `FROM logs WHERE source = 'postgres_logs'` (or `function_logs`); nested fields
  via `log_attributes['parsed.query']`. The older `logs.all` endpoint was
  removed on 2026-09-23. Query one day at a time; long ranges are clamped.
- Heaviest disk readers:
  `SELECT calls, shared_blks_read, left(query, 120) FROM extensions.pg_stat_statements ORDER BY shared_blks_read DESC LIMIT 10;`
- Table size versus real row count for `net._http_response` and
  `cron.job_run_details`.
- Dashboard: Observability → Database Health → Disk IO % consumed. Checkpoint
  `write=` times of about 0.1 s per buffer are normal Postgres pacing, not
  evidence of throttling.

If Disk IO % consumed still drains after these tables stay small, the next step
is Small → Medium compute (22 → 39 MB/s and 1,000 → 2,000 IOPS baseline; see
Supabase "Compute and disk").
