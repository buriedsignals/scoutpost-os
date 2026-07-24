#!/usr/bin/env bash
# e2e-smoke.sh — post-cutover smoke test.
# Exercises the v2 Edge Function surface against a deployed Supabase project
# using a pre-issued user JWT. Intended to run at step 8 of the cutover window.
#
# Usage:
#   SUPABASE_URL=https://<ref>.supabase.co \
#   USER_JWT=<access token> \
#   bash scripts/ops/e2e-smoke.sh
#
# Optional:
#   TEST_SCOUT_URL=https://example.com  (URL a Page Scout can hit)
#   SKIP_LIVE=1                          (skip Firecrawl/Gemini-gated calls)
#
set -euo pipefail

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${USER_JWT:?USER_JWT is required}"

SCOUT_URL="${TEST_SCOUT_URL:-https://example.com}"
H=(-H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json")
FAIL=0

say() { printf '\n=== %s ===\n' "$1"; }

check() {
  local name="$1"; local expected="$2"; local actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ok   %-40s (%s)\n' "$name" "$actual"
  else
    printf '  FAIL %-40s expected %s, got %s\n' "$name" "$expected" "$actual"
    FAIL=$((FAIL+1))
  fi
}

status() {
  curl -sS -o /dev/null -w '%{http_code}' "$@"
}

# ---------------------------------------------------------------------------
say "page-scout-contract"
if bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/page-scout-contract-smoke.sh"; then
  printf '  ok   %-40s\n' "Page Scout deterministic contract"
else
  printf '  FAIL %-40s\n' "Page Scout deterministic contract"
  FAIL=$((FAIL+1))
fi

say "openapi-spec"
check "GET /openapi-spec" "200" "$(status "$SUPABASE_URL/functions/v1/openapi-spec")"

say "user"
check "GET /user/me"                "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/user/me")"
check "GET /user/preferences"       "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/user/preferences")"

say "projects"
check "GET /projects"               "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/projects")"

say "scouts"
check "GET /scouts"                 "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/scouts")"

say "scout-templates"
check "GET /scout-templates"        "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/scout-templates")"
check "GET /scout-templates/city-council-minutes" "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/scout-templates/city-council-minutes")"

say "units"
check "GET /units"                  "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/units")"
check "POST /units/search (bad)"    "400" "$(status -X POST "${H[@]}" -d '{}' "$SUPABASE_URL/functions/v1/units/search")"

say "entities"
check "GET /entities"               "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/entities")"

say "reflections"
check "GET /reflections"            "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/reflections")"

say "export-claude"
check "GET /export-claude"          "200" "$(status "${H[@]}" "$SUPABASE_URL/functions/v1/export-claude")"

if [ "${SKIP_LIVE:-0}" != "1" ]; then
  say "ingest (text, live Gemini required)"
  INGEST=$(curl -sS -X POST "${H[@]}" \
    -d "{\"kind\":\"text\",\"title\":\"smoke test\",\"text\":\"The city council voted on 12 March 2026 to approve a new affordable housing subsidy targeting low-income families totalling CHF 40 million. Mayor Corine Mauch endorsed the scheme.\"}" \
    "$SUPABASE_URL/functions/v1/ingest")
  echo "$INGEST" | head -c 400; echo
  if echo "$INGEST" | grep -q '"ingest_id"'; then
    printf '  ok   %-40s\n' "POST /ingest (text) has ingest_id"
  else
    printf '  FAIL %-40s\n' "POST /ingest (text)"
    FAIL=$((FAIL+1))
  fi
else
  printf '  skip POST /ingest (SKIP_LIVE=1)\n'
fi

# ---------------------------------------------------------------------------
say "summary"
if [ "$FAIL" -eq 0 ]; then
  echo "  all checks passed"
  exit 0
else
  echo "  $FAIL check(s) failed"
  exit 1
fi
