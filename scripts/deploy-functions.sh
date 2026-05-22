#!/usr/bin/env bash
# Deploy all v2 Edge Functions to a Supabase project.
# Pre-requisite: `supabase login` (interactive — one time).
#
#   bash scripts/deploy-functions.sh
#
set -euo pipefail

PROJECT_REF="${PROJECT_REF:-}"
if [ -z "$PROJECT_REF" ]; then
  echo "Set PROJECT_REF to the target Supabase project ref before deploying functions." >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Deploy every local function directory that has an index.ts. Keeping this
# derived from the filesystem prevents new functions from being omitted here.
FUNCTIONS=()
while IFS= read -r index_file; do
  FUNCTIONS+=("$(basename "$(dirname "$index_file")")")
done < <(find supabase/functions -mindepth 2 -maxdepth 2 -name index.ts | sort)

# Functions that already have a [functions.X] block with verify_jwt=false in
# supabase/config.toml will carry that setting. Everything else defaults to
# verify_jwt=true. All our handlers validate auth internally, so verify_jwt
# stays off for all of them (see migration CLAUDE notes).

ok=()
fail=()

for fn in "${FUNCTIONS[@]}"; do
  printf '\n=== deploying %s ===\n' "$fn"
  if supabase functions deploy "$fn" \
       --project-ref "$PROJECT_REF" \
       --no-verify-jwt 2>&1 | tail -5; then
    ok+=("$fn")
  else
    fail+=("$fn")
  fi
done

printf '\n=== summary ===\n'
printf '  ok:     %s\n' "${#ok[@]}"
printf '  failed: %s\n' "${#fail[@]}"
if [ "${#fail[@]}" -gt 0 ]; then
  printf '\nfailed:\n'
  for f in "${fail[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi
