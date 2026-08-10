/**
 * Civic archive membership helpers.
 *
 * A schedule-time baseline must be a complete, bounded set of document URLs
 * and document-content hashes.  The legacy `processed_pdf_urls` array is
 * capped at 100 and therefore cannot safely answer this question.
 */
import type { SupabaseClient } from "./supabase.ts";

export const CIVIC_DOCUMENT_MEMBERSHIP_MAX = 100;

export interface CivicDocumentMembership {
  sourceUrl: string;
  contentHash: string;
}

export function assertCompleteCivicMembership(documentUrls: string[]): void {
  if (documentUrls.length > CIVIC_DOCUMENT_MEMBERSHIP_MAX) {
    throw new Error(
      `Civic archive contains ${documentUrls.length} documents; the complete ` +
        `creation baseline limit is ${CIVIC_DOCUMENT_MEMBERSHIP_MAX}. Narrow ` +
        "the tracked source before scheduling so new-document detection is trustworthy.",
    );
  }
}

export async function loadCivicDocumentBaselineHashes(
  svc: SupabaseClient,
  scoutId: string,
): Promise<Map<string, string>> {
  const { data, error } = await svc
    .from("civic_document_baselines")
    .select("source_url, content_sha256")
    .eq("scout_id", scoutId);
  if (error) {
    throw new Error(`civic membership lookup failed: ${error.message}`);
  }
  return new Map(
    (data ?? []).flatMap((row) =>
      typeof row.source_url === "string" &&
        typeof row.content_sha256 === "string"
        ? [[row.source_url, row.content_sha256] as const]
        : []
    ),
  );
}

export async function upsertCivicDocumentMembership(
  svc: SupabaseClient,
  input: CivicDocumentMembership & { scoutId: string; userId: string },
): Promise<void> {
  const { error } = await svc.from("civic_document_baselines").upsert({
    scout_id: input.scoutId,
    user_id: input.userId,
    source_url: input.sourceUrl,
    content_sha256: input.contentHash,
    observed_at: new Date().toISOString(),
  }, { onConflict: "scout_id,source_url" });
  if (error) throw new Error(`civic membership write failed: ${error.message}`);
}

/** True only when a document is not already leased and its source version is
 * absent or different from the complete durable membership baseline. */
export function shouldQueueCivicDocument(
  sourceUrl: string,
  contentHash: string,
  baselineHashes: ReadonlyMap<string, string>,
  queuedUrls: ReadonlySet<string>,
): boolean {
  return !queuedUrls.has(sourceUrl) &&
    baselineHashes.get(sourceUrl) !== contentHash;
}
