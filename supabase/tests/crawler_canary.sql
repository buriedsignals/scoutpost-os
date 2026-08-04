BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(12);

SELECT is(
  (SELECT count(*) FROM public.scout_runs WHERE crawler_backend <> 'service'),
  0::bigint,
  'migration leaves every existing run on the current service'
);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000001121',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'crawler-pin@example.test', '',
  now(), now(), now()
);

INSERT INTO public.scouts (id, user_id, name, type, is_active, schedule_cron)
VALUES
  ('00000000-0000-4000-8000-000000001122', '00000000-0000-4000-8000-000000001121', 'Default pin', 'web', true, '1 8 * * *'),
  ('00000000-0000-4000-8000-000000001123', '00000000-0000-4000-8000-000000001121', 'Workflow pin', 'web', true, '2 8 * * *');

CREATE TEMP TABLE service_enqueue AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000001122', NULL, 'scheduled', 0
);
SELECT is(
  (SELECT crawler_backend FROM service_enqueue),
  'service',
  'default enqueue is pinned to the current crawler'
);

CREATE TEMP TABLE workflow_enqueue AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000001123', NULL, 'manual', 100, 'workflow'
);
SELECT is(
  (SELECT crawler_backend FROM workflow_enqueue),
  'workflow',
  'explicit selection is pinned atomically with queue admission'
);

CREATE TEMP TABLE coalesced AS
SELECT * FROM public.enqueue_scout_dispatch(
  '00000000-0000-4000-8000-000000001123', NULL, 'manual', 100, 'service'
);
SELECT is(
  (SELECT crawler_backend FROM coalesced),
  'workflow',
  'coalescing never changes the backend of an in-flight run'
);

SELECT is(
  (
    SELECT count(*) FROM public.scout_dispatch_queue q
    JOIN public.scout_runs r ON r.id = q.scout_run_id
    WHERE r.crawler_backend IS NULL
  ),
  0::bigint,
  'no queue claim can reference an unpinned crawler backend'
);

INSERT INTO public.crawler_batches (
  operation, status, render_task_run_id, render_metrics,
  render_metrics_checked_at, render_terminal, completed_at
) VALUES (
  'scrape', 'complete', 'trn-health',
  jsonb_build_object(
    'accepted_to_start_seconds', 2.5,
    'attempt_seconds', 120,
    'memory_peak_bytes', 104857600,
    'retry_count', 1,
    'outbound_bytes', 12345
  ),
  now(), true, now()
);

CREATE TEMP TABLE crawler_health AS
SELECT * FROM public.crawler_operations_health();
SELECT is((SELECT task_runs_24h FROM crawler_health), 1::bigint,
  'health reports Render task runs from refreshed metrics');
SELECT is((SELECT task_queue_p95_seconds FROM crawler_health), 2.5::double precision,
  'health reports Render queue p95');
SELECT is((SELECT task_duration_p95_seconds FROM crawler_health), 120::double precision,
  'health reports Render duration p95');
SELECT is((SELECT task_memory_peak_bytes FROM crawler_health), 104857600::bigint,
  'health reports Render task memory peak');
SELECT is((SELECT task_retry_rate FROM crawler_health), 1::double precision,
  'health reports Render retry rate');
SELECT is((SELECT task_outbound_bytes_24h FROM crawler_health), 12345::bigint,
  'health reports measured outbound bytes');
SELECT is(
  (SELECT round(estimated_monthly_compute_dollars::numeric, 6) FROM crawler_health),
  0.2::numeric,
  'health projects monthly compute from measured task seconds'
);

SELECT * FROM finish();
ROLLBACK;
