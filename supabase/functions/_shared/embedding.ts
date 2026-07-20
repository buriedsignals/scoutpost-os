/** OpenRouter Gemini embedding client with a pinned 768d ZDR model space. */

import { ApiError } from "./errors.ts";
import { logEvent } from "./log.ts";

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
export const OPENROUTER_EMBEDDING_MODEL = "google/gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_MODEL_TAG =
  "openrouter-google-gemini-embedding-001-768-zdr-v1";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BATCH_SIZE = 32;
const MAX_COUNT_MISMATCH_BISECT_DEPTH = 2;
const PROVIDER_POLICY = {
  only: ["google-vertex"],
  allow_fallbacks: false,
  zdr: true,
  data_collection: "deny",
} as const;

export type EmbeddingTaskType =
  | "SEMANTIC_SIMILARITY"
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "CLASSIFICATION"
  | "CLUSTERING";

export interface EmbeddingInput {
  text: string;
  taskType?: EmbeddingTaskType;
  title?: string | null;
}

export interface EmbeddingOptions {
  title?: string | null;
  abortAfterMs?: number;
}

function openRouterApiKey(): string {
  const value = Deno.env.get("OPENROUTER_API_KEY")?.trim();
  if (!value) throw new ApiError("OPENROUTER_API_KEY not configured", 500);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inputType(taskType: EmbeddingTaskType): string {
  const types: Record<EmbeddingTaskType, string> = {
    SEMANTIC_SIMILARITY: "semantic_similarity",
    RETRIEVAL_DOCUMENT: "search_document",
    RETRIEVAL_QUERY: "search_query",
    CLASSIFICATION: "classification",
    CLUSTERING: "clustering",
  };
  return types[taskType];
}

function formatInput(input: EmbeddingInput): string {
  if ((input.taskType ?? "SEMANTIC_SIMILARITY") !== "RETRIEVAL_DOCUMENT") {
    return input.text;
  }
  const title = input.title?.trim();
  return title ? `title: ${title} | text: ${input.text}` : input.text;
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new ApiError("OpenRouter embedding returned a zero vector", 502);
  }
  return vector.map((value) => value / magnitude);
}

export async function embedText(
  text: string,
  taskType: EmbeddingTaskType = "SEMANTIC_SIMILARITY",
  options: EmbeddingOptions = {},
): Promise<number[]> {
  const vectors = await embedBatch([{
    text,
    taskType,
    title: options.title,
  }], options);
  return vectors[0];
}

export async function embedBatch(
  inputs: EmbeddingInput[],
  options: Omit<EmbeddingOptions, "title"> = {},
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const vectors: number[][] = [];
  let start = 0;
  while (start < inputs.length) {
    const taskType = inputs[start].taskType ?? "SEMANTIC_SIMILARITY";
    let end = start + 1;
    while (
      end < inputs.length && end - start < MAX_BATCH_SIZE &&
      (inputs[end].taskType ?? "SEMANTIC_SIMILARITY") === taskType
    ) {
      end += 1;
    }
    vectors.push(
      ...await requestEmbeddingBatchResilient(
        inputs.slice(start, end),
        taskType,
        options,
      ),
    );
    start = end;
  }
  return vectors;
}

async function requestEmbeddingBatchResilient(
  inputs: EmbeddingInput[],
  taskType: EmbeddingTaskType,
  options: Omit<EmbeddingOptions, "title">,
  depth = 0,
): Promise<number[][]> {
  try {
    return await requestEmbeddingBatch(inputs, taskType, options);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : null;
    if (
      code !== "openrouter_embedding_count_mismatch" ||
      inputs.length <= 1 ||
      depth >= MAX_COUNT_MISMATCH_BISECT_DEPTH
    ) {
      throw error;
    }

    const midpoint = Math.ceil(inputs.length / 2);
    logEvent({
      level: "warn",
      fn: "embedding",
      event: "batch_bisected",
      input_count: inputs.length,
      left_count: midpoint,
      right_count: inputs.length - midpoint,
      depth: depth + 1,
    });
    const left = await requestEmbeddingBatchResilient(
      inputs.slice(0, midpoint),
      taskType,
      options,
      depth + 1,
    );
    const right = await requestEmbeddingBatchResilient(
      inputs.slice(midpoint),
      taskType,
      options,
      depth + 1,
    );
    return [...left, ...right];
  }
}

async function requestEmbeddingBatch(
  inputs: EmbeddingInput[],
  taskType: EmbeddingTaskType,
  options: Omit<EmbeddingOptions, "title">,
): Promise<number[][]> {
  const apiKey = openRouterApiKey();
  const abortAfterMs = options.abortAfterMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const fuse = setTimeout(() => controller.abort(), abortAfterMs);
  let response: Response;
  try {
    response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Cache": "false",
      },
      body: JSON.stringify({
        model: OPENROUTER_EMBEDDING_MODEL,
        input: inputs.map(formatInput),
        dimensions: EMBEDDING_DIMENSIONS,
        input_type: inputType(taskType),
        provider: PROVIDER_POLICY,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new ApiError(
        `OpenRouter embedding aborted after ${abortAfterMs}ms`,
        504,
        "openrouter_embedding_timeout",
      );
    }
    throw new ApiError(
      "OpenRouter embedding request failed",
      502,
      "openrouter_embedding_transport",
    );
  } finally {
    clearTimeout(fuse);
  }
  if (!response.ok) {
    throw new ApiError(
      `OpenRouter embedding failed with status ${response.status}`,
      502,
      `openrouter_embedding_${response.status}`,
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) throw new TypeError("not an object");
    body = parsed;
  } catch {
    throw new ApiError("OpenRouter embedding returned malformed JSON", 502);
  }

  const data = body.data;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new ApiError(
      "OpenRouter embedding returned an unexpected count",
      502,
      "openrouter_embedding_count_mismatch",
    );
  }
  const ordered: Array<number[] | undefined> = new Array(inputs.length);
  for (const item of data) {
    if (!isRecord(item) || !Number.isInteger(item.index)) {
      throw new ApiError("OpenRouter embedding returned an invalid index", 502);
    }
    const index = item.index as number;
    const vector = item.embedding;
    if (
      index < 0 || index >= inputs.length || ordered[index] !== undefined ||
      !Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS ||
      !vector.every((value) =>
        typeof value === "number" && Number.isFinite(value)
      )
    ) {
      throw new ApiError(
        "OpenRouter embedding returned an invalid vector",
        502,
      );
    }
    ordered[index] = normalizeVector(vector as number[]);
  }

  const usage = isRecord(body.usage) ? body.usage : {};
  logEvent({
    level: "info",
    fn: "embedding",
    event: "openrouter_usage",
    model: typeof body.model === "string"
      ? body.model
      : OPENROUTER_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    input_count: inputs.length,
    prompt_tokens: usage.prompt_tokens,
    cost: usage.cost,
    zdr: true,
    upstream: "google-vertex",
  });

  return ordered.map((vector) => {
    if (!vector) {
      throw new ApiError("OpenRouter embedding omitted an index", 502);
    }
    return vector;
  });
}
