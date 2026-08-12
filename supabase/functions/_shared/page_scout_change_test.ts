import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPageContentDiff,
  decidePageScoutAlert,
  pageTargetErrorMessage,
} from "./page_scout_change.ts";

Deno.test("Page target status rejects error pages without relabeling success", () => {
  assertEquals(pageTargetErrorMessage(200), null);
  assertEquals(pageTargetErrorMessage(undefined), null);
  assertEquals(pageTargetErrorMessage(404), "page returned HTTP 404");
  assertEquals(pageTargetErrorMessage(503), "page returned HTTP 503");
});

Deno.test("buildPageContentDiff ignores canonicalized technical noise", () => {
  const before =
    "Updated 2 minutes ago\n\n![Hero](https://cdn.test/a.png)\nPrice: CHF 50";
  const after =
    "Updated 8 minutes ago\n\n![Hero](https://cdn.test/b.png)\nPrice: CHF 50";
  const diff = buildPageContentDiff(before, after);
  assertEquals(diff.hasChanges, false);
  assertEquals(diff.changeClass, "none");
});

Deno.test("buildPageContentDiff captures user-visible additions and removals", () => {
  const diff = buildPageContentDiff(
    "# Registration\nOpens 1 August\nPrice CHF 50",
    "# Registration\nOpens 15 August\nPrice CHF 50",
  );
  assertEquals(diff.hasChanges, true);
  assertEquals(diff.changeClass, "content");
  assertEquals(diff.removed, ["Opens 1 August"]);
  assertEquals(diff.added, ["Opens 15 August"]);
  assertStringIncludes(diff.summary, "Opens 15 August");
});

