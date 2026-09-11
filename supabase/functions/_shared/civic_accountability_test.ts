import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  CIVIC_POLICY_VERSION,
  type CivicCandidate,
  type CivicRejectionCode,
  classifyCivicCandidate,
  classifyCivicCandidates,
  retainCivicPromiseAlertItems,
  shouldAlertForNewCivicItem,
} from "./civic_accountability.ts";

const TODAY = "2026-08-10";

function promise(overrides: Partial<CivicCandidate> = {}): CivicCandidate {
  return {
    kind: "promise",
    statement:
      "The transport department will publish the safety audit by 30 November 2026.",
    context:
      "The adopted resolution directs the transport department to publish the safety audit by 30 November 2026.",
    actor: "transport department",
    action: "publish the safety audit",
    adopted: true,
    material: true,
    criteria_match: true,
    evidence_supported: true,
    meeting_date: "2026-07-15",
    due_date: "2026-11-30",
    due_date_text: "by 30 November 2026",
    date_confidence: "high",
    date_role: "fulfilment",
    ...overrides,
  };
}

Deno.test("Civic policy version is explicit", () => {
  assertEquals(CIVIC_POLICY_VERSION, "civic-accountability-v2");
});

Deno.test("Civic accountability accepts a dated adopted promise", () => {
  const result = classifyCivicCandidate(promise(), { today: TODAY });
  assertEquals(result, {
    outcome: "eligible",
    item: {
      kind: "promise",
      statement:
        "The transport department will publish the safety audit by 30 November 2026.",
      context:
        "The adopted resolution directs the transport department to publish the safety audit by 30 November 2026.",
      actor: "transport department",
      action: "publish the safety audit",
      meeting_date: "2026-07-15",
      due_date: "2026-11-30",
      due_date_text: "by 30 November 2026",
      date_confidence: "high",
    },
  });
});

Deno.test("Civic accountability accepts an adopted material decision without a deadline", () => {
  const result = classifyCivicCandidate({
    kind: "decision",
    statement: "Council adopted the housing affordability ordinance.",
    context: "The council voted to adopt the housing affordability ordinance.",
    adopting_body: "Council",
    decision_kind: "ordinance adoption",
    adopted: true,
    material: true,
    criteria_match: true,
    evidence_supported: true,
    meeting_date: "2026-08-01",
  }, { today: TODAY });

  assertEquals(result.outcome, "eligible");
  if (result.outcome === "eligible") assertEquals(result.item.kind, "decision");
});

Deno.test("Civic immediate alerts announce only newly stored promises", () => {
  const promiseResult = classifyCivicCandidate(promise(), { today: TODAY });
  if (promiseResult.outcome !== "eligible") throw new Error("promise rejected");
  assertEquals(shouldAlertForNewCivicItem(promiseResult.item, true), true);
  assertEquals(shouldAlertForNewCivicItem(promiseResult.item, false), false);

  const decisionResult = classifyCivicCandidate({
    kind: "decision",
    statement: "Council adopted the housing affordability ordinance.",
    context: "The council voted to adopt the housing affordability ordinance.",
    adopting_body: "Council",
    decision_kind: "ordinance adoption",
    adopted: true,
    material: true,
    criteria_match: true,
    evidence_supported: true,
    meeting_date: "2026-08-01",
  }, { today: TODAY });
  if (decisionResult.outcome !== "eligible") {
    throw new Error("decision rejected");
  }
  assertEquals(shouldAlertForNewCivicItem(decisionResult.item, true), false);
});

Deno.test("Civic delivery drops legacy decision alert rows", () => {
  const promiseItem = { id: "alert-promise", unit_id: "promise-unit" };
  const decisionItem = { id: "alert-decision", unit_id: "decision-unit" };
  assertEquals(
    retainCivicPromiseAlertItems(
      [promiseItem, decisionItem],
      ["promise-unit"],
    ),
    [promiseItem],
  );
  assertEquals(
    retainCivicPromiseAlertItems([decisionItem], []),
    [],
  );
});

Deno.test("Civic accountability rejects the Zurich calendar pattern", () => {
  const result = classifyCivicCandidate(
    promise({
      statement:
        "The council will hold a meeting on August 19, 2026, from 5 PM.",
      context:
        "The council will hold meetings on August 19, 2026, from 5 PM to after 9:30 PM.",
      actor: null,
      action: null,
      adopted: false,
      due_date: "2026-08-19",
      due_date_text: "August 19, 2026",
      date_role: "meeting",
    }),
    { today: TODAY },
  );

  assertEquals(result, { outcome: "rejected", code: "routine_schedule" });
});

Deno.test("Civic accountability rejects a named municipal meeting date", () => {
  const result = classifyCivicCandidate({
    kind: "decision",
    statement:
      "The municipality of Pontresina will hold its 2026-2 community meeting on June 22, 2026.",
    context: "Gemeindeversammlung 2026-2 vom 22. Juni 2026",
    adopting_body: "Municipality of Pontresina",
    decision_kind: "community meeting",
    adopted: true,
    material: true,
    criteria_match: true,
    evidence_supported: true,
    meeting_date: "2026-06-22",
  }, { today: TODAY });

  assertEquals(result, { outcome: "rejected", code: "routine_schedule" });
});

