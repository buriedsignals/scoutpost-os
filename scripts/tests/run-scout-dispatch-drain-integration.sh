#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI is required" >&2
  exit 2
fi
if ! command -v deno >/dev/null 2>&1; then
  echo "deno is required" >&2
  exit 2
fi

STATUS_ENV_FILE="$(mktemp /tmp/scout-dispatch-status.XXXXXX)"
cleanup() {
  rm -f "$STATUS_ENV_FILE"
}
trap cleanup EXIT

if ! supabase status -o env >/dev/null 2>&1; then
  supabase start
fi
supabase status -o env | awk '/^[A-Z_][A-Z0-9_]*=/' > "$STATUS_ENV_FILE"

# shellcheck disable=SC1090
source "$STATUS_ENV_FILE"

export SUPABASE_URL="${API_URL:?local API_URL missing}"
export SUPABASE_ANON_KEY="${ANON_KEY:?local ANON_KEY missing}"
export SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:?local SERVICE_ROLE_KEY missing}"
export SCOUT_DISPATCH_RUNTIME_SMOKE=1

deno test \
  --allow-env \
  --allow-net=127.0.0.1,localhost \
  --allow-import \
  supabase/functions/scout-dispatch-drain/_integration_test.ts
