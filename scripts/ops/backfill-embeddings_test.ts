import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  embeddingInput,
  parseDryRun,
  TARGET_DIMENSIONS,
  TARGET_TAG,
  validateEmbeddingResponse,
} from "./backfill-embeddings.ts";

Deno.test("backfill defaults to dry-run", () => {
  assertEquals(parseDryRun(undefined), true);
  assertEquals(parseDryRun("false"), false);
});

Deno.test("backfill builds table-specific document inputs", () => {
  assertEquals(
    embeddingInput("information_units", {
      id: "1",
      statement: "Council approved the budget",
      source_title: "Minutes",
    }),
    {
      text: "Council approved the budget",
      task_type: "RETRIEVAL_DOCUMENT",
      title: "Minutes",
    },
  );
});

Deno.test("backfill validates the exact 768d model contract and response order", () => {
  const a = new Array(TARGET_DIMENSIONS).fill(1);
  const b = new Array(TARGET_DIMENSIONS).fill(2);
  assertEquals(
    validateEmbeddingResponse({
      model: TARGET_TAG,
      dimensions: TARGET_DIMENSIONS,
      data: [{ index: 1, embedding: b }, { index: 0, embedding: a }],
    }, 2),
    [a, b],
  );
});

Deno.test("backfill rejects a mixed or malformed model space", async () => {
  await assertRejects(
    async () => {
      validateEmbeddingResponse({
        model: "old-model",
        dimensions: 1536,
        data: [],
      }, 1);
    },
    Error,
    "contract mismatch",
  );
});
