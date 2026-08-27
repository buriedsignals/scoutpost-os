import {
  assert,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROOT));
}

Deno.test("weekly abuse review is service-authenticated and never fetches monitored sources", async () => {
  const implementation = await source("supabase/functions/abuse-risk-audit/index.ts");
  const config = await source("supabase/config.toml");

  assertMatch(implementation, /requireServiceKey\(req\)/);
  assertMatch(implementation, /openRouterExtract/);
  assertMatch(implementation, /buildAbuseCandidates/);
  assert(!/firecrawl|api\.apify\.com/i.test(implementation));
  assert(!/is_active\s*[:=]\s*false|deleteUser|ban/i.test(implementation));
  assertMatch(config, /\[functions\.abuse-risk-audit\]\s*\nverify_jwt = false/);
});

Deno.test("migration installs a weekly cron and a 180-day operator-review ledger", async () => {
  const migration = await source(
    "supabase/migrations/20260827173000_abuse_risk_audit.sql",
  );

  assertMatch(migration, /CREATE TABLE IF NOT EXISTS public\.abuse_risk_findings/i);
  assertMatch(migration, /interval '180 days'/i);
  assertMatch(migration, /X-Service-Key/);
  assertMatch(migration, /0 10 \* \* 1/);
  assertMatch(migration, /operator-review-only/);
  assertMatch(migration, /REVOKE ALL ON TABLE public\.abuse_risk_findings/i);
  assertMatch(migration, /review_history jsonb/i);
  assertMatch(migration, /record_abuse_risk_disposition/i);
});

Deno.test("operator CLI supports review without exposing an enforcement action", async () => {
  const cli = await source("scripts/ops/abuse-review.ts");

  for (const command of ["run", "list", "show", "confirm", "dismiss", "defer", "export"]) {
    assertMatch(cli, new RegExp(`\\b${command}\\b`));
  }
  assert(!/pause|ban|terminate|delete/i.test(cli));
});
