import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  classifyScrapeError,
  isProbeErrorCode,
  isProbeOutcome,
  pageResponseProbeFailure,
  probeFailure,
  probeOk,
} from "./scout_probe.ts";
import { PAGE_SCOUT_MAX_CONTENT_CHARS } from "./page_scout_change.ts";

Deno.test("probeFailure appends bounded detail after the catalogue sentence", () => {
  const envelope = probeFailure("reach", "unreachable", "x".repeat(500));
  assert(envelope.error.endsWith(`(${"x".repeat(200)})`));
  assertEquals(envelope.error.includes("x".repeat(201)), false);
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
      "page_too_long",
    ]
  ) {
    assertEquals(isProbeOutcome(code), false, code);
  }
});

Deno.test("probeOk and code guards", () => {
  assertEquals(probeOk("sample"), { ok: true, stage: "sample" });
  assertEquals(isProbeErrorCode("blocked"), true);
  assertEquals(isProbeErrorCode("page_too_long"), true);
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

Deno.test("Page probe reports target HTTP failure rather than creation success", () => {
  const failure = pageResponseProbeFailure({
    markdown: "Nonempty removed-page response",
    status_code: 404,
  }, "https://example.test/policy");
  assertEquals(failure?.ok, false);
  assertEquals(failure?.error_code, "unreachable");
  assert(failure?.error.includes("HTTP 404"));
  assertEquals(
    pageResponseProbeFailure({
      markdown: "OK",
    }, "https://example.test/policy"),
    null,
  );
  assertEquals(
    pageResponseProbeFailure({
      markdown: " ",
    }, "https://example.test/policy")?.error_code,
    "empty_content",
  );
});

Deno.test("Page probe accepts the normalized size limit and rejects one character over", () => {
  const atLimit = "x".repeat(PAGE_SCOUT_MAX_CONTENT_CHARS);
  const response = {
    markdown: `\n\n${atLimit} \t\n\n`,
    html: "raw markup".repeat(PAGE_SCOUT_MAX_CONTENT_CHARS),
  };
  assertEquals(
    pageResponseProbeFailure(response, "https://example.test/policy"),
    null,
  );
  const failure = pageResponseProbeFailure({
    markdown: `${atLimit}x`,
  }, "https://example.test/policy");
  assertEquals(failure?.ok, false);
  assertEquals(failure?.stage, "reach");
  assertEquals(failure?.error_code, "page_too_long");
});

Deno.test("Page probe keeps redirect and HTTP failure precedence over size", () => {
  const response = {
    markdown: "x".repeat(PAGE_SCOUT_MAX_CONTENT_CHARS + 1),
    status_code: 503,
  };
  assertEquals(
    pageResponseProbeFailure(response, "https://example.test/policy")
      ?.error_code,
    "unreachable",
  );
  assertEquals(
    pageResponseProbeFailure({
      ...response,
      source_url: "https://example.test/other",
    }, "https://example.test/policy")?.error_code,
    "outside_configured_page",
  );
});
