#!/usr/bin/env bash
# Enforce 100% line coverage on the new provider-neutral scrape modules
# (SCRAPING-MIGRATION-PRD R8). Scoped deliberately to the modules the
# migration introduces — NOT scrape_firecrawl.ts, which is moved legacy code
# (search/map/doubleProbe retired in U4/U5, whole file deleted in U8).
#
# site_map.ts (U5 mapper) is intentionally NOT gated: it is well-tested (17
# cases: sitemap/index/gzip/subdomains/registrable-domain/fallback/errors) but
# its residual uncovered lines are defensive network branches (an abort-timer
# callback, a null-body gzip path) that don't warrant contrived fetch mocks.
#
# Usage: scripts/ops/check-scrape-coverage.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../supabase/functions"

GATED_FILES=(
  "_shared/scrape.ts"
  "_shared/scrape_crawl4ai.ts"
  "_shared/docparse.ts"
  "_shared/canonical_baseline.ts"
)

rm -rf coverage
# Flags mirror ci.yml's test-functions step: --allow-read=. + --allow-import so
# scout-transport-execute's satellite.js (npm) imports resolve, while the
# absence of --allow-net keeps the run network-isolated.
deno test --allow-env --allow-read=. --allow-import --coverage=coverage _shared/ scout-transport-execute/ >/dev/null 2>&1

# Strip ANSI colour codes so the table parses in CI and locally alike.
report="$(deno coverage coverage 2>/dev/null | sed -E $'s/\x1b\\[[0-9;]*m//g')"

fail=0
for f in "${GATED_FILES[@]}"; do
  # Table row looks like: | _shared/scrape.ts | 100.0 | 100.0 |
  line="$(printf '%s\n' "$report" | grep -F "$f " || true)"
  if [ -z "$line" ]; then
    echo "COVERAGE GATE: no coverage row for $f (was it removed or renamed?)" >&2
    fail=1
    continue
  fi
  pct="$(printf '%s\n' "$line" | sed -E 's/.*\| *([0-9.]+) *\| *[0-9.]+ *\|.*/\1/')"
  if [ "$pct" != "100" ] && [ "$pct" != "100.0" ]; then
    echo "COVERAGE GATE: $f is ${pct}% line coverage, must be 100%" >&2
    fail=1
  else
    echo "COVERAGE GATE: $f 100% ✓"
  fi
done

exit "$fail"
