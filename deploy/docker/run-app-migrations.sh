#!/usr/bin/env bash
set -euo pipefail

# Apply every ordered Scoutpost migration exactly once. This runner uses the
# same history table as Supabase CLI so later `supabase db push --db-url ...`
# calls continue from the correct version.

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
PSQL_BIN="${PSQL_BIN:-psql}"
MIGRATION_WAIT_SECONDS="${MIGRATION_WAIT_SECONDS:-2}"
MIGRATION_WAIT_ATTEMPTS="${MIGRATION_WAIT_ATTEMPTS:-60}"

psql_db() {
  PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" \
    "${PSQL_BIN}" -X \
    -h "${POSTGRES_HOST:-db}" \
    -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-postgres}" \
    "$@"
}

attempt=1
until [[ "$(psql_db -Atqc "SELECT to_regclass('auth.users') IS NOT NULL")" == "t" ]]; do
  if (( attempt >= MIGRATION_WAIT_ATTEMPTS )); then
    echo "auth.users was not ready after ${MIGRATION_WAIT_ATTEMPTS} attempts" >&2
    exit 1
  fi
  echo "Waiting for GoTrue database migrations (${attempt}/${MIGRATION_WAIT_ATTEMPTS})..."
  sleep "${MIGRATION_WAIT_SECONDS}"
  attempt=$((attempt + 1))
done

psql_db -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version TEXT PRIMARY KEY,
  statements TEXT[],
  name TEXT
);
SQL

found=0
for migration in "${MIGRATIONS_DIR}"/[0-9]*_*.sql; do
  [[ -f "${migration}" ]] || continue
  found=1
  filename="$(basename "${migration}")"
  version="${filename%%_*}"
  name="${filename#*_}"
  name="${name%.sql}"

  applied="$(psql_db -At -v "version=${version}" <<'SQL'
SELECT EXISTS (
  SELECT 1
  FROM supabase_migrations.schema_migrations
  WHERE version = :'version'
);
SQL
)"
  if [[ "${applied}" == "t" ]]; then
    echo "Skipping ${filename} (already applied)"
    continue
  fi

  echo "Applying ${filename}"
  psql_db -v ON_ERROR_STOP=1 -f "${migration}"
  psql_db -v ON_ERROR_STOP=1 \
    -v "version=${version}" \
    -v "name=${name}" <<'SQL'
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES (:'version', :'name')
ON CONFLICT (version) DO NOTHING;
SQL
done

if (( found == 0 )); then
  echo "No migration files found in ${MIGRATIONS_DIR}" >&2
  exit 1
fi

echo "All Scoutpost migrations are applied."
