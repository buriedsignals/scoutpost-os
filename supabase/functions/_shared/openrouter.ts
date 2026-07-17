/**
 * OpenRouter client for Google Vertex structured extraction.
 *
 * Every request is restricted to OpenRouter's Google Vertex ZDR routes and
 * opts out of provider data collection and OpenRouter response caching.
 */

import { ApiError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type { SupabaseClient } from "./supabase.ts";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_CHAT_MODEL = "google/gemini-2.5-flash-lite";

const PROVIDER_POLICY = {
  only: ["google-vertex"],
  zdr: true,
  data_collection: "deny",
} as const;

const OPENROUTER_EXTRACT_TIMEOUT_MS = 90_000;

function openRouterApiKey(): string {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new ApiError("OPENROUTER_API_KEY not configured", 500);
  return key;
}

export interface AiUsageContext {
  db?: SupabaseClient;
  userId?: string | null;
  orgId?: string | null;
  scoutId?: string | null;
  runId?: string | null;
  functionName?: string;
  operation?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenRouterExtractOptions {
  model?: string;
  systemInstruction?: string;
  timeoutMs?: number;
  abortAfterMs?: number;
  usage?: AiUsageContext;
}

/** JSON-schema-constrained generation. Returns the parsed object. */
export async function openRouterExtract<T>(
  prompt: string,
  schema: Record<string, unknown>,
  options: OpenRouterExtractOptions = {},
): Promise<T> {
  const model = options.model ?? Deno.env.get("LLM_MODEL") ??
    OPENROUTER_DEFAULT_CHAT_MODEL;
  if (!model.startsWith("google/")) {
    throw new ApiError(
      "LLM_MODEL must use the google/ namespace for the pinned Google Vertex route",
      500,
    );
  }

  const messages: Array<Record<string, string>> = [];
  if (options.systemInstruction) {
    messages.push({ role: "system", content: options.systemInstruction });
  }
  messages.push({ role: "user", content: prompt });

  const timeoutMs = options.timeoutMs ?? OPENROUTER_EXTRACT_TIMEOUT_MS;
  const abortAfterMs = options.abortAfterMs ?? timeoutMs + 5_000;
  const response = await openRouterRequest(
    "chat/completions",
    {
      model,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "structured_response",
          strict: true,
          schema,
        },
      },
      provider: {
        ...PROVIDER_POLICY,
        require_parameters: true,
      },
    },
    abortAfterMs,
    "extraction",
  );
  const body = await parseResponseJson(response, "extraction");
  await recordOpenRouterUsage(
    options.usage,
    "chat_completion",
    responseModel(body, model),
    body?.usage,
    body,
  );
  const choices = body.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(firstChoice) && isRecord(firstChoice.message)
    ? firstChoice.message
    : null;
  const content = message?.content;
  if (typeof content !== "string") {
    throw new ApiError("OpenRouter response missing message content", 502);
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new ApiError("OpenRouter returned non-JSON content", 502);
  }
}

async function openRouterRequest(
  path: string,
  body: Record<string, unknown>,
  abortAfterMs: number,
  operation: string,
): Promise<Response> {
  const controller = new AbortController();
  const fuse = setTimeout(() => controller.abort(), abortAfterMs);
  try {
    const response = await fetch(`${OPENROUTER_BASE}/${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterApiKey()}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Cache": "false",
        "X-OpenRouter-Metadata": "enabled",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Do not include the upstream body: it is not needed for routing errors
      // and could reflect request content. Status and operation are sufficient.
      throw new ApiError(
        `OpenRouter ${operation} failed with status ${response.status}`,
        502,
        `openrouter_${response.status}`,
      );
    }
    return response;
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new ApiError(
        `OpenRouter ${operation} aborted after ${abortAfterMs}ms`,
        504,
        "openrouter_timeout",
      );
    }
    throw error;
  } finally {
    clearTimeout(fuse);
  }
}

async function parseResponseJson(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new TypeError("response is not an object");
    return body;
  } catch {
    throw new ApiError(
      `OpenRouter ${operation} returned malformed JSON`,
      502,
      "openrouter_malformed_response",
    );
  }
}

function responseModel(
  body: Record<string, unknown>,
  requestedModel: string,
): string {
  return typeof body?.model === "string" && body.model.includes("/")
    ? body.model
    : requestedModel;
}

async function recordOpenRouterUsage(
  context: AiUsageContext | undefined,
  defaultOperation: string,
  model: string,
  usageMetadata: unknown,
  responseMetadata: Record<string, unknown>,
): Promise<void> {
  if (!context?.db || !usageMetadata || typeof usageMetadata !== "object") {
    return;
  }
  const usage = usageMetadata as Record<string, unknown>;
  const promptTokens = intValue(usage.prompt_tokens) ?? 0;
  const completionTokens = intValue(usage.completion_tokens) ?? 0;
  const totalTokens = intValue(usage.total_tokens) ??
    (promptTokens + completionTokens);
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return;
  }

  const routeMetadata: Record<string, unknown> = {};
  const upstreamProvider = selectedUpstreamProvider(responseMetadata);
  if (upstreamProvider) {
    routeMetadata.upstream_provider = upstreamProvider;
  }
  if (typeof responseMetadata.id === "string") {
    routeMetadata.openrouter_response_id = responseMetadata.id;
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
      provider: "openrouter",
      model,
      operation: context.operation ?? defaultOperation,
      function_name: context.functionName ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      metadata: {
        ...(context.metadata ?? {}),
        ...routeMetadata,
        usage_metadata: usage,
      },
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    logEvent({
      level: "warn",
      fn: "openrouter",
      event: "usage_record_failed",
      user_id: context.userId ?? undefined,
      scout_id: context.scoutId ?? undefined,
      msg: error instanceof Error ? error.message : String(error),
    });
  }
}

function selectedUpstreamProvider(
  responseMetadata: Record<string, unknown>,
): string | null {
  const metadata = responseMetadata.openrouter_metadata;
  if (!isRecord(metadata)) return null;
  const endpoints = metadata.endpoints;
  if (!isRecord(endpoints) || !Array.isArray(endpoints.available)) return null;
  const selected = endpoints.available.find((endpoint) =>
    isRecord(endpoint) && endpoint.selected === true
  );
  return isRecord(selected) && typeof selected.provider === "string"
    ? selected.provider
    : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
