-- Keep each post's publish time in Social Scout baselines.
--
-- normalize_social_baseline_posts (20260821044500) rewrote every baseline to
-- bare {"id"} objects, which also dropped the publish time apify-callback now
-- writes. Without it, a post that ages out of a capped actor result cannot be
-- told apart from a deleted one (social_baseline.ts removalTest). Only a
-- strict ISO-8601 UTC timestamp is kept; captions, images and URLs are still
-- removed. The trigger and grants are unchanged.

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
    jsonb_agg(
      jsonb_build_object('id', identity)
        || CASE WHEN published IS NOT NULL
             THEN jsonb_build_object('timestamp', published)
             ELSE '{}'::jsonb
           END
      ORDER BY first_ordinal
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT
      identity,
      min(ordinal) AS first_ordinal,
      (array_agg(published ORDER BY ordinal)
        FILTER (WHERE published IS NOT NULL))[1] AS published
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
        END AS identity,
        -- Publish time only, in the exact ISO form the Edge writers emit;
        -- removal detection needs it and it carries no post content.
        CASE
          WHEN jsonb_typeof(post) = 'object'
            AND jsonb_typeof(post -> 'timestamp') = 'string'
            AND (post ->> 'timestamp') ~
              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
            THEN post ->> 'timestamp'
          ELSE NULL
        END AS published
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
