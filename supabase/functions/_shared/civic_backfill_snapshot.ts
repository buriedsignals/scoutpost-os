import type { SupabaseClient } from "./supabase.ts";
import { sha256Hex } from "./unit_dedup.ts";

interface BackfillInput {
  userId: string;
  scoutId: string;
  runId: string | null;
  sourceUrl: string;
  semantics: Record<string, unknown>;
  scout: Record<string, unknown>;
}

export async function loadCivicBackfillSnapshot(
  db: SupabaseClient,
  input: BackfillInput,
) {
  const snapshot = input.semantics.scout_snapshot as
    | Record<string, unknown>
    | undefined;
  if (
    input.scout.user_id !== input.userId || input.scout.type !== "civic" ||
    input.scout.is_active !== true || !snapshot
  ) {
    throw new Error("Backfill Scout is missing, foreign, or paused");
  }
  for (
    const key of [
      "tracked_urls",
      "criteria",
      "preferred_language",
      "project_id",
    ]
  ) {
    if (
      JSON.stringify(input.scout[key] ?? null) !==
        JSON.stringify(snapshot[key] ?? null)
    ) {
      throw new Error("Backfill Scout configuration changed after review");
    }
  }
  const { data, error } = await db.from("raw_captures")
    .select("id, content_md, content_sha256, expires_at")
    .eq("id", input.semantics.raw_capture_id)
    .eq("user_id", input.userId).eq("scout_id", input.scoutId)
    .eq("scout_run_id", input.runId).eq("source_url", input.sourceUrl)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (
    !data || typeof data.content_md !== "string" || !data.content_md.trim() ||
    data.content_md.length > 40_000 || !data.expires_at ||
    !(Date.parse(data.expires_at) > Date.now()) ||
    data.content_sha256 !== input.semantics.content_sha256 ||
    await sha256Hex(data.content_md) !== data.content_sha256
  ) {
    throw new Error(
      "Backfill parsed snapshot is missing, expired, or hash mismatched",
    );
  }
  return {
    rawCaptureId: data.id as string,
    markdown: data.content_md as string,
    title: typeof input.semantics.title === "string"
      ? input.semantics.title
      : null,
  };
}