Deno.test("Civic accountability rejects meeting dates used as deadlines", () => {
  const result = classifyCivicCandidate(
    promise({
      due_date: "2026-11-30",
      due_date_text: "meeting on 30 November 2026",
      date_role: "meeting",
    }),
    { today: TODAY },
  );
  assertEquals(result, { outcome: "rejected", code: "date_role_invalid" });
});

Deno.test("Civic accountability permits an action explicitly due at a meeting", () => {
  const result = classifyCivicCandidate(
    promise({
      statement:
        "The clerk will submit the audit at the 30 November 2026 council meeting.",
      context:
        "The adopted motion directs the clerk to submit the audit at the 30 November 2026 council meeting.",
      action: "submit the audit",
      due_date: "2026-11-30",
      due_date_text: "at the 30 November 2026 council meeting",
      date_role: "fulfilment",
    }),
    { today: TODAY },
  );
  assertEquals(result.outcome, "eligible");
});

Deno.test("Civic schedule filter preserves an accountability promise mentioning a meeting", () => {
  const result = classifyCivicCandidate(
    promise({
      statement:
        "The mayor will hold the contractor accountable for completing the school by 30 November 2026.",
      context:
        "At the September meeting, the adopted motion states that the mayor will hold the contractor accountable for completing the school by 30 November 2026.",
      actor: "mayor",
      action: "hold the contractor accountable for completing the school",
    }),
    { today: TODAY },
  );
  assertEquals(result.outcome, "eligible");
});

Deno.test("Civic accountability requires a source-supported due date", () => {
  const result = classifyCivicCandidate(
    promise({
      due_date: null,
      due_date_text: null,
      date_confidence: null,
      date_role: "unknown",
    }),
    { today: TODAY },
  );
  assertEquals(result, { outcome: "rejected", code: "date_role_invalid" });
});

Deno.test("Civic accountability rejects model-asserted evidence absent from retained source", () => {
  const result = classifyCivicCandidate(
    promise({
      context:
        "The adopted motion directs the clerk to publish the audit by 30 November 2026.",
      due_date_text: "by 30 November 2026",
    }),
    {
      today: TODAY,
      sourceText: "The official source only contains a meeting agenda.",
    },
  );
  assertEquals(result, { outcome: "rejected", code: "unsupported_evidence" });
});

Deno.test("Civic accountability rejects unadopted discussion before other missing fields", () => {
  const result = classifyCivicCandidate(
    promise({
      statement: "Council discussed a proposal to improve housing.",
      context: "Members discussed a proposal and made no decision.",
      adopted: false,
      actor: null,
      action: null,
    }),
    { today: TODAY },
  );
  assertEquals(result, { outcome: "rejected", code: "not_adopted" });
});

Deno.test("Civic accountability treats a semantic zero as a successful empty classification", () => {
  const result = classifyCivicCandidates([
    promise({
      statement: "Committee meeting begins at 5 PM.",
      context: "Committee meeting begins at 5 PM and ends at 7 PM.",
      adopted: false,
      actor: null,
      action: null,
      date_role: "meeting",
    }),
  ], { today: TODAY });
  assertEquals(result.items, []);
  assertEquals(result.rejectionCounts.routine_schedule, 1);
});

Deno.test("Civic accountability applies the documented rejection precedence", () => {
  const cases: Array<[string, CivicCandidate, CivicRejectionCode]> = [
    [
      "unsupported evidence",
      promise({ evidence_supported: false }),
      "unsupported_evidence",
    ],
    [
      "procedural action",
      promise({
        statement: "Council approved minutes.",
        context: "Council approved minutes.",
        action: "approve minutes",
      }),
      "procedural_only",
    ],
    ["missing actor", promise({ actor: null }), "missing_actor"],
    ["missing action", promise({ action: null }), "missing_action"],
    [
      "missing due date",
      promise({ due_date: null, due_date_text: null, date_role: "fulfilment" }),
      "missing_due_date",
    ],
    ["past due", promise({ due_date: "2026-08-09" }), "past_due"],
    ["immaterial", promise({ material: false }), "immaterial"],
    [
      "criteria mismatch",
      promise({ criteria_match: false }),
      "criteria_mismatch",
    ],
  ];
  for (const [name, candidate, code] of cases) {
    const result = classifyCivicCandidate(candidate, { today: TODAY });
    assertEquals(result, { outcome: "rejected", code }, name);
  }
});

