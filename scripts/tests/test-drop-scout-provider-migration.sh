#!/usr/bin/env bash
set -euo pipefail

readonly DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_cojournalist}"
readonly PREVIOUS_MIGRATION="20260810144721"
readonly TARGET_MIGRATION="20260810163009"
readonly USER_ID="11111111-1111-4111-8111-111111111111"
readonly SCOUT_ID="22222222-2222-4222-8222-222222222222"
readonly LINKED_SCOUT_ID="33333333-3333-4333-8333-333333333333"
readonly FILTERED_SCOUT_ID="66666666-6666-4666-8666-666666666666"
readonly FAILED_RUN_ID="44444444-4444-4444-8444-444444444444"
readonly SUCCESS_RUN_ID="55555555-5555-4555-8555-555555555555"

provider_column_exists() {
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -Atc \
    "SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'scouts'
         AND column_name = 'provider'
     );"
}

expect_migration_rejected() {
  local failure_output
  local failure_status

  set +e
  failure_output="$(supabase migration up --local 2>&1)"
  failure_status=$?
  set -e

  if [[ "$failure_status" -eq 0 ]]; then
    echo "provider cleanup unexpectedly accepted an unready active Page Scout" >&2
    exit 1
  fi

  if [[ "$failure_output" != *"cannot drop scouts.provider while an active Page Scout lacks a current canonical baseline"* ]]; then
    echo "$failure_output" >&2
    echo "provider cleanup failed for an unexpected reason" >&2
    exit 1
  fi

  if [[ "$(provider_column_exists)" != "t" ]]; then
    echo "failed provider cleanup did not preserve the provider column" >&2
    exit 1
  fi
}

rollback_count=0
target_seen=false
for migration_file in supabase/migrations/*.sql; do
  migration_name="${migration_file##*/}"
  if [[ "$migration_name" == "${TARGET_MIGRATION}_"* ]]; then
    target_seen=true
  fi
  if [[ "$target_seen" == true ]]; then
    rollback_count=$((rollback_count + 1))
  fi
done

if [[ "$rollback_count" -eq 0 ]]; then
  echo "could not locate provider cleanup migration $TARGET_MIGRATION" >&2
  exit 1
fi

# `db reset --version` is parsed as the CLI's global version flag by some
# Supabase CLI releases. `migration down` rebuilds to the same prior point and
# remains stable when later migrations are appended.
supabase migration down --local --last "$rollback_count" --yes

latest_applied="$(
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -Atc \
    "SELECT version
     FROM supabase_migrations.schema_migrations
     ORDER BY version DESC
     LIMIT 1;"
)"

if [[ "$latest_applied" != "$PREVIOUS_MIGRATION" ]]; then
  echo "migration rollback stopped at $latest_applied, expected $PREVIOUS_MIGRATION" >&2
  exit 1
fi

docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  INSERT INTO auth.users (id) VALUES ('$USER_ID');
  INSERT INTO public.scouts (
    id, user_id, name, type, url, is_active, schedule_cron
  ) VALUES (
    '$SCOUT_ID', '$USER_ID', 'provider-drop-test', 'web',
    'https://example.test/root', true, '0 9 * * *'
  );
"

expect_migration_rejected

docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  INSERT INTO public.raw_captures (
    user_id, scout_id, source_url,
    canonical_content_sha256, canonicalizer_version
  ) VALUES (
    '$USER_ID', '$SCOUT_ID', 'https://example.test/root',
    'test-canonical-sha256', 'web-md-v1'
  );

  INSERT INTO public.scouts (
    id, user_id, name, type, url, is_active, schedule_cron
  ) VALUES (
    '$LINKED_SCOUT_ID', '$USER_ID', 'provider-drop-linked-test', 'web',
    'https://example.test/linked', true, '0 10 * * *'
  );

  INSERT INTO public.scout_runs (id, scout_id, user_id, status)
  VALUES ('$FAILED_RUN_ID', '$LINKED_SCOUT_ID', '$USER_ID', 'error');

  INSERT INTO public.raw_captures (
    user_id, scout_id, scout_run_id, source_url,
    canonical_content_sha256, canonicalizer_version
  ) VALUES (
    '$USER_ID', '$LINKED_SCOUT_ID', '$FAILED_RUN_ID',
    'https://example.test/linked', 'failed-run-canonical-sha256', 'web-md-v1'
  );

  INSERT INTO public.scouts (
    id, user_id, name, type, url, is_active, schedule_cron
  ) VALUES (
    '$FILTERED_SCOUT_ID', '$USER_ID', 'provider-drop-filter-test', 'web',
    'https://example.test/filtered', true, '0 11 * * *'
  );

  INSERT INTO public.raw_captures (
    user_id, scout_id, source_url,
    canonical_content_sha256, canonicalizer_version
  ) VALUES
    (
      '$USER_ID', '$FILTERED_SCOUT_ID', 'https://example.test/not-the-root',
      'wrong-url-canonical-sha256', 'web-md-v1'
    ),
    (
      '$USER_ID', '$FILTERED_SCOUT_ID', 'https://example.test/filtered',
      'wrong-version-canonical-sha256', 'legacy-web-md-v0'
    ),
    (
      '$USER_ID', '$FILTERED_SCOUT_ID', 'https://example.test/filtered',
      NULL, 'web-md-v1'
    );
"

expect_migration_rejected

docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  INSERT INTO public.scout_runs (id, scout_id, user_id, status)
  VALUES ('$SUCCESS_RUN_ID', '$LINKED_SCOUT_ID', '$USER_ID', 'success');

  INSERT INTO public.raw_captures (
    user_id, scout_id, scout_run_id, source_url,
    canonical_content_sha256, canonicalizer_version
  ) VALUES (
    '$USER_ID', '$LINKED_SCOUT_ID', '$SUCCESS_RUN_ID',
    'https://example.test/linked', 'successful-run-canonical-sha256', 'web-md-v1'
  );
"

expect_migration_rejected

docker exec "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  INSERT INTO public.raw_captures (
    user_id, scout_id, source_url,
    canonical_content_sha256, canonicalizer_version
  ) VALUES (
    '$USER_ID', '$FILTERED_SCOUT_ID', 'https://example.test/filtered',
    'matching-root-version-canonical-sha256', 'web-md-v1'
  );
"

supabase migration up --local

if [[ "$(provider_column_exists)" != "f" ]]; then
  echo "provider cleanup did not remove the provider column after baseline repair" >&2
  exit 1
fi

echo "provider cleanup migration reject/allow paths passed"
