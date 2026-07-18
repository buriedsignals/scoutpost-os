/** Quality benchmark for the production OpenRouter Gemini 768d contract. */

import {
  embedBatch,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_TAG,
  OPENROUTER_EMBEDDING_MODEL,
} from "../../supabase/functions/_shared/embedding.ts";

interface DocumentFixture {
  id: string;
  language: string;
  title: string;
  text: string;
}

interface QueryFixture {
  id: string;
  language: string;
  text: string;
  relevant: string[];
}

export interface PairFixture {
  id: string;
  duplicate: boolean;
  left: string;
  right: string;
  guard?: "numeric" | "date" | "outcome" | "entity";
  left_date?: string;
  right_date?: string;
  left_outcome?: string;
  right_outcome?: string;
  left_entities?: string[];
  right_entities?: string[];
}

interface Fixtures {
  documents: DocumentFixture[];
  queries: QueryFixture[];
  dedup_pairs: PairFixture[];
}

export interface Confusion {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

const THRESHOLDS = [0.75, 0.8, 0.82, 0.85, 0.88, 0.9, 0.93, 0.95];

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    magnitudeA += a[index] ** 2;
    magnitudeB += b[index] ** 2;
  }
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dot / Math.sqrt(magnitudeA * magnitudeB);
}

export function hardNegativeConflict(pair: PairFixture): boolean {
  if (pair.guard === "numeric") {
    const numbers = (text: string) =>
      [...text.toLowerCase().matchAll(/[0-9]+(?:[.,][0-9]+)?%?/g)]
        .map((match) => match[0]).sort().join("|");
    return numbers(pair.left) !== numbers(pair.right);
  }
  if (pair.guard === "date") {
    const left = Date.parse(pair.left_date ?? "");
    const right = Date.parse(pair.right_date ?? "");
    return Number.isFinite(left) && Number.isFinite(right) &&
      Math.abs(left - right) > 86_400_000;
  }
  if (pair.guard === "outcome") {
    return pair.left_outcome !== pair.right_outcome;
  }
  if (pair.guard === "entity") {
    const right = new Set(pair.right_entities ?? []);
    return (pair.left_entities ?? []).every((entity) => !right.has(entity));
  }
  return false;
}

export function confusion(
  pairs: PairFixture[],
  scores: number[],
  threshold: number,
  guarded = false,
): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  pairs.forEach((pair, index) => {
    const predicted = scores[index] >= threshold &&
      (!guarded || !hardNegativeConflict(pair));
    if (predicted && pair.duplicate) tp += 1;
    else if (predicted) fp += 1;
    else if (pair.duplicate) fn += 1;
    else tn += 1;
  });
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0
    ? 0
    : 2 * precision * recall / (precision + recall);
  return {
    threshold: rounded(threshold),
    tp,
    fp,
    fn,
    tn,
    precision: rounded(precision),
    recall: rounded(recall),
    f1: rounded(f1),
  };
}

function rocAuc(pairs: PairFixture[], scores: number[]): number {
  const positives = scores.filter((_, index) => pairs[index].duplicate);
  const negatives = scores.filter((_, index) => !pairs[index].duplicate);
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      wins += positive > negative ? 1 : positive === negative ? 0.5 : 0;
    }
  }
  return wins / (positives.length * negatives.length);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function retrievalReport(
  documents: DocumentFixture[],
  queries: QueryFixture[],
  documentVectors: number[][],
  queryVectors: number[][],
) {
  const rows = queries.map((query, queryIndex) => {
    const ranked = documents.map((document, documentIndex) => ({
      id: document.id,
      score: cosineSimilarity(
        queryVectors[queryIndex],
        documentVectors[documentIndex],
      ),
    })).sort((a, b) => b.score - a.score);
    const relevant = new Set(query.relevant);
    const rank = ranked.findIndex((row) => relevant.has(row.id)) + 1;
    return {
      id: query.id,
      language: query.language,
      top_1: ranked[0]?.id,
      relevant_rank: rank,
      reciprocal_rank: rank === 0 ? 0 : 1 / rank,
      recall_at_1: rank === 1 ? 1 : 0,
      recall_at_3: rank > 0 && rank <= 3 ? 1 : 0,
    };
  });
  return {
    recall_at_1: rounded(average(rows.map((row) => row.recall_at_1))),
    recall_at_3: rounded(average(rows.map((row) => row.recall_at_3))),
    mrr: rounded(average(rows.map((row) => row.reciprocal_rank))),
    misses: rows.filter((row) => row.recall_at_1 === 0),
  };
}

