#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT_DIR/supabase/functions"
deno test --allow-env --allow-read=. --allow-import \
  _shared/page_scout_notifications_test.ts \
  _shared/page_scout_change_test.ts \
  _shared/page_scout_criteria_test.ts \
  _shared/page_scout_schedule_test.ts \
  _shared/page_scout_archive_test.ts \
  _shared/subpage_filter_test.ts \
  _shared/canonical_baseline_test.ts \
  _shared/web_scout_baseline_test.ts \
  _shared/snapshot_capture_test.ts \
  _shared/snapshot_store_test.ts
deno check --allow-import scout-web-execute/index.ts scouts/index.ts

cd "$ROOT_DIR"
deno check --allow-import \
  scripts/benchmarks/benchmark-web.ts \
  scripts/benchmarks/benchmark-subpage-follow.ts \
  scripts/benchmarks/benchmark-page-scout-scheduler.ts
