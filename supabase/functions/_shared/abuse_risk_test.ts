import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAbuseCandidates,
  fingerprintCandidate,
  normalizeModelFindings,
  shouldNotifyFinding,
  type ScoutAuditInput,
} from "./abuse_risk.ts";

function scout(
  overrides: Partial<ScoutAuditInput> = {},
): ScoutAuditInput {
  return {
    id: crypto.randomUUID(),
    user_id: "00000000-0000-4000-8000-000000000001",
    name: "Council posts",
    type: "social",
    description: "Public-interest reporting",
    criteria: "Housing votes",
    topic: "housing",
    url: null,
    platform: "instagram",
    profile_handle: "citycouncil",
    root_domain: null,
    tracked_urls: null,
    ...overrides,
  };
}

Deno.test("ordinary public-profile monitoring is not an abuse candidate", () => {
  assertEquals(buildAbuseCandidates([scout()]), []);
});

Deno.test("explicit private-access intent becomes deterministic evidence", () => {
  const candidate = buildAbuseCandidates([
    scout({ criteria: "Bypass the login to watch this private account" }),
  ])[0];

  assertEquals(candidate.signals.map((signal) => signal.kind), [
    "private_access_intent",
  ]);
  assertEquals(candidate.scouts.length, 1);
});

Deno.test("social volume is a review candidate but cannot alone prove high confidence", () => {
  const scouts = Array.from({ length: 8 }, (_, index) =>
    scout({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      profile_handle: `public-${index}`,
    })
  );
  const candidate = buildAbuseCandidates(scouts)[0];
  const findings = normalizeModelFindings(candidate, [{
    rule_id: "AUP-STALKING-HARASSMENT-DOXXING",
    confidence: "high",
    evidence_signal_ids: [candidate.signals[0].id],
    rationale: "Volume warrants review.",
  }]);

  assertEquals(candidate.signals.map((signal) => signal.kind), [
    "high_social_profile_volume",
  ]);
  assertEquals(findings[0].confidence, "medium");
  assertEquals(findings[0].evidence.length, 1);
});

Deno.test("high confidence requires two deterministic evidence signals", () => {
  const candidate = buildAbuseCandidates([
    scout({
      criteria: "Track my ex-partner and publish their home address",
      description: "Retaliation",
    }),
  ])[0];
  const signalIds = candidate.signals.map((signal) => signal.id);
  const findings = normalizeModelFindings(candidate, [{
    rule_id: "AUP-STALKING-HARASSMENT-DOXXING",
    confidence: "high",
    evidence_signal_ids: signalIds,
    rationale: "Two account-authored signals corroborate the pattern.",
  }]);

  assertEquals(signalIds.length >= 2, true);
  assertEquals(findings[0].confidence, "high");
  assertEquals(findings[0].evidence.length >= 2, true);
});

Deno.test("candidate fingerprints are deterministic and change with configuration", async () => {
  const first = buildAbuseCandidates([
    scout({ id: "00000000-0000-4000-8000-000000000010", criteria: "stalk my ex" }),
    scout({ id: "00000000-0000-4000-8000-000000000011", criteria: "housing" }),
  ])[0];
  const reordered = { ...first, scouts: [...first.scouts].reverse() };
  const changed = {
    ...first,
    scouts: first.scouts.map((item, index) =>
      index === 0 ? { ...item, criteria: "stalk my former employee" } : item
    ),
  };

  assertEquals(await fingerprintCandidate(first), await fingerprintCandidate(reordered));
  assertNotEquals(await fingerprintCandidate(first), await fingerprintCandidate(changed));
});

Deno.test("notifications are limited to new or materially changed high findings", () => {
  assertEquals(shouldNotifyFinding(null, "high", "a"), true);
  assertEquals(shouldNotifyFinding(null, "medium", "a"), false);
  assertEquals(
    shouldNotifyFinding({ confidence: "high", config_fingerprint: "a", notified_at: "2026-01-01" }, "high", "a"),
    false,
  );
  assertEquals(
    shouldNotifyFinding({ confidence: "medium", config_fingerprint: "a", notified_at: null }, "high", "a"),
    true,
  );
  assertEquals(
    shouldNotifyFinding({ confidence: "high", config_fingerprint: "a", notified_at: "2026-01-01" }, "high", "b"),
    true,
  );
});
