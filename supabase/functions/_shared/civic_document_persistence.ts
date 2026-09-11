import type { SupabaseClient } from "./supabase.ts";
import { normalizeUnitStatement, sha256Hex } from "./unit_dedup.ts";

/** Resume only unfinished items; the first accepted source evidence is immutable. */
export async function persistCivicDocumentItems<
  T extends { statement: string },
>(
  db: SupabaseClient,
  input: {
    queueId: string;
    userId: string;
    items: T[];
    persistItem: (item: T, index: number) => Promise<unknown>;
  },
): Promise<{ inserted: number; mergedExisting: number }> {
  const readCompleteResults = async () => {
    const { data, count, error } = await db
      .from("civic_queue_item_results")
      .select(
        "statement_hash, created_canonical, merged_existing, occurrence_created",
        {
          count: "exact",
        },
      )
      .eq("queue_id", input.queueId)
      .eq("user_id", input.userId);
    if (error) throw new Error(error.message);
    if (count !== data?.length) {
      throw new Error("Civic item result inventory is incomplete");
    }
    return data;
  };
  const acceptedHashes = new Set(
    (await readCompleteResults()).map((item) => item.statement_hash),
  );
  for (const [index, item] of input.items.entries()) {
    const hash = await sha256Hex(normalizeUnitStatement(item.statement));
    if (acceptedHashes.has(hash)) continue;
    await input.persistItem(item, index);
    acceptedHashes.add(hash);
  }
  // Extraction may omit an earlier accepted item on retry. Count the entire
  // queue ledger, including those earlier items, before document finalization.
  const persisted = await readCompleteResults();
  return {
    inserted: persisted.filter((item) => item.created_canonical).length,
    mergedExisting:
      persisted.filter((item) =>
        item.merged_existing && item.occurrence_created
      ).length,
  };
}
