/**
 * Civic archive membership helpers.
 *
 * The creation baseline answers one question: which documents did the
 * archive already list when the scout was created? That is URL membership.
 * A scheduled run then queues documents whose URL is NEW (at most
 * MAX_DOCS_PER_RUN) without parsing anything else. Content hashes exist only
 * for documents that have been parsed — by the worker on success, or by the
 * bounded same-URL replacement check on the newest few known documents —
 * because councils do replace a PDF at the same URL (draft → final minutes).
 *
 * The legacy `processed_pdf_urls` array is capped at 100 and cannot answer
 * the membership question; the old "parse and hash every document at
 * creation" baseline could not schedule a ~500-document Legistar calendar.
 */
import type { SupabaseClient } from "./supabase.ts";

/** Sanity bound on URL membership per scout (a listing, not an archive crawl). */
export const CIVIC_DOCUMENT_MEMBERSHIP_MAX = 5_000;
export const CIVIC_BASELINE_PARSE_CONCURRENCY = 4;
/**
 * Known documents re-hashed per run to catch a replaced file at a stable URL.
 * Documents are ordered newest/most-authoritative first, so this covers the
 * minutes most likely to change from draft to final.
 */
export const CIVIC_REPLACEMENT_CHECK_LIMIT = 3;

export interface CivicDocumentMembership {
  sourceUrl: string;
  /** NULL until the document has been parsed. */
  contentHash: string | null;
}

/**
 * Resolve creation-time Civic documents with bounded concurrency. Document
 * parsing is external I/O and can take tens of seconds per PDF; doing it
 * serially can exceed the hosted Edge Function request window even for a
 * modest council archive. Results retain input order so baseline writes and
 * diagnostics stay deterministic.
 */
export async function mapCivicBaselineDocuments<T>(
  documentUrls: string[],
  resolve: (url: string, index: number) => Promise<T>,
): Promise<T[]> {
  if (documentUrls.length === 0) return [];
  const results = new Array<T>(documentUrls.length);
  let nextIndex = 0;
  const workers = Array.from(
    {
      length: Math.min(
        CIVIC_BASELINE_PARSE_CONCURRENCY,
        documentUrls.length,
      ),
    },
    async () => {
      while (nextIndex < documentUrls.length) {
        const index = nextIndex++;
        results[index] = await resolve(documentUrls[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function assertCompleteCivicMembership(documentUrls: string[]): void {
  if (documentUrls.length > CIVIC_DOCUMENT_MEMBERSHIP_MAX) {
    throw new Error(
      `Civic source lists ${documentUrls.length} documents; the membership ` +
        `bound is ${CIVIC_DOCUMENT_MEMBERSHIP_MAX}. Track a committee or ` +
        "year listing rather than a whole-archive index.",
    );
  }
}

/** Every known document URL for a scout, with its hash when parsed. */
export async function loadCivicDocumentBaselineHashes(
  svc: SupabaseClient,
  scoutId: string,
): Promise<Map<string, string | null>> {
  const { data, error } = await svc
    .from("civic_document_baselines")
    .select("source_url, content_sha256")
    .eq("scout_id", scoutId);
  if (error) {
    throw new Error(`civic membership lookup failed: ${error.message}`);
  }
  return new Map(
    (data ?? []).flatMap((row) =>
      typeof row.source_url === "string"
        ? [
          [
            row.source_url,
            typeof row.content_sha256 === "string" ? row.content_sha256 : null,
          ] as const,
        ]
        : []
    ),
  );
}

/** Record a parsed document's content version (overwrites). */
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

/**
 * Record URL membership for documents an archive already lists, without
 * parsing them. Never overwrites a row that already carries a hash.
 */
export async function recordCivicDocumentUrls(
  svc: SupabaseClient,
  input: { scoutId: string; userId: string; sourceUrls: string[] },
): Promise<void> {
  const urls = [...new Set(input.sourceUrls)];
  if (urls.length === 0) return;
  const observedAt = new Date().toISOString();
  for (let offset = 0; offset < urls.length; offset += 500) {
    const { error } = await svc.from("civic_document_baselines").upsert(
      urls.slice(offset, offset + 500).map((sourceUrl) => ({
        scout_id: input.scoutId,
        user_id: input.userId,
        source_url: sourceUrl,
        content_sha256: null,
        observed_at: observedAt,
      })),
      { onConflict: "scout_id,source_url", ignoreDuplicates: true },
    );
    if (error) {
      throw new Error(`civic membership write failed: ${error.message}`);
    }
  }
}

/**
 * Queue when the document is not already leased AND either its URL is new
 * to the membership, or a content hash was computed for it and differs from
 * the recorded one. A known URL whose hash was not computed this run
 * (`contentHash === null`) is assumed unchanged.
 */
export function shouldQueueCivicDocument(
  sourceUrl: string,
  contentHash: string | null,
  baselineHashes: ReadonlyMap<string, string | null>,
  queuedUrls: ReadonlySet<string>,
): boolean {
  if (queuedUrls.has(sourceUrl)) return false;
  if (!baselineHashes.has(sourceUrl)) return true;
  if (contentHash === null) return false;
  const recorded = baselineHashes.get(sourceUrl) ?? null;
  return recorded !== null && recorded !== contentHash;
}

/** Known URLs, in document order, that this run re-hashes for replacement. */
export function replacementCheckUrls(
  documentUrls: readonly string[],
  baselineHashes: ReadonlyMap<string, string | null>,
  limit = CIVIC_REPLACEMENT_CHECK_LIMIT,
): string[] {
  return documentUrls
    .filter((url) => typeof baselineHashes.get(url) === "string")
    .slice(0, Math.max(0, limit));
}
