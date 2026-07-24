import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluatePageScoutCriteria,
  PageScoutCriteriaCoverageError,
} from "./page_scout_criteria.ts";

Deno.test("PS-SPEC-001 criteria evaluator returns a structured match without generated prose", async () => {
  const result = await evaluatePageScoutCriteria({
    criteria: "registration date changes",
    delta: "REMOVED: Opens 1 August\nADDED: Opens 15 August",
    timeoutMs: 100,
  }, {
    extract: () =>
      Promise.resolve({
        matches: true,
        matching_passages: ["ADDED: Opens 15 August"],
      }),
  });
  assertEquals(result, {
    matches: true,
    matchingPassages: ["ADDED: Opens 15 August"],
  });
});

Deno.test("PS-SPEC-002 criteria evaluator rejects hallucinated passages and false decisions", async () => {
  const hallucinated = await evaluatePageScoutCriteria({
    criteria: "registration date changes",
    delta: "ADDED: Contact email changed",
    timeoutMs: 100,
  }, {
    extract: () =>
      Promise.resolve({
        matches: true,
        matching_passages: ["Opens 15 August"],
      }),
  });
  assertEquals(hallucinated, { matches: false, matchingPassages: [] });

  const negative = await evaluatePageScoutCriteria({
    criteria: "registration date changes",
    delta: "ADDED: Contact email changed",
    timeoutMs: 100,
  }, {
    extract: () =>
      Promise.resolve({
        matches: false,
        matching_passages: [],
      }),
  });
  assertEquals(negative, { matches: false, matchingPassages: [] });
});

Deno.test("criteria evaluator can match removals without a generated description", async () => {
  const result = await evaluatePageScoutCriteria({
    criteria: "registration closing or being removed",
    delta: "REMOVED: Registration closes 15 August",
    timeoutMs: 100,
  }, {
    extract: () =>
      Promise.resolve({
        matches: true,
        matching_passages: ["REMOVED: Registration closes 15 August"],
      }),
  });
  assertEquals(result, {
    matches: true,
    matchingPassages: ["REMOVED: Registration closes 15 August"],
  });
});

Deno.test("criteria evaluation reaches matching changes beyond the first bounded batch", async () => {
  let calls = 0;
  const sentinel = "Registration closes permanently";
  const delta = Array.from(
    { length: 250 },
    (_, index) => `ADDED: ${"x".repeat(100)} ${index}`,
  ).concat(`REMOVED: ${sentinel}`).join("\n");
  const result = await evaluatePageScoutCriteria(
    {
      criteria: "alert when registration closes",
      delta,
      timeoutMs: 1_000,
    },
    {
      extract: async (prompt) => {
        calls++;
        return prompt.includes(sentinel)
          ? { matches: true, matching_passages: [sentinel] }
          : { matches: false, matching_passages: [] };
      },
    },
  );
  assertEquals(calls > 1, true);
  assertEquals(result, { matches: true, matchingPassages: [sentinel] });
});

Deno.test("oversized unmatched criteria deltas fail instead of silently advancing the baseline", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      evaluatePageScoutCriteria(
        {
          criteria: "alert when registration closes",
          delta: Array.from(
            { length: 2_000 },
            (_, index) => `ADDED: ${"x".repeat(100)} ${index}`,
          ).join("\n"),
          timeoutMs: 1_000,
        },
        {
          extract: () => {
            calls++;
            return Promise.resolve({
              matches: false,
              matching_passages: [],
            });
          },
        },
      ),
    PageScoutCriteriaCoverageError,
    "maximum is 8",
  );
  assertEquals(calls, 8);
});
