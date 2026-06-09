/**
 * Gemini API client: embeddings (1536-dim) and structured extraction.
 *
 * Docs: https://ai.google.dev/api/rest/v1beta
 */

import { ApiError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type { SupabaseClient } from "./supabase.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_MODEL = "models/gemini-embedding-2-preview";
const EMBED_DIM = 1536;
export const EMBEDDING_MODEL_TAG = "gemini-embedding-2-preview-task-prefix-v1";

function geminiApiKey(): string {
  const k = Deno.env.get("GEMINI_API_KEY");
  if (!k) throw new ApiError("GEMINI_API_KEY not configured", 500);
  return k;
}

export type GeminiTaskType =
  | "SEMANTIC_SIMILARITY"
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "CLASSIFICATION"
  | "CLUSTERING";

export interface GeminiUsageContext {
  db?: SupabaseClient;
  userId?: string | null;
  orgId?: string | null;
  scoutId?: string | null;
  runId?: string | null;
  functionName?: string;
  operation?: string;
  metadata?: Record<string, unknown>;
}

interface GeminiExtractOptions {
  model?: string;
  systemInstruction?: string;
  timeoutMs?: number;
  abortAfterMs?: number;
  usage?: GeminiUsageContext;
}

const GEMINI_EMBED_TIMEOUT_MS = 30_000;
const GEMINI_EXTRACT_TIMEOUT_MS = 90_000;

export function formatGeminiEmbedText(
  text: string,
  taskType: GeminiTaskType,
  title: string | null = null,
): string {
  if (taskType === "RETRIEVAL_DOCUMENT") {
    const cleanTitle = title?.trim() || "none";
    return `title: ${cleanTitle} | text: ${text}`;
  }

  const prefixes: Record<GeminiTaskType, string> = {
    SEMANTIC_SIMILARITY: "task: sentence similarity | query: ",
    RETRIEVAL_DOCUMENT: "",
    RETRIEVAL_QUERY: "task: search result | query: ",
    CLASSIFICATION: "task: classification | query: ",
    CLUSTERING: "task: clustering | query: ",
  };
  return `${prefixes[taskType] ?? prefixes.SEMANTIC_SIMILARITY}${text}`;
}

export async function geminiEmbed(
  text: string,
  taskType: GeminiTaskType = "SEMANTIC_SIMILARITY",
  opts: {
    title?: string | null;
    timeoutMs?: number;
    abortAfterMs?: number;
    usage?: GeminiUsageContext;
  } = {},
): Promise<number[]> {
  const timeoutMs = opts.timeoutMs ?? GEMINI_EMBED_TIMEOUT_MS;
  const abortAfterMs = opts.abortAfterMs ?? timeoutMs + 5_000;
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);
  let res: Response;
  try {
    res = await fetch(
      `${GEMINI_BASE}/${EMBED_MODEL}:embedContent?key=${geminiApiKey()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: {
            parts: [{
              text: formatGeminiEmbedText(text, taskType, opts.title ?? null),
            }],
          },
          outputDimensionality: EMBED_DIM,
        }),
        signal: ac.signal,
      },
    );
  } catch (e) {
    clearTimeout(fuse);
    if ((e as { name?: string }).name === "AbortError") {
      throw new ApiError(`gemini embed aborted after ${abortAfterMs}ms`, 504);
    }
    throw e;
  }
  clearTimeout(fuse);
  if (!res.ok) {
    throw new ApiError(
      `gemini embed failed: ${res.status} ${await res.text()}`,
      502,
    );
  }
  const body = await res.json();
  await recordGeminiUsage(
    opts.usage,
    "embedding",
    EMBED_MODEL,
    body?.usageMetadata,
  );
  const values = body?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBED_DIM) {
    throw new ApiError(
      `unexpected embedding shape (len ${values?.length})`,
      502,
    );
  }
  return values as number[];
}

/**
 * JSON-schema-constrained generation. Returns the parsed object.
 *
 * `opts.systemInstruction` maps to Gemini's `system_instruction` field —
 * used to enforce persistent rules (language, role, format) separately
 * from the per-call user prompt.
 */
export async function geminiExtract<T>(
  prompt: string,
  schema: Record<string, unknown>,
  opts?:
    | GeminiExtractOptions
    | string,
): Promise<T> {
  // Accept legacy `(prompt, schema, model)` call shape for backwards compat.
  const o = typeof opts === "string" ? { model: opts } : (opts ?? {});
  const modelId = o.model ?? Deno.env.get("LLM_MODEL") ??
    "gemini-2.5-flash-lite";
  const requestBody: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };
  if (o.systemInstruction) {
    requestBody.system_instruction = {
      parts: [{ text: o.systemInstruction }],
    };
  }
  const timeoutMs = o.timeoutMs ?? GEMINI_EXTRACT_TIMEOUT_MS;
  const abortAfterMs = o.abortAfterMs ?? timeoutMs + 5_000;
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), abortAfterMs);
  let res: Response;
  try {
    res = await fetch(
      `${GEMINI_BASE}/models/${modelId}:generateContent?key=${geminiApiKey()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: ac.signal,
      },
    );
  } catch (e) {
    clearTimeout(fuse);
    if ((e as { name?: string }).name === "AbortError") {
      throw new ApiError(`gemini extract aborted after ${abortAfterMs}ms`, 504);
    }
    throw e;
  }
  clearTimeout(fuse);
  if (!res.ok) {
    throw new ApiError(
      `gemini extract failed: ${res.status} ${await res.text()}`,
      502,
    );
  }
  const body = await res.json();
  await recordGeminiUsage(
    o.usage,
    "generate_content",
    modelId,
    body?.usageMetadata,
  );
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new ApiError("gemini response missing text part", 502);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(`gemini returned non-JSON: ${text.slice(0, 200)}`, 502);
  }
}

async function recordGeminiUsage(
  context: GeminiUsageContext | undefined,
  defaultOperation: string,
  model: string,
  usageMetadata: unknown,
): Promise<void> {
  if (!context?.db || !usageMetadata || typeof usageMetadata !== "object") {
    return;
  }
  const usage = usageMetadata as Record<string, unknown>;
  const promptTokens = intValue(usage.promptTokenCount) ?? 0;
  const completionTokens = intValue(usage.candidatesTokenCount) ?? 0;
  const totalTokens = intValue(usage.totalTokenCount) ??
    (promptTokens + completionTokens);
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return;
  }

  try {
    const orgId = context.orgId === undefined
      ? await fetchActiveOrgId(context.db, context.userId ?? null)
      : context.orgId;
    const { error } = await context.db.from("ai_usage_records").insert({
      user_id: context.userId ?? null,
      org_id: orgId ?? null,
      scout_id: context.scoutId ?? null,
      scout_run_id: context.runId ?? null,
      provider: "gemini",
      model,
      operation: context.operation ?? defaultOperation,
      function_name: context.functionName ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      metadata: {
        ...(context.metadata ?? {}),
        usage_metadata: usage,
      },
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "gemini",
      event: "usage_record_failed",
      user_id: context.userId ?? undefined,
      scout_id: context.scoutId ?? undefined,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
}

async function fetchActiveOrgId(
  db: SupabaseClient,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const { data, error } = await db
    .from("user_preferences")
    .select("active_org_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return null;
  return (data as { active_org_id?: string | null } | null)?.active_org_id ??
    null;
}

function intValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  return null;
}
