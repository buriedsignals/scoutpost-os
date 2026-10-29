/**
 * Civic's two model passes (propose, then verify) with one retry on an empty
 * pass.
 *
 * Replaying the 2026-06-24 Basel Grosser Rat minutes ten times on the same
 * production-parsed text, the proposer returned no candidates in 2 runs and
 * the verifier dropped all 8 proposed candidates in 1, while the other runs
 * kept 6-7 adopted elections. Temperature cannot be pinned on the Vertex
 * route (require_parameters rejects it), so an empty pass is retried once.
 * A document with genuinely nothing adopted costs one extra call per pass.
 */
import {
  buildCivicCandidatePrompt,
  buildCivicVerifierPrompt,
  CIVIC_CANDIDATE_SCHEMA,
  CIVIC_VERIFIER_SCHEMA,
  type CivicCandidate,
} from "./civic_accountability.ts";

export type CivicModelOperation =
  | "civic_extract_promises"
  | "civic_verify_accountability";

export type CivicModelCall = (
  prompt: string,
  schema: Record<string, unknown>,
  operation: CivicModelOperation,
) => Promise<{ candidates?: unknown } | null | undefined>;

export interface CivicPromptOptions {
  criteria: string | null;
  languageName: string;
  referenceDate: string | null;
}

export async function extractCivicCandidates(
  promptText: string,
  options: CivicPromptOptions,
  call: CivicModelCall,
): Promise<{ proposed: CivicCandidate[]; verified: CivicCandidate[] }> {
  const proposed = await callUntilNonEmpty(() =>
    call(
      buildCivicCandidatePrompt(promptText, options),
      CIVIC_CANDIDATE_SCHEMA,
      "civic_extract_promises",
    )
  );
  if (proposed.length === 0) return { proposed, verified: [] };
  const verified = await callUntilNonEmpty(() =>
    call(
      buildCivicVerifierPrompt(promptText, proposed, options),
      CIVIC_VERIFIER_SCHEMA,
      "civic_verify_accountability",
    )
  );
  return { proposed, verified };
}

async function callUntilNonEmpty(
  attempt: () => ReturnType<CivicModelCall>,
): Promise<CivicCandidate[]> {
  let candidates: CivicCandidate[] = [];
  for (let i = 0; i < 2 && candidates.length === 0; i++) {
    const result = await attempt();
    candidates = Array.isArray(result?.candidates)
      ? result.candidates as CivicCandidate[]
      : [];
  }
  return candidates;
}
