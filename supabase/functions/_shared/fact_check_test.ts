import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _buildUserPrompt,
  _parseVerdict,
  type FactCheckConfig,
  type FactCheckResult,
  factCheckUnit,
  isFactCheckEnabled,
  UNCHECKED,
} from "./fact_check.ts";

// ---------------------------------------------------------------------------
// isFactCheckEnabled
// ---------------------------------------------------------------------------

Deno.test("isFactCheckEnabled returns false when endpoint is null", () => {
  const config: FactCheckConfig = {
    endpointUrl: null,
    modelId: "abstain-r1",
    abstainThreshold: 0.4,
    timeoutMs: 15_000,
  };
  assertEquals(isFactCheckEnabled(config), false);
});

Deno.test("isFactCheckEnabled returns false when endpoint is empty string", () => {
  const config: FactCheckConfig = {
    endpointUrl: "  ",
    modelId: "abstain-r1",
    abstainThreshold: 0.4,
    timeoutMs: 15_000,
  };
  assertEquals(isFactCheckEnabled(config), false);
});

Deno.test("isFactCheckEnabled returns true when endpoint is set", () => {
  const config: FactCheckConfig = {
    endpointUrl: "http://localhost:11434",
    modelId: "abstain-r1",
    abstainThreshold: 0.4,
    timeoutMs: 15_000,
  };
  assertEquals(isFactCheckEnabled(config), true);
});

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------

Deno.test("parseVerdict parses a valid accept response", () => {
  const raw = JSON.stringify({
    verdict: "accept",
    confidence: 0.92,
    reason: "Claim is consistent with known facts.",
  });
  const result = _parseVerdict(raw);
  assertEquals(result?.verdict, "accept");
  assertEquals(result?.confidence, 0.92);
  assertEquals(result?.reason, "Claim is consistent with known facts.");
});

Deno.test("parseVerdict parses an abstain response", () => {
  const raw = JSON.stringify({
    verdict: "abstain",
    confidence: 0.35,
    reason: "Cannot verify local council decision from training data.",
  });
  const result = _parseVerdict(raw);
  assertEquals(result?.verdict, "abstain");
  assertEquals(result?.confidence, 0.35);
});

Deno.test("parseVerdict parses a reject response", () => {
  const raw = JSON.stringify({
    verdict: "reject",
    confidence: 0.15,
    reason: "Contradicts established population data.",
  });
  const result = _parseVerdict(raw);
  assertEquals(result?.verdict, "reject");
  assertEquals(result?.confidence, 0.15);
});

Deno.test("parseVerdict handles JSON embedded in reasoning text", () => {
  const raw = `Let me think about this claim. Here is my assessment:
{"verdict": "abstain", "confidence": 0.42, "reason": "Unverifiable local event."}
That concludes my analysis.`;
  const result = _parseVerdict(raw);
  assertEquals(result?.verdict, "abstain");
  assertEquals(result?.confidence, 0.42);
});

Deno.test("parseVerdict clamps confidence to [0, 1]", () => {
  const raw = JSON.stringify({
    verdict: "accept",
    confidence: 1.5,
    reason: "Over-confident.",
  });
  const result = _parseVerdict(raw);
  assertEquals(result?.confidence, 1.0);
});

Deno.test("parseVerdict clamps negative confidence to 0", () => {
  const raw = JSON.stringify({
    verdict: "reject",
    confidence: -0.2,
    reason: "Negative.",
  });
  const result = _parseVerdict(raw);
  assertEquals(result?.confidence, 0.0);
});

Deno.test("parseVerdict returns null for invalid verdict value", () => {
  const raw = JSON.stringify({
    verdict: "maybe",
    confidence: 0.5,
    reason: "Hmm.",
  });
  assertEquals(_parseVerdict(raw), null);
});

Deno.test("parseVerdict returns null for non-JSON input", () => {
  assertEquals(_parseVerdict("This is not JSON at all"), null);
});

Deno.test("parseVerdict returns null for empty string", () => {
  assertEquals(_parseVerdict(""), null);
});

Deno.test("parseVerdict defaults confidence to 0.5 when missing", () => {
  const raw = JSON.stringify({
    verdict: "abstain",
    reason: "No confidence field.",
  });
  const result = _parseVerdict(raw);
  assertEquals(result?.confidence, 0.5);
});

// ---------------------------------------------------------------------------
// buildUserPrompt
// ---------------------------------------------------------------------------

Deno.test("buildUserPrompt includes statement", () => {
  const prompt = _buildUserPrompt("The city council approved a $5M budget.");
  assertEquals(prompt.includes("The city council approved a $5M budget."), true);
});

Deno.test("buildUserPrompt includes source domain when provided", () => {
  const prompt = _buildUserPrompt("Test claim.", {
    sourceDomain: "reuters.com",
  });
  assertEquals(prompt.includes("reuters.com"), true);
});

