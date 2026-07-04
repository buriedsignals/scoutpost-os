/**
 * Natural-language criteria filtering for transport entrants.
 *
 * Runs ONLY over the small, already-state-diffed entrant set (not the whole
 * candidate list), so one batched LLM call per run keeps cost bounded. Uses
 * the same Gemini path as the beat pipeline. Fails OPEN: if the LLM errors,
 * every entrant is kept and the run records criteria_status = error, so a
 * transient LLM outage never silently suppresses alerts.
 */

import { geminiExtract } from "../_shared/gemini.ts";
import { logEvent } from "../_shared/log.ts";

export interface CriteriaCandidate {
  objectId: string;
  statement: string;
}

export interface CriteriaResult {
  /** Object ids the criteria selected (or ALL, on fail-open). */
  keptIds: string[];
  /** false when the LLM failed and we fell open. */
  ok: boolean;
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          object_id: { type: "string" },
          matches: { type: "boolean" },
        },
        required: ["object_id", "matches"],
      },
    },
  },
  required: ["matches"],
};

function buildPrompt(
  criteria: string,
  candidates: CriteriaCandidate[],
): string {
  const lines = candidates
    .map((c) => `- object_id "${c.objectId}": ${c.statement}`)
    .join("\n");
  return [
    "You are filtering transport-tracking alerts against a user's criteria.",
    "Return, for EACH object_id, whether the described object matches the criteria.",
    "Judge only from the description; if genuinely ambiguous, return matches=true (do not suppress).",
    "",
    `Criteria: ${criteria}`,
    "",
    "Objects:",
    lines,
  ].join("\n");
}

/**
 * Apply free-text criteria to entrants. Empty criteria or empty candidate set
 * returns all ids unchanged (ok=true, no LLM call).
 */
export async function applyCriteria(
  criteria: string | undefined,
  candidates: CriteriaCandidate[],
): Promise<CriteriaResult> {
  const allIds = candidates.map((c) => c.objectId);
  if (!criteria?.trim() || candidates.length === 0) {
    return { keptIds: allIds, ok: true };
  }
  try {
    const out = await geminiExtract<
      { matches: Array<{ object_id: string; matches: boolean }> }
    >(buildPrompt(criteria, candidates), RESULT_SCHEMA);
    const verdict = new Map(
      (out.matches ?? []).map((m) => [m.object_id, m.matches === true]),
    );
    // Fail open per object: an id the model omitted is kept.
    const keptIds = allIds.filter((id) => verdict.get(id) !== false);
    return { keptIds, ok: true };
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "scout-transport-execute",
      event: "criteria_llm_failed",
      msg: e instanceof Error ? e.message : String(e),
    });
    return { keptIds: allIds, ok: false };
  }
}
