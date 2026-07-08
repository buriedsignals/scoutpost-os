/**
 * Pure retrieval helpers for the snapshots EF (PAGE-ARCHIVE-PRD U5) — kept out
 * of index.ts so the artifact map, availability logic, and response shape are
 * unit-testable without the auth/DB/storage stack.
 */

/** Strict UUID (canonical 8-4-4-4-12 hex). The loose `[0-9a-f-]{36}` shape a
 * naive guard uses also matches non-UUIDs (e.g. 36 hyphens), which then reach a
 * uuid column and raise a Postgres 22P02 cast error → HTTP 500 instead of a
 * clean 4xx. Validate id/scout_id against this before any `.eq()`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Parse a pagination query param to an int clamped to [min, max], falling back
 * to `fallback` when the value is absent or non-numeric (parseInt → NaN). Keeps
 * a garbage `?limit=foo` from reaching `.range(NaN, NaN)` and 500ing. */
export function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export type SnapshotArtifactKind =
  | "mhtml"
  | "screenshot"
  | "rawhtml"
  | "markdown"
  | "manifest"
  | "tsr";

/** Artifact kind → (row path column, download content type, file extension).
 * Content types make MHTML open in Chrome/Edge and keep the rest as files. */
export const ARTIFACTS: Record<
  SnapshotArtifactKind,
  { column: string; contentType: string; ext: string }
> = {
  mhtml: { column: "mhtml_path", contentType: "multipart/related", ext: "mhtml" },
  screenshot: { column: "screenshot_path", contentType: "image/png", ext: "png" },
  rawhtml: { column: "rawhtml_path", contentType: "text/html", ext: "html" },
  markdown: { column: "markdown_path", contentType: "text/markdown", ext: "md" },
  manifest: { column: "manifest_path", contentType: "application/json", ext: "json" },
  tsr: { column: "tsa_path", contentType: "application/timestamp-reply", ext: "tsr" },
};

export const ARTIFACT_KINDS = Object.keys(ARTIFACTS) as [
  SnapshotArtifactKind,
  ...SnapshotArtifactKind[],
];

/** The row columns the list + shaping read. */
export const SNAPSHOT_ROW_COLUMNS =
  "id, scout_id, scout_run_id, capture_kind, fidelity, served_by, captured_at, " +
  "requested_url, final_url, http_status, markdown_bytes, mhtml_bytes, " +
  "screenshot_bytes, rawhtml_bytes, markdown_path, mhtml_path, screenshot_path, " +
  "rawhtml_path, manifest_path, tsa_status, tsa_path, wayback_status, wayback_url, created_at";

/** Which artifact kinds this row actually holds — derived from which *_path
 * columns are non-null (markdown_only → [markdown]; rendered_thirdparty →
 * [screenshot, rawhtml, markdown]; full → [mhtml, screenshot, markdown]; +
 * manifest/tsr once the trust layer ran). */
export function availableArtifacts(
  row: Record<string, unknown>,
): SnapshotArtifactKind[] {
  return (Object.keys(ARTIFACTS) as SnapshotArtifactKind[]).filter(
    (kind) => typeof row[ARTIFACTS[kind].column] === "string" && row[ARTIFACTS[kind].column],
  );
}

export function shapeSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    scout_id: row.scout_id,
    scout_run_id: row.scout_run_id,
    capture_kind: row.capture_kind,
    fidelity: row.fidelity,
    served_by: row.served_by,
    captured_at: row.captured_at,
    requested_url: row.requested_url,
    final_url: row.final_url,
    http_status: row.http_status,
    sizes: {
      markdown: row.markdown_bytes ?? null,
      mhtml: row.mhtml_bytes ?? null,
      screenshot: row.screenshot_bytes ?? null,
      rawhtml: row.rawhtml_bytes ?? null,
    },
    trust: {
      tsa_status: row.tsa_status,
      wayback_status: row.wayback_status,
      wayback_url: row.wayback_url,
    },
    artifacts: availableArtifacts(row),
    created_at: row.created_at,
  };
}

/** Download filename for a signed URL. */
export function artifactDownloadName(
  snapshotId: string,
  kind: SnapshotArtifactKind,
): string {
  return `snapshot-${snapshotId}.${ARTIFACTS[kind].ext}`;
}
