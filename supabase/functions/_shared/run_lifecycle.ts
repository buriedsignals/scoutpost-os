/**
 * Shared scout run lifecycle helpers.
 *
 * These helpers keep the legacy public scout_runs columns in sync while adding
 * internal stage/error/notification diagnostics for operator support.
 */

import type { SupabaseClient } from "./supabase.ts";
import { ApiError, AuthError, ValidationError } from "./errors.ts";
import { logEvent } from "./log.ts";

export type RunStage =
  | "dispatch"
  | "scrape"
  | "diff"
  | "extract"
  | "dedup"
  | "insert_units"
  | "notify"
  | "credits"
  | "finalize";

export type RunErrorClass =
  | "platform"
  | "provider"
  | "auth"
  | "quota"
  | "validation"
  | "timeout"
  | "no_baseline"
  | "unknown";

export type NotificationStatus =
  | "not_applicable"
  | "pending"
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced"
  | "suppressed"
  | "complained"
  | "skipped"
  | "failed";

export interface ClassifiedRunError {
  errorClass: RunErrorClass;
  stage: RunStage;
  message: string;
}

const ERROR_MESSAGE_LIMIT = 2000;

async function updateRun(
  db: SupabaseClient,
  runId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("scout_runs")
    .update(values)
    .eq("id", runId);
  if (error) throw new Error(`failed to update scout_runs: ${error.message}`);
}

