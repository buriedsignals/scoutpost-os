/**
 * Trust-layer orchestration (PAGE-ARCHIVE-PRD U4, KTD5 / R6).
 *
 * Given a just-stored snapshot, build its canonical manifest, obtain an RFC
 * 3161 timestamp over the manifest hash, attempt a Wayback corroboration of the
 * URL, persist the manifest + `.tsr` to the bucket, and stamp the outcome onto
 * the page_snapshots row. Every step is async, bounded, and NON-FATAL — a
 * snapshot without a token or a Wayback URL is still a snapshot, honestly
 * labeled. This runs inside the already-backgrounded capture flow, so its
 * latency never touches a run or its notification (R11).
 */

import type { SupabaseClient } from "./supabase.ts";
import { buildManifest, requestTsaToken, type TsaDeps } from "./tsa.ts";
import { submitToWayback, type WaybackDeps } from "./wayback.ts";
import {
  manifestObjectPath,
  sha256HexBytes,
  type StoredSnapshot,
  tsrObjectPath,
  updateSnapshotTrust,
  uploadTrustObject,
} from "./snapshot_store.ts";
import { logEvent } from "./log.ts";

export interface TrustResult {
  manifestPath: string | null;
  tsaStatus: string;
  tsaPath: string | null;
  waybackStatus: string;
  waybackUrl: string | null;
}

export interface TrustDeps {
  tsa?: TsaDeps;
  wayback?: WaybackDeps;
}

/** Single source for the "Wayback defaults ON" policy (KTD5). The column is
 * NOT NULL DEFAULT TRUE (migration 00077), so a persisted row never yields
 * null; this coalesce is defensive for pre-read/partial scout objects. Keeping
 * it in one place means the default flips in exactly one edit. */
export function scoutWaybackEnabled(value: boolean | null | undefined): boolean {
  return value ?? true;
}

/**
 * Apply TSA + Wayback to a stored snapshot and update its row. Never throws.
 * The manifest hashes over the EXACT bytes that were stored (via
 * StoredSnapshot.manifestInput). TSA and Wayback run concurrently — still one
 * request each (third-party etiquette).
 */
export async function applyTrustLayer(
  svc: SupabaseClient,
  stored: StoredSnapshot,
  waybackEnabled: boolean,
  deps: TrustDeps = {},
): Promise<TrustResult> {
  const mi = stored.manifestInput;
  const manifest = buildManifest(mi);
  const manifestBytes = new TextEncoder().encode(manifest);
  const manifestHash = await sha256HexBytes(manifestBytes);
  const manifestPath = manifestObjectPath(mi.userId, mi.scoutId, mi.snapshotId);

  // The manifest upload is independent of the TSA/Wayback network calls (the
  // hash is already in hand), so run all three concurrently.
  const [manifestOk, tsa, wb] = await Promise.all([
    uploadTrustObject(svc, manifestPath, manifestBytes, "application/json")
      .then(() => true)
      .catch((e) => {
        logEvent({
          level: "warn",
          fn: "trust",
          event: "manifest_upload_failed",
          scout_id: mi.scoutId,
          msg: e instanceof Error ? e.message : String(e),
        });
        return false;
      }),
    requestTsaToken(manifestHash, deps.tsa),
    submitToWayback(mi.requestedUrl, mi.capturedAt, waybackEnabled, deps.wayback),
  ]);
  const storedManifestPath = manifestOk ? manifestPath : null;

  let tsaPath: string | null = null;
  let tsaStatus = tsa.status;
  if (!manifestOk) {
    // The token attests to a manifest that was never persisted — nobody can
    // reproduce the imprint to verify it. Never present that as 'ok', and don't
    // store a .tsr that has nothing to verify against.
    if (tsaStatus === "ok") tsaStatus = "failed:no_manifest";
  } else if (tsa.status === "ok" && tsa.tsr) {
    // Store the validated token; a store failure downgrades the status honestly
    // (a token we cannot retrieve is not usable evidence).
    const path = tsrObjectPath(mi.userId, mi.scoutId, mi.snapshotId);
    try {
      await uploadTrustObject(svc, path, tsa.tsr, "application/timestamp-reply");
      tsaPath = path;
    } catch (e) {
      tsaStatus = "failed:store";
      logEvent({
        level: "warn",
        fn: "trust",
        event: "tsr_upload_failed",
        scout_id: mi.scoutId,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await updateSnapshotTrust(svc, mi.snapshotId, {
    manifest_path: storedManifestPath,
    tsa_status: tsaStatus,
    tsa_path: tsaPath,
    wayback_status: wb.status,
    wayback_url: wb.waybackUrl ?? null,
  });

  logEvent({
    level: "info",
    fn: "trust",
    event: "trust_applied",
    scout_id: mi.scoutId,
    snapshot_id: mi.snapshotId,
    msg: `tsa=${tsaStatus} wayback=${wb.status}`,
  });

  return {
    manifestPath: storedManifestPath,
    tsaStatus,
    tsaPath,
    waybackStatus: wb.status,
    waybackUrl: wb.waybackUrl ?? null,
  };
}
