import type { SupabaseClient } from "./supabase.ts";
import { EMBEDDING_MODEL_TAG } from "./embedding.ts";

export type CanonicalUnitType = "fact" | "event" | "entity_update" | "promise";
export type CanonicalSourceType =
  | "scout"
  | "manual_ingest"
  | "agent_ingest"
  | "civic_promise";

export interface CanonicalUnitInput {
  userId: string;
  statement: string;
  unitType: CanonicalUnitType;
  entities?: string[] | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  sourceTitle?: string | null;
  contextExcerpt?: string | null;
  occurredAt?: string | null;
  extractedAt?: string | null;
  sourceType: CanonicalSourceType;
  contentSha256?: string | null;
  scoutId?: string | null;
  scoutType?: string | null;
  scoutRunId?: string | null;
  projectId?: string | null;
  rawCaptureId?: string | null;
  metadata?: Record<string, unknown> | null;
  factChecked?: boolean;
  confidenceScore?: number | null;
  abstained?: boolean;
  abstainReason?: string | null;
}

export interface CanonicalUpsertResult {
  unitId: string;
  createdCanonical: boolean;
  mergedExisting: boolean;
  matchScope: string;
  occurrenceCreated: boolean;
  statementHash: string;
  normalizedSourceUrl: string | null;
}

const TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "s",
  "si",
  "utm_campaign",
  "utm_content",
  "utm_id",
  "utm_medium",
  "utm_name",
  "utm_reader",
  "utm_source",
  "utm_term",
]);

export function normalizeUnitStatement(statement: string): string {
  return statement.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeEntityList(
  entities: string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of entities ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeSourceUrl(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_QUERY_PARAMS.has(key) || key.startsWith("utm_")) {
        url.searchParams.delete(key);
      }
    }
    if (!url.searchParams.toString()) url.search = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
      if (!url.pathname) url.pathname = "/";
    }
    return url.toString().replace(/\?$/, "");
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/#.*$/, "")
      .replace(/\/+$/, "")
      .replace(/\?$/, "") || null;
  }
}

export function deriveSourceDomain(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function upsertCanonicalUnit(
  db: SupabaseClient,
  input: CanonicalUnitInput,
): Promise<CanonicalUpsertResult> {
  const statement = input.statement.trim();
  if (!statement) throw new Error("upsertCanonicalUnit: statement is required");

  const normalizedSourceUrl = normalizeSourceUrl(input.sourceUrl);
  const statementHash = await sha256Hex(normalizeUnitStatement(statement));
  const entities = normalizeEntityList(input.entities);
  const sourceDomain = input.sourceDomain?.trim().toLowerCase() ||
    deriveSourceDomain(normalizedSourceUrl ?? input.sourceUrl ?? null);

  const payload = {
    p_user_id: input.userId,
    p_statement: statement,
    p_type: input.unitType,
    p_entities: entities,
    p_embedding: input.embedding ?? null,
    p_embedding_model: input.embedding
      ? input.embeddingModel ?? EMBEDDING_MODEL_TAG
      : input.embeddingModel ?? null,
    p_source_url: input.sourceUrl?.trim() || null,
    p_normalized_source_url: normalizedSourceUrl,
    p_source_domain: sourceDomain,
    p_source_title: input.sourceTitle?.trim() || null,
    p_context_excerpt: input.contextExcerpt?.trim() || null,
    p_occurred_at: input.occurredAt ?? null,
    p_extracted_at: input.extractedAt ?? new Date().toISOString(),
    p_source_type: input.sourceType,
    p_content_sha256: input.contentSha256 ?? null,
    p_statement_hash: statementHash,
    p_scout_id: input.scoutId ?? null,
    p_scout_type: input.scoutType ?? null,
    p_scout_run_id: input.scoutRunId ?? null,
    p_project_id: input.projectId ?? null,
    p_raw_capture_id: input.rawCaptureId ?? null,
    p_metadata: input.metadata ?? {},
    p_fact_checked: input.factChecked ?? false,
    p_confidence_score: input.confidenceScore ?? null,
    p_abstained: input.abstained ?? false,
    p_abstain_reason: input.abstainReason ?? null,
  };

  const { data, error } = await db.rpc("upsert_canonical_unit_v2", payload);
  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    throw new Error("upsertCanonicalUnit: missing RPC result");
  }

  return {
    unitId: String((row as Record<string, unknown>).unit_id),
    createdCanonical: Boolean(
      (row as Record<string, unknown>).created_canonical,
    ),
    mergedExisting: Boolean((row as Record<string, unknown>).merged_existing),
    matchScope: String((row as Record<string, unknown>).match_scope ?? "new"),
    occurrenceCreated: Boolean(
      (row as Record<string, unknown>).occurrence_created,
    ),
    statementHash,
    normalizedSourceUrl,
  };
}
