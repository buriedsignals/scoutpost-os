import { assertEquals, assertStrictEquals } from "jsr:@std/assert";
import {
  confusion,
  cosineSimilarity,
  hardNegativeConflict,
  type PairFixture,
} from "./benchmark-openrouter-embeddings.ts";

Deno.test("cosine similarity handles identical and orthogonal vectors", () => {
  assertEquals(cosineSimilarity([1, 0], [1, 0]), 1);
  assertEquals(cosineSimilarity([1, 0], [0, 1]), 0);
});

Deno.test("hard-negative guards catch numeric, date, outcome, and entity conflicts", () => {
  const pairs: PairFixture[] = [
    {
      id: "n",
      duplicate: false,
      guard: "numeric",
      left: "CHF 12",
      right: "CHF 21",
    },
    {
      id: "d",
      duplicate: false,
      guard: "date",
      left: "a",
      right: "b",
      left_date: "2026-01-01",
      right_date: "2026-01-03",
    },
    {
      id: "o",
      duplicate: false,
      guard: "outcome",
      left: "a",
      right: "b",
      left_outcome: "passed",
      right_outcome: "failed",
    },
    {
      id: "e",
      duplicate: false,
      guard: "entity",
      left: "a",
      right: "b",
      left_entities: ["Bern"],
      right_entities: ["Zurich"],
    },
  ];
  assertStrictEquals(pairs.every(hardNegativeConflict), true);
});

Deno.test("guarded confusion suppresses a high-scoring hard negative", () => {
  const pairs: PairFixture[] = [
    { id: "p", duplicate: true, left: "a", right: "b" },
    {
      id: "n",
      duplicate: false,
      guard: "numeric",
      left: "CHF 12",
      right: "CHF 21",
    },
  ];
  assertEquals(confusion(pairs, [0.9, 0.95], 0.8, true), {
    threshold: 0.8,
    tp: 1,
    fp: 0,
    fn: 0,
    tn: 1,
    precision: 1,
    recall: 1,
    f1: 1,
  });
});