Deno.test("buildPageContentDiff labels additions and removals without mixed diff markers", () => {
  const diff = buildPageContentDiff(
    "Policy heading\nOld enforcement rule",
    "Policy heading\nNew enforcement rule",
  );

  assertStringIncludes(diff.summary, "**Added:**\n- New enforcement rule");
  assertStringIncludes(diff.summary, "**Removed:**\n- Old enforcement rule");
  assertEquals(diff.summary.includes("+ New enforcement rule"), false);
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

Deno.test("a same-scope line reorder is deterministic non-alerting noise", () => {
  const diff = buildPageContentDiff(
    "Registration\nVenue\nSchedule",
    "Venue\nRegistration\nSchedule",
  );
  assertEquals(diff.hasChanges, true);
  assertEquals(diff.changeClass, "same_scope_reorder");
  assertEquals(diff.removed, []);
  assertEquals(diff.added, []);
  assertEquals(diff.moves.length, 1);
  assertEquals(diff.moves[0].text, "Venue");
  assertEquals({ from: diff.moves[0].from, to: diff.moves[0].to }, {
    from: 2,
    to: 1,
  });
  assertStringIncludes(diff.summary, "**Moved:**");
});

Deno.test("numbered list reordering is represented as deterministic moves", () => {
  const diff = buildPageContentDiff(
    "1. Austria\n2. Belgium\n3. Croatia",
    "1. Belgium\n2. Austria\n3. Croatia",
  );

  assertEquals(diff.added, []);
  assertEquals(diff.removed, []);
  assertEquals(diff.changeClass, "same_scope_reorder");
  assertEquals(
    diff.moves.map((move) => ({
      text: move.text,
      from: move.from,
      to: move.to,
    })),
    [
      { text: "Belgium", from: 2, to: 1 },
      { text: "Austria", from: 1, to: 2 },
    ],
  );
  assertStringIncludes(diff.summary, "Belgium (2 → 1)");
});

Deno.test("diff occurrences retain the exact location of repeated added text", () => {
  const repeated =
    "Google allows ads promoting cryptocurrency exchanges and software wallets.";
  const diff = buildPageContentDiff(
    ["## European Union", repeated, "Existing qualification"].join("\n"),
    [
      "## European Union",
      repeated,
      "Existing qualification",
      "## Iceland",
      repeated,
      "New qualification",
    ].join("\n"),
  );

  const occurrence = diff.addedOccurrences.find((item) =>
    item.text === repeated
  );
  assertEquals(occurrence?.index, 4);
  assertEquals(occurrence?.previousCount, 1);
  assertEquals(occurrence?.currentCount, 2);
  assertEquals(diff.changeClass, "content");
  assertStringIncludes(diff.summary, "Additional occurrence (1 → 2)");
});

Deno.test("repeated lines use stable local context before global ordinal fallback", () => {
  const diff = buildPageContentDiff(
    ["## Rules", "Existing rule", "Repeated rule"].join("\n"),
    ["## Rules", "Repeated rule", "Existing rule", "Repeated rule"].join("\n"),
  );
  assertEquals(diff.addedOccurrences, [{
    text: "Repeated rule",
    index: 1,
    previousCount: 1,
    currentCount: 2,
  }]);
  assertEquals(diff.changeClass, "same_scope_duplicate_only");
});

Deno.test("removing a repeated line retains the removed local occurrence", () => {
  const diff = buildPageContentDiff(
    ["## Rules", "Repeated rule", "Existing rule", "Repeated rule"].join("\n"),
    ["## Rules", "Existing rule", "Repeated rule"].join("\n"),
  );
  assertEquals(diff.removedOccurrences, [{
    text: "Repeated rule",
    index: 1,
    previousCount: 2,
    currentCount: 1,
  }]);
  assertEquals(diff.changeClass, "same_scope_duplicate_only");
});

Deno.test("numbered copies remain duplicate-only when later ranks shift", () => {
  const diff = buildPageContentDiff(
    ["## Rules", "1. Shared rule", "2. Other rule"].join("\n"),
    [
      "## Rules",
      "1. Shared rule",
      "2. Shared rule",
      "3. Other rule",
    ].join("\n"),
  );

  assertEquals(diff.addedOccurrences, [{
    text: "2. Shared rule",
    index: 2,
    previousCount: 0,
    currentCount: 1,
  }]);
  assertEquals(diff.moves.map((move) => move.text), ["Other rule"]);
  assertEquals(diff.changeClass, "same_scope_duplicate_only");
});

Deno.test("numbered marker-only changes are same-scope reorder noise", () => {
  const diff = buildPageContentDiff(
    "## Rules\n1. Shared rule",
    "## Rules\n1) Shared rule",
  );

  assertEquals(diff.changeClass, "same_scope_reorder");
});

Deno.test("duplicate churn mixed with new wording remains alertable", () => {
  const diff = buildPageContentDiff(
    "## Rules\nShared rule\nOther rule",
    "## Rules\nShared rule\nShared rule\nNew rule",
  );

  assertEquals(diff.changeClass, "content");
});

Deno.test("copying identical wording into another section remains alertable", () => {
  const diff = buildPageContentDiff(
    [
      "## European Union",
      "Software wallets are allowed with limitations.",
      "## Italy",
      "Existing Italy rule.",
    ].join("\n"),
    [
      "## European Union",
      "Software wallets are allowed with limitations.",
      "## Italy",
      "Software wallets are allowed with limitations.",
      "Existing Italy rule.",
    ].join("\n"),
  );

  assertEquals(diff.changeClass, "content");
});

Deno.test("moving identical wording into another section remains alertable", () => {
  const diff = buildPageContentDiff(
    [
      "## European Union",
      "Software wallets are allowed with limitations.",
      "## Italy",
      "Existing Italy rule.",
    ].join("\n"),
    [
      "## European Union",
      "## Italy",
      "Software wallets are allowed with limitations.",
      "Existing Italy rule.",
    ].join("\n"),
  );

  assertEquals(diff.added, []);
  assertEquals(diff.removed, []);
  assertEquals(diff.changeClass, "content");
});

Deno.test("repeated identical headings disable hard suppression", () => {
  const reorder = buildPageContentDiff(
    "## Region\nFirst rule\n## Region\nSecond rule",
    "## Region\nSecond rule\n## Region\nFirst rule",
  );
  const duplicate = buildPageContentDiff(
    "## Region\nShared rule\n## Region\nOther rule",
    "## Region\nShared rule\n## Region\nShared rule\nOther rule",
  );

  assertEquals(reorder.changeClass, "content");
  assertEquals(duplicate.changeClass, "content");
});

Deno.test("identical numbered bodies are matched inside their Markdown section", () => {
  const diff = buildPageContentDiff(
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
  );
  const repeated = diff.moves.find((move) => move.text === "Repeated item");
  assertEquals(
    repeated && {
      from: repeated.from,
      to: repeated.to,
      beforeIndex: repeated.beforeIndex,
      afterIndex: repeated.afterIndex,
    },
    { from: 1, to: 2, beforeIndex: 1, afterIndex: 2 },
  );
});

Deno.test("movement evidence is complete beyond fifty reordered lines", () => {
  const before = Array.from({ length: 60 }, (_, index) => `Line ${index}`);
  const diff = buildPageContentDiff(
    before.join("\n"),
    [...before].reverse().join("\n"),
  );
  assertEquals(diff.moves.length > 50, true);
});

Deno.test("large heading-free repeated-line documents retain indexed fallback evidence", () => {
  const before = Array.from({ length: 4_000 }, () => "Repeated body");
  const after = ["Repeated body", ...before];
  const diff = buildPageContentDiff(before.join("\n"), after.join("\n"));
  assertEquals(diff.addedOccurrences, [{
    text: "Repeated body",
    index: 4_000,
    previousCount: 4_000,
    currentCount: 4_001,
  }]);
});

Deno.test("PS-ANY-001 Any Change follows an alertable normalized delta", () => {
  assertEquals(
    decidePageScoutAlert({
      mode: "any",
      changeStatus: "changed",
      hasAlertableDiff: true,
      criteriaMatched: null,
      initialBaseline: false,
    }),
    true,
  );
  assertEquals(
    decidePageScoutAlert({
      mode: "any",
      changeStatus: "changed",
      hasAlertableDiff: false,
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
      hasAlertableDiff: true,
      criteriaMatched: true,
      initialBaseline: false,
    }),
    true,
  );
  assertEquals(
    decidePageScoutAlert({
      mode: "specific",
      changeStatus: "changed",
      hasAlertableDiff: true,
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
      hasAlertableDiff: true,
      criteriaMatched: null,
      initialBaseline: true,
    }),
    false,
  );
  assertEquals(
    decidePageScoutAlert({
      mode: "any",
      changeStatus: "new",
      hasAlertableDiff: true,
      criteriaMatched: null,
      initialBaseline: false,
    }),
    true,
  );
});
