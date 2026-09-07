import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyScrapeError,
  isProbeErrorCode,
  isProbeOutcome,
  PROBE_ERROR_CODES,
  probeFailure,
  probeOk,
} from "./scout_probe.ts";

// Regression: the Council Scout UI rendered "Extraction test failed" as both
// title and body because the probe answered with a code and no message.
Deno.test("every probe code carries a human-readable, non-generic message", () => {
  for (const code of PROBE_ERROR_CODES) {
    const envelope = probeFailure("detect", code);
    assertEquals(envelope.ok, false);
    assertEquals(envelope.error_code, code);
    assert(envelope.error.length > 40, `${code} message too short`);
    assert(
      !/extraction test failed/i.test(envelope.error),
      `${code} must not echo the UI fallback string`,
    );
  }
});

Deno.test("probeFailure appends bounded detail after the catalogue sentence", () => {
  const envelope = probeFailure("reach", "unreachable", "x".repeat(500));
  assert(envelope.error.startsWith("The page could not be fetched."));
  assert(envelope.error.length < 300);
  assertEquals(
    probeFailure("reach", "unreachable", "   ").error.includes("("),
    false,
  );
});

Deno.test("no_meetings_detected is an outcome; transport and model codes are failures", () => {
  assertEquals(isProbeOutcome("no_meetings_detected"), true);
  for (
    const code of [
      "unreachable",
      "blocked",
      "parse_failed",
      "model_failed",
      "no_documents",
    ]
  ) {
    assertEquals(isProbeOutcome(code), false, code);
  }
});

Deno.test("probeOk and code guards", () => {
  assertEquals(probeOk("sample"), { ok: true, stage: "sample" });
  assertEquals(isProbeErrorCode("blocked"), true);
  assertEquals(isProbeErrorCode("nope"), false);
  assertEquals(
    classifyScrapeError(new Error("Blocked by anti-bot protection"), {
      antiBot: (e) => /anti-bot/.test(String((e as Error).message)),
    }),
    "blocked",
  );
  assertEquals(
    classifyScrapeError(new Error("fetch failed: 500"), {
      antiBot: () => false,
    }),
    "unreachable",
  );
});
