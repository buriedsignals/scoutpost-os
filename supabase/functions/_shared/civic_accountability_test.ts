import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  CIVIC_POLICY_VERSION,
  type CivicCandidate,
  type CivicRejectionCode,
  classifyCivicCandidate,
  classifyCivicCandidates,
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
