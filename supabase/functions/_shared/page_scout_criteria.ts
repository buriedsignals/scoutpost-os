import {
  type AiUsageContext,
  openRouterExtract,
  type OpenRouterExtractOptions,
} from "./openrouter.ts";

export interface PageScoutCriteriaResult {
  matches: boolean;
  matchingPassages: string[];
}

interface CriteriaResponse {
  matches: boolean;
  matching_passages: string[];
}

const CRITERIA_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    matches: { type: "boolean" },
    matching_passages: {
      type: "array",
      items: { type: "string" },
      maxItems: 8,
    },
  },
  required: ["matches", "matching_passages"],
};
const MAX_CRITERIA_DELTA_CHARS = 20_000;
const MAX_CRITERIA_BATCHES = 8;

export class PageScoutCriteriaCoverageError extends Error {}

export async function evaluatePageScoutCriteria(
  input: {
    criteria: string;
    delta: string;
    timeoutMs: number;
    usage?: AiUsageContext;
  },
  deps: {
    extract?: (
      prompt: string,
      schema: Record<string, unknown>,
      options: OpenRouterExtractOptions,
    ) => Promise<CriteriaResponse>;
  } = {},
): Promise<PageScoutCriteriaResult> {
  const extract = deps.extract ??
    ((prompt, schema, options) =>
      openRouterExtract<CriteriaResponse>(prompt, schema, options));
  const chunks = chunkDelta(input.delta, MAX_CRITERIA_DELTA_CHARS);
  const boundedChunks = chunks.slice(0, MAX_CRITERIA_BATCHES);
  const batchTimeoutMs = Math.max(
    1_000,
    Math.floor(input.timeoutMs / Math.max(1, boundedChunks.length)),
  );
  for (const delta of boundedChunks) {
    const response = await extract(
      [
        "Decide whether the actual page-content changes match the user's monitoring criteria.",
        "Evaluate only ADDED and REMOVED passages below. Unchanged page text is not evidence.",
        "A removal, wording change, heading change, or non-factual text can match.",
        "Return matching passages copied exactly from the supplied delta. Do not write a description.",
        "",
        `USER CRITERIA:\n${input.criteria.trim()}`,
        "",
        `PAGE DELTA:\n${delta}`,
      ].join("\n"),
      CRITERIA_SCHEMA,
      {
        timeoutMs: batchTimeoutMs,
        abortAfterMs: batchTimeoutMs + 1_000,
        usage: input.usage,
        systemInstruction:
          "You are a strict change-matching classifier. Never use knowledge or page text outside the supplied delta.",
      },
    );

    const matchingPassages = response.matching_passages
      .map((passage) => passage.trim())
      .filter((passage) => passage.length > 0 && delta.includes(passage))
      .slice(0, 8);
    if (response.matches === true && matchingPassages.length > 0) {
      return { matches: true, matchingPassages };
    }
  }
  if (chunks.length > boundedChunks.length) {
    throw new PageScoutCriteriaCoverageError(
      `page delta requires ${chunks.length} criteria batches; maximum is ${MAX_CRITERIA_BATCHES}`,
    );
  }
  return { matches: false, matchingPassages: [] };
}

function chunkDelta(delta: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of delta.split("\n")) {
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = "";
    }
    if (line.length <= maxChars) {
      current += `${current ? "\n" : ""}${line}`;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    for (let start = 0; start < line.length; start += maxChars) {
      chunks.push(line.slice(start, start + maxChars));
    }
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}
