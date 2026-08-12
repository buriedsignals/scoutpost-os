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

Deno.test("criteria delta suppresses Google feedback identifier churn", () => {
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

  const diff = buildPageContentDiff(before, after);
  assertEquals(diff.hasChanges, false);
  assertEquals(renderPageScoutCriteriaDelta(diff).includes("ADDED["), false);
});

Deno.test("criteria delta anchors repeated text to its added section", () => {
  const repeated = "Software wallets are allowed with limitations.";
  const delta = renderPageScoutCriteriaDelta(buildPageContentDiff(
    ["## European Union", repeated, "Existing condition"].join("\n"),
    [
      "## European Union",
      repeated,
      "Existing condition",
      "## Iceland",
      repeated,
      "New condition",
    ].join("\n"),
  ));

  assertStringIncludes(delta, "SECTION: ## Iceland");
  assertStringIncludes(
    delta,
    "OCCURRENCE: identical text count changed from 1 to 2; this is an additional occurrence, not new wording.",
  );
  assertStringIncludes(
    delta,
    "ADDED[A2]: Software wallets are allowed with limitations.",
  );
});

Deno.test("criteria delta treats a unique removal as ordinary removal evidence", () => {
  const delta = renderPageScoutCriteriaDelta(buildPageContentDiff(
    ["## Policy", "Unique removed evidence.", "Retained evidence."].join("\n"),
    ["## Policy", "Retained evidence."].join("\n"),
  ));

  assertStringIncludes(delta, "REMOVED[R1]: Unique removed evidence.");
  assertEquals(delta.includes("OCCURRENCE:"), false);
});

Deno.test("criteria delta keeps duplicate-removal occurrence context", () => {
  const repeated = "Repeated evidence.";
  const delta = renderPageScoutCriteriaDelta(buildPageContentDiff(
    ["## Policy", repeated, repeated, "Retained evidence."].join("\n"),
    ["## Policy", repeated, "Retained evidence."].join("\n"),
  ));

  assertStringIncludes(
    delta,
    "OCCURRENCE: identical text count changed from 2 to 1; this is a removed occurrence, not new wording.",
  );
  assertStringIncludes(delta, "REMOVED[R1]: Repeated evidence.");
});

Deno.test("criteria delta keeps duplicate numbered movement in its own section", () => {
  const delta = renderPageScoutCriteriaDelta(buildPageContentDiff(
    [
      "## First",
      "1. Repeated item",
      "2. First-only item",
      "## Second",
      "1. Repeated item",
      "2. Second-only item",
    ].join("\n"),
    [
      "## First",
      "1. First-only item",
      "2. Repeated item",
      "## Second",
      "1. Repeated item",
      "2. Second-only item",
    ].join("\n"),
  ));

  assertStringIncludes(delta, "SECTION BEFORE: ## First");
  assertStringIncludes(delta, "MOVED[M");
  assertStringIncludes(delta, "1 -> 2 | Repeated item");
});

Deno.test("criteria delta retains pure reordering as diagnostic move evidence", () => {
  const delta = renderPageScoutCriteriaDelta(buildPageContentDiff(
    "1. Austria\n2. Belgium\n3. Croatia",
    "1. Belgium\n2. Austria\n3. Croatia",
  ));

  assertStringIncludes(delta, "MOVED[M1]: 2 -> 1 | Belgium");
  assertStringIncludes(delta, "MOVED[M2]: 1 -> 2 | Austria");
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

Deno.test("same-scope reorder and duplicate-only noise are hard-suppressed in both modes", async () => {
  const noiseDiffs = [
    buildPageContentDiff(
      "Registration\nVenue\nSchedule",
      "Venue\nRegistration\nSchedule",
    ),
    buildPageContentDiff(
      "1. Austria\n2. Belgium\n3. Croatia",
      "1. Belgium\n2. Austria\n3. Croatia",
    ),
    buildPageContentDiff(
      "## Policy\nExisting rule\nRepeated rule",
      "## Policy\nRepeated rule\nExisting rule\nRepeated rule",
    ),
    buildPageContentDiff(
      "## Policy\n1. Shared rule\n2. Other rule",
      "## Policy\n1. Shared rule\n2. Shared rule\n3. Other rule",
    ),
  ];

  for (const diff of noiseDiffs) {
    for (const criteria of [null, "Alert on any policy change."]) {
      let decisions = 0;
      const result = await analyzePageScoutAlert({
        criteria,
        diff,
        changeStatus: "changed",
        initialBaseline: false,
        timeoutMs: 1_000,
      }, {
        evaluateCriteria: () => {
          decisions++;
          return Promise.resolve(MATCH);
        },
      });

      assertEquals(result.alertEligible, false);
      assertEquals(result.criteriaDecision, null);
      assertEquals(decisions, 0);
    }
  }
});

Deno.test("cross-section identical wording remains alertable in Any Change", async () => {
  const result = await analyzePageScoutAlert({
    criteria: null,
    diff: buildPageContentDiff(
      "## European Union\nShared rule\n## Italy\nExisting rule",
      "## European Union\nShared rule\n## Italy\nShared rule\nExisting rule",
    ),
    changeStatus: "changed",
    initialBaseline: false,
    timeoutMs: 1_000,
  });

  assertEquals(result.alertEligible, true);
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
