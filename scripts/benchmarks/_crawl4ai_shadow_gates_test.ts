import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  dominantValue,
  ShadowReleaseGates,
  shadowReleasePassed,
} from "./_crawl4ai_shadow_gates.ts";

const PASSING: ShadowReleaseGates = {
  probeFailures: 0,
  scoreRegressions: 0,
  contractMismatches: 0,
  canonicalPassed: true,
  latencyPassed: true,
  memoryPassed: true,
};

Deno.test("dominant canonical value requires a unique majority", () => {
  assertEquals(dominantValue(["a", "a", "b"]), "a");
  assertEquals(dominantValue(["a", "b"]), null);
  assertEquals(dominantValue(["a", "a", "b", "c", "d"]), null);
  assertEquals(dominantValue([]), null);
});

Deno.test("every shadow release gate is fail closed", () => {
  assert(shadowReleasePassed(PASSING));
  for (
    const failing of [
      { probeFailures: 1 },
      { scoreRegressions: 1 },
      { contractMismatches: 1 },
      { canonicalPassed: false },
      { latencyPassed: false },
      { memoryPassed: false },
    ]
  ) {
    assert(!shadowReleasePassed({ ...PASSING, ...failing }));
  }
});
