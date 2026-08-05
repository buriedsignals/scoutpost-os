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

Deno.test("PS-SPEC-001b only a grounded finding accepted by the verifier matches", async () => {
  const result = await evaluatePageScoutCriteria({
    criteria: "registration date changes",
    delta: "REMOVED: Opens 1 August\nADDED: Opens 15 August",
    timeoutMs: 100,
  }, {
    candidateExtract: () =>
      Promise.resolve({
        findings: [{
          before_quote: "Opens 1 August",
          after_quote: "Opens 15 August",
          criterion: "registration date changes",
          explanation: "The opening date changed.",
        }],
      }),
    verifyExtract: () =>
      Promise.resolve({
        verdict: "accept",
        inclusion_satisfied: true,
        exclusion_triggered: false,
      }),
  });
  assertEquals(result.matches, true);
  assertEquals(result.acceptedFindings?.length, 1);
});

Deno.test("PS-SPEC-001c verifier rejection is silent", async () => {
  const result = await evaluatePageScoutCriteria({
    criteria: "registration date changes",
    delta: "REMOVED: Opens 1 August\nADDED: Opens 15 August",
    timeoutMs: 100,
  }, {
    candidateExtract: () =>
      Promise.resolve({
        findings: [{
          before_quote: "Opens 1 August",
          after_quote: "Opens 15 August",
          criterion: "registration date changes",
          explanation: "The opening date changed.",
        }],
      }),
    verifyExtract: () =>
      Promise.resolve({
        verdict: "reject",
        inclusion_satisfied: false,
        exclusion_triggered: false,
      }),
  });
  assertEquals(result.matches, false);
  assertEquals(result.acceptedFindings, []);
});

Deno.test("policy criteria reject changed UI instructions even when the verifier says accept", async () => {
  const before =
    'Select the Settings icon at the bottom of the video player, select "Subtitles," and then specify your language.';
  const after =
    'Select the Settings icon Image of YouTube settings icon at the top right corner of the video player, select "Captions," and then specify your language.';
  const result = await evaluatePageScoutCriteria({
    criteria:
      "Report only substantive policy wording changes — added/removed/reworded rules, definitions, prohibited or allowed items, enforcement, scope, or effective/updated dates. Ignore navigation, styling, and boilerplate.",
    delta: `REMOVED: ${before}\nADDED: ${after}`,
    timeoutMs: 100,
  }, {
    candidateExtract: () =>
      Promise.resolve({
        findings: [{
          before_quote: before,
          after_quote: after,
          criterion: "substantive policy wording changes",
          explanation:
            "The location and label of the video caption control changed.",
        }],
      }),
    verifyExtract: () =>
      Promise.resolve({
        verdict: "accept" as const,
        inclusion_satisfied: false,
        exclusion_triggered: true,
      }),
  });

  assertEquals(result.matches, false);
  assertEquals(result.acceptedFindings, []);
  assertEquals(result.rejectedCount, 1);
});

Deno.test("PS-SPEC-001d reserves verification time after a Neunkirch-length candidate call", async () => {
  let now = 0;
  let candidateAbortAfterMs = 0;
  let verifierAbortAfterMs = 0;
  const result = await evaluatePageScoutCriteria({
    criteria: "Veranstaltungen, Termine, Aktualitäten",
    delta:
      "REMOVED: Veranstaltung am 1. August\nADDED: Veranstaltung am 15. August",
    timeoutMs: 20_000,
  }, {
    now: () => now,
    candidateExtract: (_prompt, _schema, request) => {
      candidateAbortAfterMs = request.abortAfterMs ?? 0;
      now += 6_371;
      return Promise.resolve({
        findings: [{
          before_quote: "Veranstaltung am 1. August",
          after_quote: "Veranstaltung am 15. August",
          criterion: "Veranstaltungen, Termine, Aktualitäten",
          explanation: "The event date changed.",
        }],
      });
    },
    verifyExtract: (_prompt, _schema, request) => {
      verifierAbortAfterMs = request.abortAfterMs ?? 0;
      return Promise.resolve({
        verdict: "accept" as const,
        inclusion_satisfied: true,
        exclusion_triggered: false,
      });
    },
  });
  assertEquals(candidateAbortAfterMs >= 15_000, true);
  assertEquals(verifierAbortAfterMs > 0, true);
  assertEquals(result.matches, true);
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

Deno.test("Google-style opaque numeric churn is a valid silent non-match", async () => {
  const result = await evaluatePageScoutCriteria({
    criteria:
      "Report only substantive policy wording changes; ignore navigation and boilerplate.",
    delta: "REMOVED: 2507032178178457788\nADDED: 5763032717498889961",
    timeoutMs: 100,
  }, {
    extract: () => Promise.resolve({ matches: false, matching_passages: [] }),
  });
  assertEquals(result, { matches: false, matchingPassages: [] });
});

Deno.test("Meta-style link spelling churn is a valid silent non-match", async () => {
  const sentence =
    "Ads cannot contain content debunked by third-party fact checkers.";
  const result = await evaluatePageScoutCriteria({
    criteria: "Report only substantive policy wording changes; ignore markup.",
    delta:
      `REMOVED: [${sentence}](https://example.com/policy)\nADDED: [${sentence}](https://example.com/policy/)`,
    timeoutMs: 100,
  }, {
    extract: () => Promise.resolve({ matches: false, matching_passages: [] }),
  });
  assertEquals(result, { matches: false, matchingPassages: [] });
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
  assertEquals(result, {
    matches: true,
    matchingPassages: [`REMOVED: ${sentinel}`],
  });
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