async function main() {
  const fixtureUrl = new URL(
    "./embedding-quality-fixtures.json",
    import.meta.url,
  );
  const fixtures = JSON.parse(await Deno.readTextFile(fixtureUrl)) as Fixtures;
  const startedAt = performance.now();
  const documentVectors = await embedBatch(
    fixtures.documents.map((document) => ({
      text: document.text,
      title: document.title,
      taskType: "RETRIEVAL_DOCUMENT" as const,
    })),
  );
  const queryVectors = await embedBatch(fixtures.queries.map((query) => ({
    text: query.text,
    taskType: "RETRIEVAL_QUERY" as const,
  })));
  const leftVectors = await embedBatch(fixtures.dedup_pairs.map((pair) => ({
    text: pair.left,
    title: "information unit",
    taskType: "RETRIEVAL_DOCUMENT" as const,
  })));
  const rightVectors = await embedBatch(fixtures.dedup_pairs.map((pair) => ({
    text: pair.right,
    title: "information unit",
    taskType: "RETRIEVAL_DOCUMENT" as const,
  })));

  const scores = leftVectors.map((left, index) =>
    cosineSimilarity(left, rightVectors[index])
  );
  const candidates = [
    ...new Set(scores.flatMap((score) => [score, score + Number.EPSILON])),
  ]
    .map((threshold) =>
      confusion(fixtures.dedup_pairs, scores, threshold, true)
    );
  const best =
    candidates.sort((a, b) =>
      b.f1 - a.f1 || b.precision - a.precision || b.recall - a.recall
    )[0];
  const positives = scores.filter((_, index) =>
    fixtures.dedup_pairs[index].duplicate
  );
  const negatives = scores.filter((_, index) =>
    !fixtures.dedup_pairs[index].duplicate
  );
  const guardRows = fixtures.dedup_pairs.filter((pair) => pair.guard);
  const report = {
    contract: {
      model: OPENROUTER_EMBEDDING_MODEL,
      model_tag: EMBEDDING_MODEL_TAG,
      dimensions: EMBEDDING_DIMENSIONS,
      upstream: "google-vertex",
      zdr: true,
      fallbacks: false,
    },
    fixture_counts: {
      documents: fixtures.documents.length,
      queries: fixtures.queries.length,
      dedup_pairs: fixtures.dedup_pairs.length,
    },
    elapsed_ms: Math.round(performance.now() - startedAt),
    retrieval: retrievalReport(
      fixtures.documents,
      fixtures.queries,
      documentVectors,
      queryVectors,
    ),
    dedup: {
      roc_auc: rounded(rocAuc(fixtures.dedup_pairs, scores)),
      positive_score_range: [
        rounded(Math.min(...positives)),
        rounded(Math.max(...positives)),
      ],
      negative_score_range: [
        rounded(Math.min(...negatives)),
        rounded(Math.max(...negatives)),
      ],
      best_guarded_f1: best,
      thresholds: THRESHOLDS.map((threshold) => ({
        raw: confusion(fixtures.dedup_pairs, scores, threshold),
        guarded: confusion(fixtures.dedup_pairs, scores, threshold, true),
      })),
      hard_negative_guards: Object.fromEntries(
        guardRows.map((pair) => [pair.id, hardNegativeConflict(pair)]),
      ),
      scores: fixtures.dedup_pairs.map((pair, index) => ({
        id: pair.id,
        duplicate: pair.duplicate,
        score: rounded(scores[index]),
      })),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (
    report.retrieval.recall_at_1 < 1 || best.f1 < 0.9 ||
    Object.values(report.dedup.hard_negative_guards).some((value) => !value)
  ) Deno.exitCode = 1;
}

if (import.meta.main) await main();
