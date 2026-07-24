import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPageContentDiff,
  decidePageScoutAlert,
} from "./page_scout_change.ts";

Deno.test("buildPageContentDiff ignores canonicalized technical noise", () => {
  const before =
    "Updated 2 minutes ago\n\n![Hero](https://cdn.test/a.png)\nPrice: CHF 50";
  const after =
    "Updated 8 minutes ago\n\n![Hero](https://cdn.test/b.png)\nPrice: CHF 50";
  assertEquals(buildPageContentDiff(before, after).hasChanges, false);
});

Deno.test("buildPageContentDiff captures user-visible additions and removals", () => {
  const diff = buildPageContentDiff(
    "# Registration\nOpens 1 August\nPrice CHF 50",
    "# Registration\nOpens 15 August\nPrice CHF 50",
  );
  assertEquals(diff.hasChanges, true);
  assertEquals(diff.removed, ["Opens 1 August"]);
  assertEquals(diff.added, ["Opens 15 August"]);
  assertStringIncludes(diff.summary, "Opens 15 August");
});

Deno.test("buildPageContentDiff never suppresses changes after the display bound", () => {
  const stable = Array.from({ length: 120 }, (_, index) => `Line ${index}`);
  const before = [...stable, "Registration opens 1 August"].join("\n");
  const after = [...stable, "Registration opens 15 August"].join("\n");
  const diff = buildPageContentDiff(before, after);
  assertEquals(diff.hasChanges, true);
  assertEquals(diff.added, ["Registration opens 15 August"]);
  assertEquals(diff.removed, ["Registration opens 1 August"]);
});

Deno.test("buildPageContentDiff retains changes late in a long visible line", () => {
  const prefix = "unchanged ".repeat(70);
  const diff = buildPageContentDiff(
    `${prefix}Registration opens 1 August`,
    `${prefix}Registration opens 15 August`,
  );
  assertEquals(diff.hasChanges, true);
  assertEquals(
    diff.added.some((line) => line.includes("Registration opens 15 August")),
    true,
  );
  assertEquals(
    diff.removed.some((line) => line.includes("Registration opens 1 August")),
    true,
  );
});

Deno.test("buildPageContentDiff excludes unchanged matching text between edits", () => {
  const diff = buildPageContentDiff(
    "Old heading\nRegistration opens 1 August\nOld footer",
    "New heading\nRegistration opens 1 August\nNew footer",
  );
  assertEquals(diff.added, ["New heading", "New footer"]);
  assertEquals(diff.removed, ["Old heading", "Old footer"]);
  assertEquals(diff.summary.includes("Registration opens 1 August"), false);
});

Deno.test("a visible content reorder is Any Change but never fabricates removal evidence", () => {
  const diff = buildPageContentDiff(
    "Registration\nVenue\nSchedule",
    "Venue\nRegistration\nSchedule",
  );
  assertEquals(diff.hasChanges, true);
  assertEquals(diff.removed, []);
  assertEquals(diff.added, []);
  assertEquals(diff.summary, "");
});

Deno.test("PS-ANY-001 Any Change follows a real normalized delta, not units or prose", () => {
  assertEquals(
    decidePageScoutAlert({
      mode: "any",
      changeStatus: "changed",
      hasNormalizedDiff: true,
      criteriaMatched: null,
      initialBaseline: false,
    }),
    true,
  );
  assertEquals(
    decidePageScoutAlert({
      mode: "any",
      changeStatus: "changed",
      hasNormalizedDiff: false,
      criteriaMatched: null,
      initialBaseline: false,
    }),
    false,
  );
});

Deno.test("Specific Changes follows the criteria decision on the delta", () => {
  assertEquals(
    decidePageScoutAlert({
      mode: "specific",
      changeStatus: "changed",
      hasNormalizedDiff: true,
      criteriaMatched: true,
      initialBaseline: false,
    }),
    true,
  );
  assertEquals(
    decidePageScoutAlert({
      mode: "specific",
      changeStatus: "changed",
      hasNormalizedDiff: true,
      criteriaMatched: false,
      initialBaseline: false,
    }),
    false,
  );
});

Deno.test("initial baselines never alert but a post-activation child addition can", () => {
  assertEquals(
    decidePageScoutAlert({
      mode: "any",
      changeStatus: "new",
      hasNormalizedDiff: true,
      criteriaMatched: null,
      initialBaseline: true,
    }),
    false,
  );
  assertEquals(
    decidePageScoutAlert({
      mode: "any",
      changeStatus: "new",
      hasNormalizedDiff: true,
      criteriaMatched: null,
      initialBaseline: false,
    }),
    true,
  );
});
