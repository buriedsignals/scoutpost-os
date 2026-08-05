import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { analyzePageScoutAlert } from "./page_scout_alert_pipeline.ts";
import { PAGE_SCOUT_ALERT_FIXTURES } from "./page_scout_alert_fixtures.ts";
import { buildPageContentDiff } from "./page_scout_change.ts";
import { shouldSendPageScoutAlert } from "./page_scout_notifications.ts";

const liveEnabled = Deno.env.get("SCOUT_LIVE_PAGE_SCOUT_ALERT_TESTS") === "1" &&
  Boolean(Deno.env.get("OPENROUTER_API_KEY"));

for (const fixture of PAGE_SCOUT_ALERT_FIXTURES) {
  Deno.test({
    name:
      `live Page Scout agent [${fixture.language}] ${fixture.id}: ${fixture.failureClass}`,
    ignore: !liveEnabled,
    fn: async () => {
      const analysis = await analyzePageScoutAlert({
        criteria: fixture.criteria,
        diff: buildPageContentDiff(fixture.before, fixture.after),
        changeStatus: "changed",
        initialBaseline: false,
        timeoutMs: 20_000,
      });

      const wouldSend = shouldSendPageScoutAlert({
        alert_eligible: analysis.alertEligible,
        articles_count: 0,
        criteria_ran: true,
      });
      assertEquals(
        wouldSend,
        fixture.expectedAlert,
        `${fixture.id}: agent reason=${analysis.criteriaDecision?.agentReason}`,
      );
    },
  });
}
