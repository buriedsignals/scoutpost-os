/**
 * Page Archive snapshot persistence (PAGE-ARCHIVE-PRD U2, KTD3/KTD4).
 *
 * Owns everything between "the pipeline has artifact bytes in hand" and "the
 * evidence exists durably": SHA-256 verification against claimed hashes
 * BEFORE anything is stored (hash-before-store, R2), content-addressed object
 * paths (filename == hash of bytes; identical bytes dedup to one object), the
 * .md canonical-markdown record written with every row (the content record
 * must outlive the raw_captures TTL — KTD9), the page_snapshots row insert,
 * run diagnostics, and the deletion contract (R3): FK cascades remove rows
 * but can never reach storage objects, so deleteScoutSnapshots is the only
 * thing standing between R3's promise and orphaned page copies.
 *
 * Evidence integrity is the product (loop ground rule): nothing in this
 * module weakens a hash check or stores bytes whose hash does not match
 * their claimed value.
 */

import type { SupabaseClient } from "./supabase.ts";
import { logEvent } from "./log.ts";

export const SNAPSHOT_BUCKET = "page-snapshots";

export type SnapshotFidelity = "full" | "rendered_thirdparty" | "markdown_only";
export type SnapshotCaptureKind = "baseline" | "change";
export type SnapshotServedBy = "crawl4ai" | "firecrawl";
export type SnapshotArtifactKind = "mhtml" | "screenshot" | "rawhtml";

/** Object extension and content type per artifact kind (KTD3). Screenshots
 * are stored verbatim as rendered/delivered — PNG on both capture paths
 * (Decision 9: no lossy transcode between render and seal). */
const ARTIFACT_META: Record<
  SnapshotArtifactKind | "markdown",
  { ext: string; contentType: string }
> = {
  mhtml: { ext: "mhtml", contentType: "multipart/related" },
  screenshot: { ext: "png", contentType: "image/png" },
  rawhtml: { ext: "html", contentType: "text/html" },
  markdown: { ext: "md", contentType: "text/markdown" },
};

export class SnapshotIntegrityError extends Error {}
export class SnapshotPathError extends Error {}
export class SnapshotStorageError extends Error {}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new SnapshotPathError(`${label} is not a UUID: ${JSON.stringify(value)}`);
  }
}

/** Content-addressed object path. UUID/hex validation doubles as the
 * path-traversal guard — nothing else may appear in an object name. Ids are
 * lowercased in the emitted path: storage RLS compares the first folder to
 * auth.uid()::text, which Postgres renders lowercase, so an uppercase UUID
 * from a caller would produce an owner-unreadable object. */
export function snapshotObjectPath(
  userId: string,
  scoutId: string,
  sha256: string,
  kind: SnapshotArtifactKind | "markdown",
): string {
  assertUuid(userId, "userId");
  assertUuid(scoutId, "scoutId");
  if (!HEX64_RE.test(sha256)) {
    throw new SnapshotPathError(`sha256 is not 64-char hex: ${JSON.stringify(sha256)}`);
  }
  return `${userId.toLowerCase()}/${scoutId.toLowerCase()}/${sha256}.${ARTIFACT_META[kind].ext}`;
}

export function manifestObjectPath(
  userId: string,
  scoutId: string,
  snapshotId: string,
): string {
  assertUuid(userId, "userId");
  assertUuid(scoutId, "scoutId");
  assertUuid(snapshotId, "snapshotId");
  return `${userId.toLowerCase()}/${scoutId.toLowerCase()}/manifest-${snapshotId.toLowerCase()}.json`;
}

export interface SnapshotArtifact {
  kind: SnapshotArtifactKind;
  bytes: Uint8Array;
  /** Hash claimed by whoever delivered the bytes (scrape-service payload,
   * Firecrawl response). Verified before anything is stored. Omit only for
   * bytes this process produced itself. */
  claimedSha256?: string;
}

export interface StoreSnapshotParams {
  scoutId: string;
  userId: string;
  scoutRunId?: string | null;
  rawCaptureId?: string | null;
  captureKind: SnapshotCaptureKind;
  fidelity: SnapshotFidelity;
  servedBy?: SnapshotServedBy | null;
  capturedAt: string;
  requestedUrl: string;
  finalUrl?: string | null;
  httpStatus?: number | null;
  responseHeaders?: Record<string, string> | null;
  contentSha256?: string | null;
  canonicalContentSha256?: string | null;
  /** Canonical markdown — mandatory on every row (KTD9: the content record
   * outlives the raw_captures TTL). */
  markdown: string;
  artifacts?: SnapshotArtifact[];
}

