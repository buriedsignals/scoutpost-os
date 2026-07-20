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
export const OPENROUTER_DEFAULT_FALLBACK_MODEL = "google/gemini-2.5-flash";

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
  /** Set null to disable the bounded model fallback. */
  fallbackModel?: string | null;
  systemInstruction?: string;
  timeoutMs?: number;
  abortAfterMs?: number;
  /** Test/ops override for the bounded delay before fallback. */
  retryDelayMs?: number;
  usage?: AiUsageContext;
}

class OpenRouterRequestError extends ApiError {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    status: number,
    code: string,
    retryable: boolean,
    retryAfterMs: number | null = null,
  ) {
    super(message, status, code);
    this.name = "OpenRouterRequestError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** JSON-schema-constrained generation. Returns the parsed object. */
export async function openRouterExtract<T>(
  prompt: string,
  schema: Record<string, unknown>,
  options: OpenRouterExtractOptions = {},
): Promise<T> {
  const model = options.model ?? Deno.env.get("LLM_MODEL") ??
    OPENROUTER_DEFAULT_CHAT_MODEL;
  const fallbackModel = options.fallbackModel === undefined
    ? Deno.env.get("LLM_FALLBACK_MODEL") ??
      OPENROUTER_DEFAULT_FALLBACK_MODEL
    : options.fallbackModel;
  const models = [model, fallbackModel]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index);
  for (const candidate of models) validateGoogleModel(candidate);
  validateOpenRouterSchema(schema);

  const messages: Array<Record<string, string>> = [];
  if (options.systemInstruction) {
    messages.push({ role: "system", content: options.systemInstruction });
  }
  messages.push({ role: "user", content: prompt });

  const timeoutMs = options.timeoutMs ?? OPENROUTER_EXTRACT_TIMEOUT_MS;
  const abortAfterMs = options.abortAfterMs ?? timeoutMs + 5_000;
  const deadline = Date.now() + abortAfterMs;
  let terminalError: unknown = null;

  for (const [attemptIndex, attemptModel] of models.entries()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const attemptsLeft = models.length - attemptIndex;
    // Reserve a real attempt window for fallback instead of allowing the
    // primary request to consume the entire total deadline.
    const attemptTimeoutMs = Math.max(
      1,
      Math.min(timeoutMs, Math.floor(remainingMs / attemptsLeft)),
    );
    try {
      const response = await openRouterRequest(
        "chat/completions",
        {
          model: attemptModel,
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
        attemptTimeoutMs,
        "extraction",
      );
      const body = await parseResponseJson(response, "extraction");
      throwIfProviderError(body, "extraction");
      await recordOpenRouterUsage(
        options.usage
          ? {
            ...options.usage,
            metadata: {
              ...(options.usage.metadata ?? {}),
              extraction_attempt: attemptIndex + 1,
              fallback_used: attemptIndex > 0,
            },
          }
          : undefined,
        "chat_completion",
        responseModel(body, attemptModel),
        body?.usage,
        body,
      );
      return parseStructuredContent<T>(body);
    } catch (error) {
      terminalError = error;
      const canFallback = attemptIndex < models.length - 1 &&
        error instanceof OpenRouterRequestError && error.retryable;
      if (!canFallback) throw error;

      logEvent({
        level: "warn",
        fn: "openrouter",
        event: "extraction_fallback",
        model: attemptModel,
        fallback_model: models[attemptIndex + 1],
        error_code: error.code,
        attempt: attemptIndex + 1,
      });

      const delayMs = boundedRetryDelayMs(error, options.retryDelayMs);
      if (Date.now() + delayMs >= deadline) throw error;
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  if (terminalError) throw terminalError;
  throw new OpenRouterRequestError(
    "OpenRouter extraction exhausted its total deadline",
    504,
    "openrouter_timeout",
    true,
  );
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
      await response.body?.cancel();
      throw new OpenRouterRequestError(
        `OpenRouter ${operation} failed with status ${response.status}`,
        502,
        `openrouter_${response.status}`,
        isRetryableProviderStatus(response.status),
        retryAfterMs(response.headers.get("Retry-After")),
      );
    }
    return response;
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new OpenRouterRequestError(
        `OpenRouter ${operation} aborted after ${abortAfterMs}ms`,
        504,
        "openrouter_timeout",
        true,
      );
    }
    if (error instanceof ApiError) throw error;
    throw new OpenRouterRequestError(
      `OpenRouter ${operation} network request failed`,
      502,
      "openrouter_network_error",
      true,
    );
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
    throw new OpenRouterRequestError(
      `OpenRouter ${operation} returned malformed JSON`,
      502,
      "openrouter_malformed_response",
      true,
    );
  }
}

function parseStructuredContent<T>(body: Record<string, unknown>): T {
  const choices = body.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(firstChoice) && isRecord(firstChoice.message)
    ? firstChoice.message
    : null;
  const content = message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new OpenRouterRequestError(
      "OpenRouter response missing message content",
      502,
      "openrouter_missing_content",
      true,
    );
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new OpenRouterRequestError(
      "OpenRouter returned non-JSON content",
      502,
      "openrouter_non_json_content",
      true,
    );
  }
}

function throwIfProviderError(
  body: Record<string, unknown>,
  operation: string,
): void {
  const error = body.error;
  if (!isRecord(error)) return;
  const metadata = isRecord(error.metadata) ? error.metadata : null;
  const errorType = safeErrorCode(metadata?.error_type) ??
    safeErrorCode(error.code) ?? "provider_error";
  const numericCode = intValue(error.code);
  throw new OpenRouterRequestError(
    `OpenRouter ${operation} returned provider error ${errorType}`,
    numericCode === 408 || numericCode === 504 ? 504 : 502,
    `openrouter_${errorType}`,
    isRetryableProviderError(errorType, numericCode),
  );
}

function validateGoogleModel(model: string): void {
  if (!model.startsWith("google/")) {
    throw new ApiError(
      "LLM models must use the google/ namespace for the pinned Google Vertex route",
      500,
      "openrouter_invalid_model",
    );
  }
}

export function validateOpenRouterSchema(
  schema: Record<string, unknown>,
): void {
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    if (Object.prototype.hasOwnProperty.call(value, "nullable")) {
      throw new ApiError(
        `OpenRouter schema uses unsupported nullable keyword at ${path}`,
        500,
        "openrouter_invalid_schema",
      );
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${path}.${key}`);
    }
  };
  visit(schema, "schema");
}

function safeErrorCode(value: unknown): string | null {
  const normalized = typeof value === "number"
    ? String(Math.trunc(value))
    : typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_")
    : "";
  return /^[a-z0-9_-]{1,80}$/.test(normalized) ? normalized : null;
}

function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableProviderError(
  errorType: string,
  numericCode: number | null,
): boolean {
  if (numericCode !== null && isRetryableProviderStatus(numericCode)) {
    return true;
  }
  return new Set([
    "provider_overloaded",
    "provider_unavailable",
    "rate_limit_exceeded",
    "server",
    "timeout",
    "unmapped",
  ]).has(errorType);
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(5_000, Math.round(seconds * 1_000));
}

function boundedRetryDelayMs(
  error: OpenRouterRequestError,
  override: number | undefined,
): number {
  if (override !== undefined) return Math.max(0, Math.min(5_000, override));
  return error.retryAfterMs ?? 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
