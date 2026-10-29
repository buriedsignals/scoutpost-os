import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { type CivicCandidate } from "./civic_accountability.ts";
import {
  type CivicModelOperation,
  extractCivicCandidates,
} from "./civic_candidate_extraction.ts";

const election = {
  kind: "decision",
  statement: "The Grand Council elected Philip Karger to the GSK.",
  context: "Der Grosse Rat beschliesst die Wahl von Philip Karger",
} as CivicCandidate;

// Each pass answers from its own queue; the last answer repeats.
async function run(
  answers: Record<CivicModelOperation, Array<CivicCandidate[] | null>>,
) {
  const calls: CivicModelOperation[] = [];
  const result = await extractCivicCandidates(
    "Der Grosse Rat beschliesst die Wahl von Philip Karger",
    { criteria: null, languageName: "English", referenceDate: "2026-06-24" },
    (_prompt, _schema, operation) => {
      calls.push(operation);
      const queue = answers[operation];
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return Promise.resolve(next === null ? null : { candidates: next });
    },
  );
  return { ...result, calls };
}

Deno.test("Civic extraction retries an empty pass once", async (t) => {
  // 2026-10-29 replays of the same Basel minutes: the proposer returned
  // nothing in 2 of 10 runs and the verifier dropped all 8 candidates in 1.
  await t.step("empty proposal is retried", async () => {
    const r = await run({
      civic_extract_promises: [[], [election]],
      civic_verify_accountability: [[election]],
    });
    assertEquals(r.verified, [election]);
    assertEquals(r.calls, [
      "civic_extract_promises",
      "civic_extract_promises",
      "civic_verify_accountability",
    ]);
  });
  await t.step("empty verification of real proposals is retried", async () => {
    const r = await run({
      civic_extract_promises: [[election]],
      civic_verify_accountability: [null, [election]],
    });
    assertEquals(r.verified, [election]);
    assertEquals(r.calls.length, 3);
  });
  await t.step(
    "a genuinely empty document costs one retry, no verifier",
    async () => {
      const r = await run({
        civic_extract_promises: [[]],
        civic_verify_accountability: [[election]],
      });
      assertEquals(r.proposed, []);
      assertEquals(r.verified, []);
      assertEquals(r.calls, [
        "civic_extract_promises",
        "civic_extract_promises",
      ]);
    },
  );
  await t.step("a non-empty first pass is not repeated", async () => {
    const r = await run({
      civic_extract_promises: [[election]],
      civic_verify_accountability: [[election]],
    });
    assertEquals(r.calls, [
      "civic_extract_promises",
      "civic_verify_accountability",
    ]);
  });
});
