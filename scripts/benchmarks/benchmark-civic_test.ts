import { assertEquals } from "jsr:@std/assert@1";
import {
  calendarSemanticFailure,
  summarizeOutstandingCivicRows,
} from "./benchmark-civic.ts";
import {
  CIVIC_ACCOUNTABILITY_FIXTURES,
  CIVIC_FIXTURE_REFERENCE_DATE,
} from "./civic-accountability-fixtures.ts";
import { classifyCivicCandidate } from "../../supabase/functions/_shared/civic_accountability.ts";

Deno.test("civic benchmark reports the exact non-terminal queue lease", () => {
  assertEquals(
    summarizeOutstandingCivicRows([
      {
        id: "done-id",
        status: "done",
        attempts: 1,
        updated_at: "2026-07-20T09:40:00Z",
        last_error: null,
      },
      {
        id: "stuck-id",
        status: "processing",
        attempts: 2,
        updated_at: "2026-07-20T09:41:00Z",
        last_error: "provider timeout",
      },
    ]),
    [
      "stuck-id:processing:attempts=2:updated=2026-07-20T09:41:00Z:error=provider timeout",
    ],
  );
});

Deno.test("Zurich calendar is a semantic-zero hard negative", () => {
  assertEquals(calendarSemanticFailure(0), null);
  assertEquals(
    calendarSemanticFailure(1),
    "calendar hard-negative produced 1 promise tracker row(s)",
  );
});

Deno.test("versioned Civic corpus meets minimum labels and policy outcomes", () => {
  const expectedCounts = { promise: 20, decision: 10, rejected: 30 };
  const actual = { promise: 0, decision: 0, rejected: 0 };
  for (const fixture of CIVIC_ACCOUNTABILITY_FIXTURES) {
    const result = classifyCivicCandidate(fixture.candidate, {
      today: CIVIC_FIXTURE_REFERENCE_DATE,
    });
    const actualKind = result.outcome === "eligible"
      ? result.item.kind
      : "rejected";
    assertEquals(actualKind, fixture.expected, fixture.id);
    actual[fixture.expected]++;
  }
  assertEquals(actual, expectedCounts);
  assertEquals(
    new Set(CIVIC_ACCOUNTABILITY_FIXTURES.map((fixture) => fixture.language)),
    new Set(["en", "de", "fr"]),
  );
});