async function recordRunEvent(
  db: SupabaseClient,
  runId: string,
  values: {
    stage?: RunStage | null;
    status?: "running" | "success" | "error" | "skipped" | null;
    errorClass?: RunErrorClass | null;
    notificationStatus?: NotificationStatus | null;
    message?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { data: run, error: runErr } = await db
      .from("scout_runs")
      .select("scout_id, user_id")
      .eq("id", runId)
      .maybeSingle();
    if (runErr) throw new Error(runErr.message);

    const { error } = await db
      .from("scout_run_events")
      .insert({
        scout_run_id: runId,
        scout_id: (run as { scout_id?: string | null } | null)?.scout_id ??
          null,
        user_id: (run as { user_id?: string | null } | null)?.user_id ?? null,
        stage: values.stage ?? null,
        status: values.status ?? null,
        error_class: values.errorClass ?? null,
        notification_status: values.notificationStatus ?? null,
        message: values.message?.slice(0, ERROR_MESSAGE_LIMIT) ?? null,
        metadata: values.metadata ?? {},
      });
    if (error) throw new Error(error.message);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "run-lifecycle",
      event: "event_insert_failed",
      run_id: runId,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function markRunStage(
  db: SupabaseClient,
  runId: string,
  stage: RunStage,
): Promise<void> {
  await updateRun(db, runId, { stage });
  await recordRunEvent(db, runId, { stage, status: "running" });
}

export async function markRunSuccess(
  db: SupabaseClient,
  runId: string,
  opts: {
    unitsCreated: number;
    unitsMerged: number;
    criteriaStatus: boolean;
    notificationStatus: NotificationStatus;
    stage?: RunStage;
    scraperStatus?: boolean;
    errorMessage?: string | null;
    sourcesScraped?: number;
    sourcesFailed?: number;
  },
): Promise<void> {
  const updateValues: Record<string, unknown> = {
    status: "success",
    stage: opts.stage ?? "finalize",
    error_class: null,
    error_message: opts.errorMessage ?? null,
    scraper_status: opts.scraperStatus ?? true,
    criteria_status: opts.criteriaStatus,
    articles_count: opts.unitsCreated,
    merged_existing_count: opts.unitsMerged,
    units_created_count: opts.unitsCreated,
    units_merged_count: opts.unitsMerged,
    notification_status: opts.notificationStatus,
    completed_at: new Date().toISOString(),
  };
  if (opts.sourcesScraped !== undefined) {
    updateValues.sources_scraped = opts.sourcesScraped;
  }
  if (opts.sourcesFailed !== undefined) {
    updateValues.sources_failed = opts.sourcesFailed;
  }
  await updateRun(db, runId, updateValues);

  const eventMetadata: Record<string, unknown> = {
    units_created_count: opts.unitsCreated,
    units_merged_count: opts.unitsMerged,
    criteria_status: opts.criteriaStatus,
  };
  if (opts.sourcesScraped !== undefined) {
    eventMetadata.sources_scraped = opts.sourcesScraped;
  }
  if (opts.sourcesFailed !== undefined) {
    eventMetadata.sources_failed = opts.sourcesFailed;
  }
  await recordRunEvent(db, runId, {
    stage: opts.stage ?? "finalize",
    status: "success",
    notificationStatus: opts.notificationStatus,
    message: opts.errorMessage ?? null,
    metadata: eventMetadata,
  });
}

export async function markRunError(
  db: SupabaseClient,
  runId: string,
  opts: {
    stage: RunStage;
    errorClass: RunErrorClass;
    message: string;
    status?: "error" | "skipped";
  },
): Promise<void> {
  await updateRun(db, runId, {
    status: opts.status ?? "error",
    stage: opts.stage,
    error_class: opts.errorClass,
    error_message: opts.message.slice(0, ERROR_MESSAGE_LIMIT),
    notification_status: "not_applicable",
    scraper_status: opts.status === "skipped",
    criteria_status: false,
    completed_at: new Date().toISOString(),
  });
  await recordRunEvent(db, runId, {
    stage: opts.stage,
    status: opts.status ?? "error",
    errorClass: opts.errorClass,
    notificationStatus: "not_applicable",
    message: opts.message,
  });
}

export async function markNotificationAttempted(
  db: SupabaseClient,
  runId: string,
): Promise<void> {
  await updateRun(db, runId, {
    stage: "notify",
    notification_status: "pending",
  });
  await recordRunEvent(db, runId, {
    stage: "notify",
    status: "running",
    notificationStatus: "pending",
  });
}

export async function markNotificationResult(
  db: SupabaseClient,
  runId: string,
  status: Extract<NotificationStatus, "sent" | "failed" | "skipped">,
  details?: string | {
    message?: string | null;
    providerId?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  const detail = typeof details === "string" ? { message: details } : details ??
    {};
  const values: Record<string, unknown> = {
    stage: "notify",
    notification_status: status,
    notification_reason: detail.reason ?? null,
    notification_provider_id: detail.providerId ?? null,
  };
  if (status === "failed" && detail.message) {
    values.error_message = `notification failed: ${detail.message}`.slice(
      0,
      ERROR_MESSAGE_LIMIT,
    );
  }
  await updateRun(db, runId, values);
  await recordRunEvent(db, runId, {
    stage: "notify",
    status: "success",
    notificationStatus: status,
    message: status === "failed" ? detail.message ?? null : null,
    metadata: {
      notification_reason: detail.reason ?? null,
      notification_provider_id: detail.providerId ?? null,
    },
  });
}

export function classifyRunError(
  error: unknown,
  fallbackStage: RunStage = "finalize",
): ClassifiedRunError {
  const message = messageOf(error);
  const lower = message.toLowerCase();

  if (error instanceof AuthError) {
    return { errorClass: "auth", stage: "dispatch", message };
  }
  if (lower.includes("no baseline")) {
    return { errorClass: "no_baseline", stage: "dispatch", message };
  }
  if (error instanceof ValidationError) {
    return { errorClass: "validation", stage: fallbackStage, message };
  }
  if (lower.includes("not configured")) {
    return { errorClass: "platform", stage: fallbackStage, message };
  }
  if (error instanceof ApiError && error.status === 504) {
    return { errorClass: "timeout", stage: fallbackStage, message };
  }
  if (
    error instanceof ApiError &&
    [502, 503].includes(error.status)
  ) {
    return { errorClass: "provider", stage: fallbackStage, message };
  }
  if (
    lower.includes("firecrawl") ||
    lower.includes("crawl4ai") ||
    lower.includes("gemini") ||
    lower.includes("apify") ||
    lower.includes("all ") && lower.includes(" sources failed") ||
    lower.includes("extract failed") ||
    lower.includes("embed failed")
  ) {
    return { errorClass: "provider", stage: fallbackStage, message };
  }
  if (
    lower.includes("raw_captures") ||
    lower.includes("information_units") ||
    lower.includes("scout_runs") ||
    lower.includes("unit insert failed") ||
    lower.includes("queue insert failed") ||
    lower.includes("upsert") ||
    lower.includes("rpc") ||
    lower.includes("database") ||
    lower.includes("relation ") ||
    lower.includes("column ") ||
    lower.includes("duplicate key") ||
    lower.includes("violates")
  ) {
    return { errorClass: "platform", stage: fallbackStage, message };
  }

  return { errorClass: "unknown", stage: fallbackStage, message };
}

export function shouldIncrementScoutFailure(
  errorClass: RunErrorClass,
): boolean {
  return errorClass === "provider" ||
    errorClass === "timeout" ||
    errorClass === "unknown";
}
