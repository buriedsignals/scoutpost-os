import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PAGE_SCOUT_ALERT_FIXTURES } from "./page_scout_alert_fixtures.ts";
import { buildPageContentDiff } from "./page_scout_change.ts";

Deno.test("Page Scout alert acceptance corpus covers multilingual positive and negative deltas", () => {
  assertEquals(PAGE_SCOUT_ALERT_FIXTURES.length, 13);
  assertEquals(
    new Set(PAGE_SCOUT_ALERT_FIXTURES.map((fixture) => fixture.language)),
    new Set(["en", "de", "fr", "es", "ar", "ja"]),
  );
  assert(PAGE_SCOUT_ALERT_FIXTURES.some((fixture) => fixture.expectedAlert));
  assert(PAGE_SCOUT_ALERT_FIXTURES.some((fixture) => !fixture.expectedAlert));

  for (const fixture of PAGE_SCOUT_ALERT_FIXTURES) {
    assert(fixture.criteria.trim(), `${fixture.id}: criteria required`);
    assert(
      buildPageContentDiff(fixture.before, fixture.after).hasChanges,
      `${fixture.id}: fixture must reach the semantic decision stage`,
    );
  }
});
