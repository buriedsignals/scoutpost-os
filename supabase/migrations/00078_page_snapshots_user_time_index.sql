-- Page Archive: composite (user_id, captured_at DESC) index for the unscoped
-- snapshot listing (code-review 2026-07-09, finding #17).
--
-- GET /snapshots WITHOUT a scout_id (both `scout snapshots list` and the MCP
-- list_snapshots tool allow omitting it) filters by user_id then ORDER BY
-- captured_at DESC. 00077's idx_page_snapshots_user is user_id-only, so that
-- query pulls every matching row into a sort before returning the top N.
-- page_snapshots never shrinks (no TTL, KTD7), so the cost grows unbounded with
-- a single user's archive tenure. Replace the single-column index with a
-- composite one that satisfies the filter AND the order (mirrors the per-scout
-- idx_page_snapshots_scout_time).
CREATE INDEX IF NOT EXISTS idx_page_snapshots_user_time
  ON page_snapshots (user_id, captured_at DESC);
DROP INDEX IF EXISTS idx_page_snapshots_user;
