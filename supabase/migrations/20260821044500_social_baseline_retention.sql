-- Minimize Social Scout comparison baselines and retire inactive baselines.

CREATE OR REPLACE FUNCTION public.normalize_social_baseline_posts(
  p_platform text,
  p_posts jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object('id', identity) ORDER BY first_ordinal),
    '[]'::jsonb
  )
  FROM (
    SELECT identity, min(ordinal) AS first_ordinal
    FROM (
      SELECT
        ordinal,
        CASE
          WHEN jsonb_typeof(post) IN ('string', 'number') THEN
            nullif(regexp_replace(
              CASE jsonb_typeof(post)
                WHEN 'string' THEN post #>> '{}'
                WHEN 'number' THEN
                  CASE
                    WHEN (post #>> '{}')::numeric = trunc((post #>> '{}')::numeric)
                      AND (post #>> '{}')::numeric BETWEEN -9007199254740991 AND 9007199254740991
                      THEN trunc((post #>> '{}')::numeric)::text
                    ELSE NULL
                  END
                ELSE NULL
              END,
              '^[[:space:]]+|[[:space:]]+$', '', 'g'
            ), '')
          WHEN jsonb_typeof(post) = 'object' THEN (
            SELECT nullif(regexp_replace(
              CASE jsonb_typeof(post -> field)
                WHEN 'string' THEN post ->> field
                WHEN 'number' THEN
                  CASE
                    WHEN (post ->> field)::numeric = trunc((post ->> field)::numeric)
                      AND (post ->> field)::numeric BETWEEN -9007199254740991 AND 9007199254740991
                      THEN trunc((post ->> field)::numeric)::text
                    ELSE NULL
                  END
                ELSE NULL
              END,
              '^[[:space:]]+|[[:space:]]+$', '', 'g'
            ), '')
            FROM unnest(
              CASE lower(coalesce(p_platform, ''))
                WHEN 'instagram' THEN ARRAY[
                  'shortcode', 'shortCode', 'id', 'pk', 'postId',
                  'post_id', 'url'
                ]
                WHEN 'x' THEN ARRAY['id', 'conversationId', 'url']
                WHEN 'facebook' THEN ARRAY[
                  'postId', 'post_id', 'id', 'url'
                ]
                WHEN 'linkedin' THEN ARRAY[
                  'id', 'entityId', 'linkedinUrl'
                ]
                WHEN 'tiktok' THEN ARRAY[
                  'aweme_id', 'id', 'videoId', 'url', 'share_url',
                  'webVideoUrl'
                ]
                ELSE ARRAY[
                  'shortcode', 'shortCode', 'id', 'pk', 'postId',
                  'post_id', 'url', 'conversationId', 'entityId',
                  'linkedinUrl', 'aweme_id', 'videoId', 'share_url',
                  'webVideoUrl'
                ]
              END
            ) WITH ORDINALITY AS identity_fields(field, priority)
            WHERE CASE jsonb_typeof(post -> field)
              WHEN 'string' THEN true
              WHEN 'number' THEN
                (post ->> field)::numeric = trunc((post ->> field)::numeric)
                AND (post ->> field)::numeric BETWEEN -9007199254740991 AND 9007199254740991
              ELSE false
            END
            ORDER BY priority
            LIMIT 1
          )
          ELSE NULL
        END AS identity
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(p_posts) = 'array' THEN p_posts
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS entries(post, ordinal)
    ) extracted
    WHERE identity IS NOT NULL
    GROUP BY identity
  ) unique_identities;
$$;

REVOKE EXECUTE ON FUNCTION public.normalize_social_baseline_posts(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_social_baseline_posts(text, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.normalize_post_snapshot_baseline()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.posts := public.normalize_social_baseline_posts(NEW.platform, NEW.posts);
  NEW.post_count := jsonb_array_length(NEW.posts);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_post_snapshot_baseline
  ON public.post_snapshots;
CREATE TRIGGER trg_normalize_post_snapshot_baseline
BEFORE INSERT OR UPDATE OF posts, platform, post_count ON public.post_snapshots
FOR EACH ROW EXECUTE FUNCTION public.normalize_post_snapshot_baseline();

-- Rewrite the pre-migration population in bounded batches. The trigger already
-- protects concurrent legacy writers, and the high-water mark keeps this loop
-- finite if new rows arrive during the migration.
DO $$
DECLARE
  v_high_water uuid;
  v_last_id uuid;
  v_batch_ids uuid[];
BEGIN
  SELECT id
    INTO v_high_water
    FROM public.post_snapshots
   ORDER BY id DESC
   LIMIT 1;

  LOOP
    SELECT array_agg(id ORDER BY id)
      INTO v_batch_ids
      FROM (
        SELECT id
          FROM public.post_snapshots
         WHERE (v_last_id IS NULL OR id > v_last_id)
           AND id <= v_high_water
         ORDER BY id
         LIMIT 10000
      ) batch;

    EXIT WHEN coalesce(cardinality(v_batch_ids), 0) = 0;

    UPDATE public.post_snapshots
       SET posts = posts
     WHERE id = ANY(v_batch_ids);

    v_last_id := v_batch_ids[cardinality(v_batch_ids)];
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_scouts_inactive_social_updated_at
  ON public.scouts(updated_at, id)
  WHERE type = 'social' AND is_active = false;

CREATE OR REPLACE FUNCTION public.prepare_social_scout_resume(
  p_scout_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_baseline_established_at timestamptz;
  v_snapshot_exists boolean;
BEGIN
  SELECT scout.baseline_established_at
    INTO v_baseline_established_at
    FROM public.scouts AS scout
   WHERE scout.id = p_scout_id
     AND scout.user_id = p_user_id
     AND scout.type = 'social'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'social scout not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.post_snapshots AS snapshot
     WHERE snapshot.scout_id = p_scout_id
  ) INTO v_snapshot_exists;

  UPDATE public.scouts
     SET updated_at = now(),
         baseline_established_at = CASE
           WHEN v_snapshot_exists THEN baseline_established_at
           ELSE NULL
         END
   WHERE id = p_scout_id;

  RETURN NOT v_snapshot_exists OR v_baseline_established_at IS NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prepare_social_scout_resume(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_social_scout_resume(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_inactive_post_snapshots(
  p_limit integer DEFAULT 10000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 10000), 10000));
  v_deleted integer;
BEGIN
  WITH candidates AS MATERIALIZED (
    SELECT
      scout.id AS scout_id,
      snapshot.id AS snapshot_id
      FROM public.post_snapshots AS snapshot
      JOIN public.scouts AS scout ON scout.id = snapshot.scout_id
     WHERE scout.type = 'social'
       AND scout.is_active = false
       AND scout.updated_at <= now() - interval '90 days'
     ORDER BY scout.updated_at, snapshot.id
     LIMIT v_limit
     FOR UPDATE OF scout, snapshot SKIP LOCKED
  ), cleared AS (
    UPDATE public.scouts AS scout
       SET baseline_established_at = NULL
      FROM candidates
     WHERE scout.id = candidates.scout_id
       AND scout.type = 'social'
       AND scout.is_active = false
       AND scout.updated_at <= now() - interval '90 days'
     RETURNING candidates.snapshot_id
  ), deleted AS (
    DELETE FROM public.post_snapshots AS snapshot
     USING cleared
     WHERE snapshot.id = cleared.snapshot_id
     RETURNING snapshot.id
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;

  RETURN v_deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_inactive_post_snapshots(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_inactive_post_snapshots(integer)
  TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-inactive-post-snapshots')
    WHERE EXISTS (
      SELECT 1 FROM cron.job
       WHERE jobname = 'cleanup-inactive-post-snapshots'
    );

  PERFORM cron.schedule(
    'cleanup-inactive-post-snapshots',
    '45 3 * * *',
    'SELECT public.cleanup_inactive_post_snapshots()'
  );
END;
$$;
