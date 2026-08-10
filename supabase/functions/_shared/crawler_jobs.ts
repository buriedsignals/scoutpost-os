import type { SupabaseClient } from "./supabase.ts";
import { sha256Hex } from "./unit_dedup.ts";

export type CrawlerOperation = "scrape" | "snapshot" | "parse_pdf";
export type CrawlerRequestKind =
  | "scout_run"
  | "ingest"
  | "baseline"
  | "preview"
  | "benchmark"
  | "proxy";
export type CrawlerAdmissionClass = "scout" | "utility";

export interface CrawlerJobInput {
  requestKind: CrawlerRequestKind;
  /** Proxy requests retain request_kind=proxy for lifecycle cleanup while
   * selecting either normal Scout admission or bounded utility admission. */
  admissionClass?: CrawlerAdmissionClass;
  tenantKey: string;
  continuationKey: string;
  operation: CrawlerOperation;
  pipelineStage: string;
  url: string;
  /** Stable caller-owned identity, such as article id or stage item id. */
  itemKey: string;
  options?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  scoutRunId?: string;
  scoutId?: string;
  userId?: string;
}

export interface CrawlerJobRow {
  id: string;
  dedupe_key: string;
  status: string;
  request_kind: CrawlerRequestKind;
  continuation_key: string;
}

export async function crawlerJobDedupeKey(
  input: Pick<
    CrawlerJobInput,
    | "requestKind"
    | "tenantKey"
    | "continuationKey"
    | "pipelineStage"
    | "operation"
    | "itemKey"
    | "url"
  >,
): Promise<string> {
  const parts = [
    input.requestKind,
    requiredText(input.tenantKey, "tenant key", 200),
    requiredText(input.continuationKey, "continuation key", 500),
    requiredText(input.pipelineStage, "pipeline stage", 100),
    input.operation,
    assertHttpUrl(input.url),
    requiredText(input.itemKey, "item key", 500),
  ];
  return `crawler:v1:${await sha256Hex(parts.join("\u001f"))}`;
}

/**
 * Service-only durable enqueue. Duplicate calls return the original row and
 * never reset a running or terminal job. Utility admission is performed in
 * the same database transaction as insertion.
 */
export async function enqueueCrawlerJob(
  svc: SupabaseClient,
  input: CrawlerJobInput,
): Promise<CrawlerJobRow> {
  if (input.requestKind === "proxy" && !input.admissionClass) {
    throw new Error("proxy crawler job requires an admission class");
  }
  const url = assertHttpUrl(input.url);
  const dedupeKey = await crawlerJobDedupeKey({ ...input, url });
  const options = input.requestKind === "proxy"
    ? { ...(input.options ?? {}), admission_class: input.admissionClass }
    : input.options ?? {};
  const common = {
    p_dedupe_key: dedupeKey,
    p_request_kind: input.requestKind,
    p_tenant_key: requiredText(input.tenantKey, "tenant key", 200),
    p_continuation_key: requiredText(
      input.continuationKey,
      "continuation key",
      500,
    ),
    p_operation: input.operation,
    p_pipeline_stage: requiredText(input.pipelineStage, "pipeline stage", 100),
    p_url: url,
    p_options: options,
  };

  const utility = input.requestKind === "ingest" ||
    input.requestKind === "baseline" || input.requestKind === "preview" ||
    (input.requestKind === "proxy" && input.admissionClass === "utility");
  const request = utility
    ? svc.rpc("admit_and_enqueue_crawler_utility", {
      ...common,
      p_global_daily_limit: crawlerUtilityDailyLimit(),
    })
    : svc.rpc("enqueue_crawler_job", {
      ...common,
      p_priority: input.priority ?? 0,
      p_max_attempts: input.maxAttempts ?? 3,
      p_scout_run_id: input.scoutRunId ?? null,
      p_scout_id: input.scoutId ?? null,
      p_user_id: input.userId ?? null,
    });
  const { data, error } = await request;
  if (error) throw new Error(`crawler enqueue failed: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as
    | CrawlerJobRow
    | null;
  if (!row?.id || !row.dedupe_key) {
    throw new Error("crawler enqueue returned no job");
  }
  return row;
}

export function crawlerUtilityDailyLimit(
  raw = Deno.env.get("CRAWLER_UTILITY_DAILY_JOB_LIMIT"),
): number {
  if (raw === undefined || raw.trim() === "") return 10_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error("invalid crawler utility daily limit");
  }
  return value;
}

function requiredText(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`invalid ${label}`);
  return trimmed;
}

function assertHttpUrl(value: string): string {
  if (value.length > 8192) throw new Error("invalid crawler URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid crawler URL");
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
    throw new Error("invalid crawler URL");
  }
  return parsed.toString();
}