const leedsAgendaItems = [
  {
    "statement":
      "To consider any appeals in accordance with Procedure Rule 15.2 of the Access to Information Rules.",
    "context":
      "APPEALS AGAINST REFUSAL OF INSPECTION\nOF DOCUMENTS\n\n                         To consider any appeals in accordance with\n                         Procedure Rule 15.2 of the Access to Information\n                         Rules (in the event of an Appeal the press and\n                         public will be excluded)",
    "decision_kind": "agenda item consideration",
  },
  {
    "statement":
      "To consider whether or not to accept the officers recommendation in respect of the above information.",
    "context":
      "1 To highlight reports or appendices which officers\n                         have identified as containing exempt information,\n                         and where officers consider that the public interest\n                         in maintaining the exemption outweighs the public\n                         interest in disclosing the information,\n                         for the\n                         reasons outlined in the report.\n\n                         2 To consider whether or not to accept the officers\n                         recommendation in respect of the above\n                         information.",
    "decision_kind": "agenda item consideration",
  },
  {
    "statement":
      "To disclose or draw attention to any interests in accordance with Leeds City Council’s ‘Councillor Code of Conduct’.",
    "context":
      "DECLARATION OF INTERESTS\n\n                         To disclose or draw attention to any interests in\n                         accordance with Leeds City Council’s ‘Councillor\n                         Code of Conduct’.",
    "decision_kind": "agenda item consideration",
  },
  {
    "statement":
      "To receive any apologies for absence and notification of substitutes.",
    "context":
      "APOLOGIES FOR ABSENCE\n\n                         To receive any apologies for absence and\n                         notification of substitutes.",
    "decision_kind": "agenda item consideration",
  },
  {
    "statement":
      "To receive and consider the attached minutes of the previous meeting held on the 8th of June 2026.",
    "context":
      "MINUTES 5 - 12\n\n                         To receive and consider the attached minutes of\n                         the previous meeting held on the 8th of June 2026.",
    "decision_kind": "agenda item consideration",
  },
  {
    "statement":
      "To update Members on the requirements of the next stage of consultation on the Leeds Local Plan: the Plan Content and Evidence stage.",
    "context":
      "LEEDS LOCAL PLAN NEXT STEPS 13 -\n                                                                               52\n\n                         The purpose of this report is to update Members\n                         on the requirements of the next stage of\n                         consultation on the Leeds Local Plan: the Plan\n                         Content and Evidence stage. It details work on the\n                         Vision, Aims and Measurable Outcomes of the\n                         Plan, as well as preferred approaches on the\n                         spatial strategy and settlement hierarchy,\n                         particularly as it relates to the distribution of\n                         housing. The report also provides an initial, high-\n                         level summary of the Local Plan Scoping\n                         Consultation.",
    "decision_kind": "agenda item consideration",
  },
  {
    "statement":
      "To note the date and time of the next meeting as the 13th of October 2026 at 1:30pm.",
    "context":
      "DATE AND TIME OF NEXT MEETING\n\n                         To note the date and time of the next meeting as\n                         the 13th of October 2026 at 1:30pm.",
    "decision_kind": "agenda item consideration",
  },
  {
    "statement":
      "Any published recording should be accompanied by a statement of when and where the recording was made, the context of the discussion that took place, and a clear identification of the main speakers and their role or title.",
    "context":
      "Use of Recordings by Third Parties– code of practice\n\n          a)   Any published recording should be accompanied by a statement of when and where the recording was made, the context of\n               the discussion that took place, and a clear identification of the main speakers and their role or title.",
    "decision_kind": "code of practice",
  },
];

Deno.test("Civic rejects the eight Leeds agenda instructions even when the model labels them adopted", () => {
  for (const item of leedsAgendaItems) {
    const result = classifyCivicCandidate({
      ...item,
      kind: "decision",
      adopting_body: "Strategic Planning Panel",
      adopted: true,
      material: true,
      evidence_supported: true,
      criteria_match: true,
    }, { today: TODAY, sourceText: item.context });
    assertEquals(result.outcome, "rejected", item.statement);
  }
});

Deno.test("Civic preserves adopted German and French decisions and rejects pending consideration", () => {
  const cases = [
    [
      "Der Gemeinderat hat den Kredit von 2 Millionen Franken für die Schulsanierung beschlossen.",
      true,
    ],
    [
      "Le conseil a adopté un crédit de deux millions de francs pour rénover l’école.",
      true,
    ],
    ["Zur Kenntnisnahme des Berichts.", false],
    ["Pour examen du rapport par le conseil.", false],
  ] as const;
  for (const [statement, accepted] of cases) {
    const result = classifyCivicCandidate({
      kind: "decision",
      statement,
      context: statement,
      adopting_body: "Council",
      decision_kind: "resolution",
      adopted: true,
      material: true,
      evidence_supported: true,
    }, { today: TODAY, sourceText: statement });
    assertEquals(result.outcome, accepted ? "eligible" : "rejected", statement);
  }
});

Deno.test("Civic retains a newly adopted material recording transparency policy", () => {
  const statement =
    "Council adopted a requirement to publish all recordings with accessible transcripts.";
  const result = classifyCivicCandidate({
    kind: "decision",
    statement,
    context:
      "Council adopted a requirement to publish all recordings with accessible transcripts.",
    adopting_body: "Council",
    decision_kind: "transparency policy",
    adopted: true,
    material: true,
    evidence_supported: true,
  }, { today: TODAY });
  assertEquals(result.outcome, "eligible");
});