export interface StoredSnapshot {
  id: string;
  fidelity: SnapshotFidelity;
  markdownPath: string;
  paths: Partial<Record<SnapshotArtifactKind, string>>;
}

/** Fidelity tiers imply exact artifact sets (KTD9). Enforced so a bug cannot
 * store a row whose label overstates what it holds. */
function requiredArtifactKinds(fidelity: SnapshotFidelity): SnapshotArtifactKind[] {
  if (fidelity === "full") return ["mhtml", "screenshot"];
  if (fidelity === "rendered_thirdparty") return ["screenshot", "rawhtml"];
  return [];
}

export async function storeSnapshot(
  svc: SupabaseClient,
  params: StoreSnapshotParams,
): Promise<StoredSnapshot> {
  if (!params.markdown.trim()) {
    throw new SnapshotIntegrityError(
      "every snapshot row carries the canonical-markdown content record; markdown is empty",
    );
  }
  const provided = (params.artifacts ?? []).map((a) => a.kind).sort();
  const required = requiredArtifactKinds(params.fidelity).sort();
  if (provided.join(",") !== required.join(",")) {
    throw new SnapshotIntegrityError(
      `fidelity '${params.fidelity}' requires artifacts [${required.join(", ")}], got [${provided.join(", ")}]`,
    );
  }

  // Verify EVERY hash before storing ANY byte (hash-before-store, R2).
  const markdownBytes = new TextEncoder().encode(params.markdown);
  const uploads: Array<{
    kind: SnapshotArtifactKind | "markdown";
    bytes: Uint8Array;
    sha256: string;
    path: string;
  }> = [];
  for (const artifact of params.artifacts ?? []) {
    const actual = await sha256HexBytes(artifact.bytes);
    // Hex case is not integrity signal — an uppercase digest over identical
    // bytes is the same hash, and rejecting it would drop a valid capture.
    const claimed = artifact.claimedSha256?.toLowerCase();
    if (claimed !== undefined && claimed !== actual) {
      throw new SnapshotIntegrityError(
        `sha256 mismatch on ${artifact.kind}: claimed ${claimed}, computed ${actual}`,
      );
    }
    uploads.push({
      kind: artifact.kind,
      bytes: artifact.bytes,
      sha256: actual,
      path: snapshotObjectPath(params.userId, params.scoutId, actual, artifact.kind),
    });
  }
  const markdownSha = await sha256HexBytes(markdownBytes);
  uploads.push({
    kind: "markdown",
    bytes: markdownBytes,
    sha256: markdownSha,
    path: snapshotObjectPath(params.userId, params.scoutId, markdownSha, "markdown"),
  });

  for (const upload of uploads) {
    const { error } = await svc.storage
      .from(SNAPSHOT_BUCKET)
      .upload(upload.path, upload.bytes, {
        contentType: ARTIFACT_META[upload.kind].contentType,
        upsert: false,
      });
    // Content addressing makes re-runs safe: an existing object under this
    // path holds byte-identical content by construction, so "already exists"
    // is success, not failure. StorageApiError's statusCode "409" is the
    // contract; the message regex is only a fallback for older shapes.
    const isDuplicate = error !== null &&
      ((error as { statusCode?: string }).statusCode === "409" ||
        /already exists|duplicate/i.test(error.message));
    if (error && !isDuplicate) {
      throw new SnapshotStorageError(
        `upload failed for ${upload.kind} (${upload.path}): ${error.message}`,
      );
    }
  }

  const byKind = new Map(uploads.map((u) => [u.kind, u]));
  const row: Record<string, unknown> = {
    scout_id: params.scoutId,
    scout_run_id: params.scoutRunId ?? null,
    user_id: params.userId,
    raw_capture_id: params.rawCaptureId ?? null,
    capture_kind: params.captureKind,
    fidelity: params.fidelity,
    served_by: params.servedBy ?? null,
    captured_at: params.capturedAt,
    requested_url: params.requestedUrl,
    final_url: params.finalUrl ?? null,
    http_status: params.httpStatus ?? null,
    response_headers: params.responseHeaders ?? null,
    content_sha256: params.contentSha256 ?? null,
    canonical_content_sha256: params.canonicalContentSha256 ?? null,
    markdown_sha256: markdownSha,
    markdown_path: byKind.get("markdown")!.path,
    markdown_bytes: markdownBytes.byteLength,
    // expires_at intentionally omitted → NULL: no TTL (KTD7).
  };
  for (const kind of ["mhtml", "screenshot", "rawhtml"] as const) {
    const upload = byKind.get(kind);
    row[`${kind}_sha256`] = upload?.sha256 ?? null;
    row[`${kind}_path`] = upload?.path ?? null;
    row[`${kind}_bytes`] = upload?.bytes.byteLength ?? null;
  }

  const { data, error } = await svc
    .from("page_snapshots")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new SnapshotStorageError(
      `page_snapshots insert failed: ${error?.message ?? "no row returned"}`,
    );
  }

  const paths: Partial<Record<SnapshotArtifactKind, string>> = {};
  for (const kind of ["mhtml", "screenshot", "rawhtml"] as const) {
    const upload = byKind.get(kind);
    if (upload) paths[kind] = upload.path;
  }
  return {
    id: (data as { id: string }).id,
    fidelity: params.fidelity,
    markdownPath: byKind.get("markdown")!.path,
    paths,
  };
}

