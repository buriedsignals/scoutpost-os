/** Authenticated client for Scoutpost's self-hosted EmbeddingGemma service. */

import { ApiError } from "./errors.ts";

export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_MODEL_TAG =
  "embeddinggemma-300m-768-int8-onnx-task-prefix-v1";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BATCH_SIZE = 32;

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

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ApiError(`${name} not configured`, 500);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  for (let start = 0; start < inputs.length; start += MAX_BATCH_SIZE) {
    vectors.push(
      ...await requestEmbeddingBatch(
        inputs.slice(start, start + MAX_BATCH_SIZE),
        options,
      ),
    );
  }
  return vectors;
}

async function requestEmbeddingBatch(
  inputs: EmbeddingInput[],
  options: Omit<EmbeddingOptions, "title">,
): Promise<number[][]> {
  const baseUrl = requiredEnv("EMBEDDING_SERVICE_URL").replace(/\/+$/, "");
  const token = requiredEnv("EMBEDDING_SERVICE_TOKEN");
  const abortAfterMs = options.abortAfterMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const fuse = setTimeout(() => controller.abort(), abortAfterMs);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/embed`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: inputs.map((input) => ({
          text: input.text,
          task_type: input.taskType ?? "SEMANTIC_SIMILARITY",
          title: input.title ?? null,
        })),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new ApiError(
        `Embedding service aborted after ${abortAfterMs}ms`,
        504,
        "embedding_service_timeout",
      );
    }
    throw new ApiError(
      "Embedding service request failed",
      502,
      "embedding_service_transport",
    );
  } finally {
    clearTimeout(fuse);
  }
  if (!response.ok) {
    throw new ApiError(
      `Embedding service failed with status ${response.status}`,
      502,
      `embedding_service_${response.status}`,
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (!isRecord(parsed)) throw new TypeError("not an object");
    body = parsed;
  } catch {
    throw new ApiError("Embedding service returned malformed JSON", 502);
  }
  if (
    body.model !== EMBEDDING_MODEL_TAG ||
    body.dimensions !== EMBEDDING_DIMENSIONS
  ) {
    throw new ApiError("Embedding service model contract mismatch", 502);
  }
  const data = body.data;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new ApiError("Embedding service returned an unexpected count", 502);
  }

  const ordered: Array<number[] | undefined> = new Array(inputs.length);
  for (const item of data) {
    if (!isRecord(item) || !Number.isInteger(item.index)) {
      throw new ApiError("Embedding service returned an invalid index", 502);
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
      throw new ApiError("Embedding service returned an invalid vector", 502);
    }
    ordered[index] = vector as number[];
  }
  return ordered.map((vector) => {
    if (!vector) throw new ApiError("Embedding service omitted an index", 502);
    return vector;
  });
}
