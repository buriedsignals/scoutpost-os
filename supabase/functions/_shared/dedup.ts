/**
 * Cosine similarity + within-run dedup helpers.
 *
 * EmbeddingGemma uses a calibrated within-run threshold of 0.82 plus
 * structured hard-negative guards.
 * after extraction, before hitting the cross-run dedup RPC. Without it, Gemini
 * paraphrase pairs ("Council voted on budget" / "City budget approved by
 * council") both land as separate information_units. See audit §4.1 row 19
 * and §4.2 row 20.
 */

const WITHIN_RUN_SIMILARITY_THRESHOLD = 0.82;

export interface DedupCandidate {
  statement: string;
  embedding: number[];
}

function normalizedNumbers(value: string): string[] {
  return [...value.toLowerCase().matchAll(/[0-9]+(?:[.,][0-9]+)?%?/g)]
    .map((match) => match[0])
    .filter((item, index, values) => values.indexOf(item) === index)
    .sort();
}

function hasNegativeOutcome(value: string): boolean {
  return /\b(?:no|not|never|reject(?:ed|s|ing)?|fail(?:ed|s|ing)?|cancel(?:led|ed|s|ing)?|deny|denied|oppos(?:e|ed|es|ing))\b/i
    .test(value);
}

export function hasStructuredConflict(a: string, b: string): boolean {
  const aNumbers = normalizedNumbers(a);
  const bNumbers = normalizedNumbers(b);
  if (
    aNumbers.length > 0 && bNumbers.length > 0 &&
    JSON.stringify(aNumbers) !== JSON.stringify(bNumbers)
  ) return true;
  return hasNegativeOutcome(a) !== hasNegativeOutcome(b);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (
    !Array.isArray(a) || !Array.isArray(b) || a.length !== b.length ||
    a.length === 0
  ) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function isWithinRunDuplicateWithGuards(
  candidate: DedupCandidate,
  kept: DedupCandidate[],
  threshold = WITHIN_RUN_SIMILARITY_THRESHOLD,
): boolean {
  return kept.some((prior) =>
    !hasStructuredConflict(candidate.statement, prior.statement) &&
    cosineSimilarity(candidate.embedding, prior.embedding) >= threshold
  );
}
