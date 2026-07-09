/**
 * Shared input-validation primitives for Edge Functions.
 *
 * Canonical home for the strict-UUID pattern that several security-relevant
 * guards depend on — kept in one place so the definition can't drift between
 * copies (it previously lived independently in snapshot_store.ts,
 * snapshots/snapshot_view.ts, and mcp-server/oauth/authorize.ts).
 */

/** Strict UUID (canonical 8-4-4-4-12 hex). The loose `[0-9a-f-]{36}` shape a
 * naive guard uses also matches non-UUIDs (e.g. 36 hyphens), which then reach a
 * uuid column and raise a Postgres 22P02 cast error → HTTP 500 instead of a
 * clean 4xx. It doubles as a path-traversal guard where ids are interpolated
 * into storage object keys. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
