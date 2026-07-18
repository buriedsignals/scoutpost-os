import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  cosineSimilarity,
  hasStructuredConflict,
  isWithinRunDuplicateWithGuards,
} from "./dedup.ts";

Deno.test("cosineSimilarity: identical vectors → 1", () => {
  assertEquals(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
});

Deno.test("cosineSimilarity: orthogonal vectors → 0", () => {
  assertEquals(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
});

Deno.test("cosineSimilarity: mismatched length → 0", () => {
  assertEquals(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

Deno.test("cosineSimilarity: zero vector → 0", () => {
  assertEquals(cosineSimilarity([0, 0], [1, 0]), 0);
});

Deno.test("guarded within-run dedup applies calibrated and custom thresholds", () => {
  const candidate = {
    statement: "Council approved the plan",
    embedding: [1, 0, 0],
  };
  assertEquals(isWithinRunDuplicateWithGuards(candidate, []), false);
  assertEquals(
    isWithinRunDuplicateWithGuards(candidate, [{ ...candidate }]),
    true,
  );
  const prior = {
    statement: "The council approved the plan",
    embedding: [0.8, 0.6, 0],
  };
  assertEquals(isWithinRunDuplicateWithGuards(candidate, [prior]), false);
  assertEquals(isWithinRunDuplicateWithGuards(candidate, [prior], 0.75), true);
  const calibratedMatch = {
    statement: "The council approved the plan",
    embedding: [0.9, Math.sqrt(0.19), 0],
  };
  assertEquals(
    isWithinRunDuplicateWithGuards(candidate, [calibratedMatch]),
    true,
  );
});

Deno.test("structured guards reject changed facts despite identical vectors", () => {
  assertEquals(
    hasStructuredConflict(
      "Council approved CHF 5 million on 2026-07-10",
      "Council approved CHF 8 million on 2026-07-12",
    ),
    true,
  );
  assertEquals(
    hasStructuredConflict(
      "Council approved the plan",
      "Council rejected the plan",
    ),
    true,
  );
  assertEquals(
    isWithinRunDuplicateWithGuards(
      { statement: "Council approved CHF 5 million", embedding: [1, 0] },
      [{ statement: "Council approved CHF 8 million", embedding: [1, 0] }],
    ),
    false,
  );
});