/** Shape merged into scout_runs.metadata beside scrape_provider /
 * scrape_provider_served (as-built stamping convention). */
export function snapshotDiagnostics(outcome: {
  status: string;
  snapshotId?: string;
  fidelity?: SnapshotFidelity;
}): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = { snapshot_status: outcome.status };
  if (outcome.snapshotId) diagnostics.snapshot_id = outcome.snapshotId;
  if (outcome.fidelity) diagnostics.snapshot_fidelity = outcome.fidelity;
  return diagnostics;
}

/** The deletion contract (R3). Removes every object under the scout's prefix
 * (paginated, with a no-progress guard: real storage remove() can report
 * per-object failures via `data` while returning `error: null`, and an
 * un-removable object would otherwise make the loop spin forever), then the
 * rows, then sweeps once more — an in-flight capture can upload artifacts
 * after the first drain's list() pass, and since callers delete the scout row
 * before invoking this (so late storeSnapshot inserts fail on the FK), this
 * second pass is the last chance to collect those bytes. DB cascades handle
 * rows on account deletion, but objects always need this path — the
 * account-level sweep is documented in docs/supabase/retention.md. */
export async function deleteScoutSnapshots(
  svc: SupabaseClient,
  userId: string,
  scoutId: string,
): Promise<{ objectsRemoved: number }> {
  assertUuid(userId, "userId");
  assertUuid(scoutId, "scoutId");
  const prefix = `${userId.toLowerCase()}/${scoutId.toLowerCase()}`;

  const drain = async (): Promise<number> => {
    let removed = 0;
    let previousPage = "";
    for (;;) {
      const { data, error } = await svc.storage
        .from(SNAPSHOT_BUCKET)
        .list(prefix, { limit: 1000 });
      if (error) {
        throw new SnapshotStorageError(`list failed for ${prefix}: ${error.message}`);
      }
      if (!data || data.length === 0) break;
      const names = (data as Array<{ name: string }>).map((o) => `${prefix}/${o.name}`);
      const signature = names.join("\n");
      if (signature === previousPage) {
        throw new SnapshotStorageError(
          `no progress deleting under ${prefix}: ${names.length} object(s) survive remove() — per-object storage failures?`,
        );
      }
      previousPage = signature;
      const { error: removeError } = await svc.storage
        .from(SNAPSHOT_BUCKET)
        .remove(names);
      if (removeError) {
        throw new SnapshotStorageError(
          `remove failed for ${prefix}: ${removeError.message}`,
        );
      }
      removed += names.length;
    }
    return removed;
  };

  let objectsRemoved = await drain();
  const { error: rowError } = await svc
    .from("page_snapshots")
    .delete()
    .eq("scout_id", scoutId)
    .eq("user_id", userId);
  if (rowError) {
    throw new SnapshotStorageError(
      `page_snapshots delete failed for scout ${scoutId}: ${rowError.message}`,
    );
  }
  objectsRemoved += await drain();
  logEvent({
    level: "info",
    fn: "snapshot_store",
    event: "scout_snapshots_deleted",
    scout_id: scoutId,
    objects_removed: objectsRemoved,
  });
  return { objectsRemoved };
}