Deno.test("buildUserPrompt includes date when provided", () => {
  const prompt = _buildUserPrompt("Test claim.", {
    occurredAt: "2026-04-20",
  });
  assertEquals(prompt.includes("2026-04-20"), true);
});

// ---------------------------------------------------------------------------
// factCheckUnit — endpoint not configured (graceful degradation)
// ---------------------------------------------------------------------------

Deno.test("factCheckUnit returns UNCHECKED when endpoint is null", async () => {
  const config: FactCheckConfig = {
    endpointUrl: null,
    modelId: "abstain-r1",
    abstainThreshold: 0.4,
    timeoutMs: 15_000,
  };
  const result = await factCheckUnit("Some claim.", config);
  assertEquals(result, UNCHECKED);
  assertStrictEquals(result.fact_checked, false);
  assertStrictEquals(result.confidence_score, null);
  assertStrictEquals(result.abstained, false);
});

// ---------------------------------------------------------------------------
// factCheckUnit — endpoint unreachable (graceful degradation)
// ---------------------------------------------------------------------------

Deno.test("factCheckUnit returns UNCHECKED when endpoint is unreachable", async () => {
  const config: FactCheckConfig = {
    endpointUrl: "http://127.0.0.1:1",
    modelId: "abstain-r1",
    abstainThreshold: 0.4,
    timeoutMs: 1_000,
  };
  const result = await factCheckUnit("Some claim.", config);
  assertEquals(result.fact_checked, false);
  assertStrictEquals(result.confidence_score, null);
});

// ---------------------------------------------------------------------------
// UNCHECKED sentinel
// ---------------------------------------------------------------------------

Deno.test("UNCHECKED has correct shape", () => {
  assertEquals(UNCHECKED.fact_checked, false);
  assertEquals(UNCHECKED.confidence_score, null);
  assertEquals(UNCHECKED.abstained, false);
  assertEquals(UNCHECKED.abstain_reason, null);
});

// ---------------------------------------------------------------------------
// factCheckUnit — abstention rule over model verdicts
// ---------------------------------------------------------------------------

Deno.test("factCheckUnit abstains on abstain/reject verdicts and confidence below threshold", async () => {
  const config: FactCheckConfig = {
    endpointUrl: "https://abstain.test",
    modelId: "abstain-r1",
    abstainThreshold: 0.4,
    timeoutMs: 1_000,
  };
  const cases: Array<{
    verdict: Record<string, unknown>;
    expected: FactCheckResult;
  }> = [
    {
      verdict: { verdict: "abstain", confidence: 0.9, reason: "Unverifiable" },
      expected: {
        fact_checked: true,
        confidence_score: 0.9,
        abstained: true,
        abstain_reason: "Unverifiable",
      },
    },
    {
      verdict: { verdict: "reject", confidence: 0.85, reason: "Contradicted" },
      expected: {
        fact_checked: true,
        confidence_score: 0.85,
        abstained: true,
        abstain_reason: "Contradicted",
      },
    },
    {
      verdict: { verdict: "accept", confidence: 0.25 },
      expected: {
        fact_checked: true,
        confidence_score: 0.25,
        abstained: true,
        abstain_reason: "Low confidence",
      },
    },
    {
      verdict: { verdict: "accept", confidence: 0.4, reason: "Plausible" },
      expected: {
        fact_checked: true,
        confidence_score: 0.4,
        abstained: false,
        abstain_reason: null,
      },
    },
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const { verdict, expected } of cases) {
      globalThis.fetch = (() =>
        Promise.resolve(
          Response.json({
            choices: [{ message: { content: JSON.stringify(verdict) } }],
          }),
        )) as typeof fetch;
      assertEquals(await factCheckUnit("Some claim.", config), expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Edge cases: ambiguous claims and missing sources
// ---------------------------------------------------------------------------

Deno.test("parseVerdict handles ambiguous claim with abstain verdict", () => {
  const raw = JSON.stringify({
    verdict: "abstain",
    confidence: 0.3,
    reason: "Claim references specific local budget figures that cannot be verified.",
  });
  const result = _parseVerdict(raw);
  assertEquals(result?.verdict, "abstain");
  assertEquals(result?.confidence, 0.3);
  assertEquals(
    result?.reason?.includes("cannot be verified"),
    true,
  );
});

Deno.test("parseVerdict handles missing source context with low confidence", () => {
  const raw = JSON.stringify({
    verdict: "abstain",
    confidence: 0.2,
    reason: "No source attribution; claim is unverifiable without additional context.",
  });
  const result = _parseVerdict(raw);
  assertEquals(result?.verdict, "abstain");
  assertEquals(result?.confidence, 0.2);
});
