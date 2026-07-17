import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { applyCriteria, type CriteriaCandidate } from "./criteria.ts";

const CANDS: CriteriaCandidate[] = [
  { objectId: "a", statement: "Tanker DELTA heading west at 12 kn." },
  { objectId: "b", statement: "Cargo vessel MAERSK heading east at 15 kn." },
];

Deno.test("empty criteria keeps all candidates without an LLM call", async () => {
  const r = await applyCriteria(undefined, CANDS);
  assertEquals(r.ok, true);
  assertEquals(r.keptIds, ["a", "b"]);
  const blank = await applyCriteria("   ", CANDS);
  assertEquals(blank.keptIds, ["a", "b"]);
});

Deno.test("empty candidate set is a no-op", async () => {
  const r = await applyCriteria("only westbound", []);
  assertEquals(r.ok, true);
  assertEquals(r.keptIds, []);
});

Deno.test("criteria fails OPEN when the LLM errors (keeps all, ok=false)", async () => {
  // Force the OpenRouter path to fail: no provider key in the test.
  const priorOr = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.delete("OPENROUTER_API_KEY");
  try {
    const r = await applyCriteria("only westbound tankers", CANDS);
    // Whatever the failure mode, the run must NOT silently drop entrants.
    assertEquals(r.keptIds, ["a", "b"]);
    assertEquals(r.ok, false);
  } finally {
    if (priorOr) Deno.env.set("OPENROUTER_API_KEY", priorOr);
  }
});
