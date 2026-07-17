import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { EMBEDDING_MODEL_TAG } from "./embedding.ts";
import {
  deriveSourceDomain,
  normalizeEntityList,
  normalizeSourceUrl,
  normalizeUnitStatement,
  upsertCanonicalUnit,
} from "./unit_dedup.ts";

Deno.test("normalizeUnitStatement lowercases and collapses whitespace", () => {
  assertEquals(
    normalizeUnitStatement("  Council   Approved   Budget  "),
    "council approved budget",
  );
});

Deno.test("normalizeSourceUrl strips fragments, tracking params, and trailing slash", () => {
  assertEquals(
    normalizeSourceUrl("https://Example.com/news/story/?utm_source=x#section"),
    "https://example.com/news/story",
  );
});

Deno.test("normalizeEntityList preserves first spelling and removes case-insensitive dupes", () => {
  assertEquals(
    normalizeEntityList(["City Council", " city council ", "Budget Office"]),
    ["City Council", "Budget Office"],
  );
});

Deno.test("deriveSourceDomain returns normalized hostname", () => {
  assertEquals(
    deriveSourceDomain("https://sub.Example.gov/path"),
    "sub.example.gov",
  );
});

Deno.test("upsertCanonicalUnit forwards the new embedding model tag", async () => {
  let payload: Record<string, unknown> = {};
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      assertEquals(name, "upsert_canonical_unit_v2");
      payload = args;
      return Promise.resolve({
        data: [{
          unit_id: "00000000-0000-0000-0000-000000000000",
          created_canonical: true,
          merged_existing: false,
          match_scope: "new",
          occurrence_created: true,
        }],
        error: null,
      });
    },
  };

  const result = await upsertCanonicalUnit(db as never, {
    userId: "00000000-0000-0000-0000-000000000001",
    statement: "Council approved the transit budget.",
    unitType: "fact",
    embedding: [0.1, 0.2],
    embeddingModel: EMBEDDING_MODEL_TAG,
    sourceType: "scout",
  });

  assertEquals(result.createdCanonical, true);
  assertEquals(payload.p_embedding_model, EMBEDDING_MODEL_TAG);
});
