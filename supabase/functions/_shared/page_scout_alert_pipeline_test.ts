import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { PageScoutCriteriaResult } from "./page_scout_criteria.ts";
import {
  analyzePageScoutAlert,
  type PageScoutAlertAnalysisDependencies,
  renderPageScoutCriteriaDelta,
} from "./page_scout_alert_pipeline.ts";
import { buildPageContentDiff } from "./page_scout_change.ts";
import { shouldSendPageScoutAlert } from "./page_scout_notifications.ts";

const MATCH: PageScoutCriteriaResult = {
  matches: true,
  matchingPassages: ["Registration closes on 15 August."],
  acceptedFindings: [{
    beforeQuote: "Registration closes on 1 August.",
    afterQuote: "Registration closes on 15 August.",
    criterion: "Alert when the registration deadline changes.",
    explanation: "The registration deadline changed.",
  }],
  agentReason: "The requested deadline changed.",
  certainty: "certain",
};

const NO_MATCH: PageScoutCriteriaResult = {
  matches: false,
  matchingPassages: [],
  acceptedFindings: [],
  agentReason: "Only the navigation instructions changed.",
  certainty: "certain",
};

function changedDiff() {
  return buildPageContentDiff(
    "Registration closes on 1 August.",
    "Registration closes on 15 August.",
  );
}

Deno.test("criteria delta includes context for Google feedback identifier churn", () => {
  const before = [
    "Policy body unchanged.",
    "Enable Dark Mode",
    "Send feedback on...",
    "This help content & information General Help Center experience",
    "2507032178178457788",
    "true",
    "Search Help Center",
    "false",
  ].join("\n");
  const after = before.replace(
    "2507032178178457788",
    "16235620894640803440",
  );

  const delta = renderPageScoutCriteriaDelta(
    buildPageContentDiff(before, after),
  );

  assertStringIncludes(
    delta,
    [
      "CONTEXT: Enable Dark Mode",
      "CONTEXT: Send feedback on...",
      "CONTEXT: This help content & information General Help Center experience",
      "REMOVED[R1]: 2507032178178457788",
      "CONTEXT: true",
      "CONTEXT: Search Help Center",
      "CONTEXT: false",
    ].join("\n"),
  );
  assertStringIncludes(
    delta,
    [
      "CONTEXT: Enable Dark Mode",
      "CONTEXT: Send feedback on...",
      "CONTEXT: This help content & information General Help Center experience",
      "ADDED[A1]: 16235620894640803440",
      "CONTEXT: true",
      "CONTEXT: Search Help Center",
      "CONTEXT: false",
    ].join("\n"),
  );
});

function dependencies(
  decision: PageScoutCriteriaResult,
  calls: { decisions: number; enrichments: number },
): PageScoutAlertAnalysisDependencies<{ units: string[] }> {
  return {
    evaluateCriteria: (input) => {
      calls.decisions++;
      assertEquals(
        input.criteria,
        "Alert when the registration deadline changes.",
      );
      assertEquals(
        input.delta.includes("REMOVED[R1]: Registration closes on 1 August."),
        true,
      );
      assertEquals(
        input.delta.includes("ADDED[A1]: Registration closes on 15 August."),
        true,
      );
      return Promise.resolve(decision);
    },
    enrichMatchingDelta: () => {
      calls.enrichments++;
      return Promise.resolve({ units: ["The deadline is 15 August."] });
    },
  };
}

Deno.test("specific-change pipeline: the agent's positive judgment is the sole semantic alert gate", async () => {
  const calls = { decisions: 0, enrichments: 0 };
  const result = await analyzePageScoutAlert({
    criteria: "Alert when the registration deadline changes.",
    diff: changedDiff(),
    changeStatus: "changed",
    initialBaseline: false,
    timeoutMs: 1_000,
  }, dependencies(MATCH, calls));

  assertEquals(result.criteriaDecision, MATCH);
  assertEquals(result.alertEligible, true);
  assertEquals(result.enrichment, {
    units: ["The deadline is 15 August."],
  });
  assertEquals(calls, { decisions: 1, enrichments: 1 });
  assertEquals(
    shouldSendPageScoutAlert({
      alert_eligible: result.alertEligible,
      articles_count: 0,
      criteria_ran: true,
    }),
    true,
  );
});

Deno.test("specific-change pipeline: a certain negative judgment skips enrichment and notification", async () => {
  const calls = { decisions: 0, enrichments: 0 };
  const result = await analyzePageScoutAlert({
    criteria: "Alert when the registration deadline changes.",
    diff: changedDiff(),
    changeStatus: "changed",
    initialBaseline: false,
    timeoutMs: 1_000,
  }, dependencies(NO_MATCH, calls));

  assertEquals(result.criteriaDecision, NO_MATCH);
  assertEquals(result.alertEligible, false);
  assertEquals(result.enrichment, null);
  assertEquals(calls, { decisions: 1, enrichments: 0 });
  assertEquals(
    shouldSendPageScoutAlert({
      alert_eligible: result.alertEligible,
      articles_count: 4,
      criteria_ran: true,
    }),
    false,
  );
});

Deno.test("specific-change pipeline: an unavailable judgment cannot fall through to enrichment or notification", async () => {
  let enrichments = 0;
  await assertRejects(
    () =>
      analyzePageScoutAlert({
        criteria: "Alert when the registration deadline changes.",
        diff: changedDiff(),
        changeStatus: "changed",
        initialBaseline: false,
        timeoutMs: 1_000,
      }, {
        evaluateCriteria: () => Promise.reject(new Error("agent unavailable")),
        enrichMatchingDelta: () => {
          enrichments++;
          return Promise.resolve({ units: [] });
        },
      }),
    Error,
    "agent unavailable",
  );
  assertEquals(enrichments, 0);
});

Deno.test("specific-change pipeline: initial baselines and unchanged pages never invoke the agent", async () => {
  for (
    const scenario of [
      {
        diff: changedDiff(),
        changeStatus: "new" as const,
        initialBaseline: true,
      },
      {
        diff: buildPageContentDiff("same", "same"),
        changeStatus: "same" as const,
        initialBaseline: false,
      },
    ]
  ) {
    const calls = { decisions: 0, enrichments: 0 };
    const result = await analyzePageScoutAlert({
      criteria: "Alert when the registration deadline changes.",
      timeoutMs: 1_000,
      ...scenario,
    }, dependencies(MATCH, calls));
    assertEquals(result.alertEligible, false);
    assertEquals(result.criteriaDecision, null);
    assertEquals(result.enrichment, null);
    assertEquals(calls, { decisions: 0, enrichments: 0 });
  }
});

Deno.test("any-change pipeline remains independent of the criteria agent", async () => {
  const calls = { decisions: 0, enrichments: 0 };
  const result = await analyzePageScoutAlert({
    criteria: null,
    diff: changedDiff(),
    changeStatus: "changed",
    initialBaseline: false,
    timeoutMs: 1_000,
  }, dependencies(MATCH, calls));

  assertEquals(result.alertEligible, true);
  assertEquals(result.criteriaDecision, null);
  assertEquals(result.enrichment, null);
  assertEquals(calls, { decisions: 0, enrichments: 0 });
});
