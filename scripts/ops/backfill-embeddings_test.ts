import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  embeddingInput,
  parseAction,
  TARGET_DIMENSIONS,
  TARGET_TAG,
} from "./backfill-embeddings.ts";

Deno.test("backfill defaults to read-only inventory", () => {
  assertEquals(parseAction(undefined), "inventory");
  assertEquals(parseAction("stage"), "stage");
  assertEquals(parseAction("apply"), "apply");
});

Deno.test("backfill rejects an unknown action", async () => {
  await assertRejects(
    async () => parseAction("overwrite"),
    Error,
    "inventory, stage, or apply",
  );
});

Deno.test("backfill builds typed 768d OpenRouter document inputs", () => {
  assertEquals(TARGET_DIMENSIONS, 768);
  assertEquals(TARGET_TAG.includes("openrouter-google-gemini"), true);
  assertEquals(
    embeddingInput("information_units", {
      id: "1",
      statement: "Council approved the budget",
      source_title: "Minutes",
    }),
    {
      text: "Council approved the budget",
      taskType: "RETRIEVAL_DOCUMENT",
      title: "Minutes",
    },
  );
});
