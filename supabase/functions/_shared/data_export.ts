/**
 * Self-service personal data export (GDPR Art. 15 access, Art. 20
 * portability) behind `GET /user/data-export`.
 *
 * Every section reads one user-owned table through the service client with a
 * mandatory owner filter, an explicit column allowlist (new columns, vectors
 * and secrets stay out until reviewed here) and keyset pagination, so no
 * PostgREST row cap or concurrent insert/delete can silently drop rows. The
 * document is streamed section by section; a failed read aborts the stream
 * instead of finishing a valid-looking but incomplete file.
 */

import type { SupabaseClient } from "./supabase.ts";
import { makeCorsHeaders } from "./cors.ts";
import { logEvent } from "./log.ts";
import { sha256Hex } from "./unit_dedup.ts";

export interface DataExportSection {
  /** Key under `sections` in the exported document. */
  name: string;
  table: string;
  /** Explicit allowlist. Never `*`: tables carry vectors and secret hashes. */
  columns: readonly string[];
  /** Column holding the caller's id. Defaults to `user_id`. */
  owner?: string;
  /** Unique key within the owner's rows; drives keyset pagination. */
  key: readonly string[];
}

/** Matches the hosted PostgREST `max_rows`; pages also end only when empty. */
export const DATA_EXPORT_PAGE_SIZE = 1000;

/**
 * Fixed-window budget per user. A full export reads every owned table, so it
 * is bounded like other expensive self-service actions; three per hour leaves
 * room to retry an interrupted download.
 */
export const DATA_EXPORT_LIMIT = 3;
export const DATA_EXPORT_WINDOW_SECONDS = 3600;

export const DATA_EXPORT_SECTIONS: readonly DataExportSection[] = [
  {
    name: "preferences",
    table: "user_preferences",
    key: ["user_id"],
    columns: [
      "timezone",
      "preferred_language",
      "default_location",
      "excluded_domains",
      "preferences",
      "onboarding_completed",
      "onboarding_tour_completed",
      "health_notifications_enabled",
      "tier",
      "active_org_id",
      "created_at",
      "updated_at",
    ],
  },
  {
    name: "credit_accounts",
    table: "credit_accounts",
    key: ["id"],
    columns: [
      "org_id",
      "tier",
      "monthly_cap",
      "balance",
      "update_on",
      "seated_count",
      "entitlement_source",
      "updated_at",
    ],
  },
  {
    name: "credit_usage",
    table: "usage_records",
    key: ["id"],
    columns: [
      "org_id",
      "scout_id",
      "scout_type",
      "operation",
      "cost",
      "balance_after",
      "credit_owner",
      "created_at",
      "expires_at",
    ],
  },
  {
    name: "ai_usage",
    table: "ai_usage_records",
    key: ["id"],
    columns: [
      "org_id",
      "scout_id",
      "scout_run_id",
      "provider",
      "model",
      "operation",
      "function_name",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "created_at",
      "expires_at",
    ],
  },
  {
    name: "team_memberships",
    table: "org_members",
    key: ["org_id"],
    columns: ["tier_before_team", "joined_at"],
  },
  {
    name: "projects",
    table: "projects",
    key: ["id"],
    columns: [
      "name",
      "description",
      "visibility",
      "tags",
      "is_default",
      "created_at",
      "updated_at",
    ],
  },
  {
    name: "project_memberships",
    table: "project_members",
    key: ["project_id"],
    columns: ["role", "added_at"],
  },
  {
    name: "scouts",
    table: "scouts",
    key: ["id"],
    columns: [
      "name",
      "type",
      "description",
      "project_id",
      "criteria",
      "preferred_language",
      "regularity",
      "schedule_cron",
      "schedule_timezone",
      "topic",
      "url",
      "source_mode",
      "excluded_domains",
      "priority_sources",
      "platform",
      "profile_handle",
      "monitor_mode",
      "track_removals",
      "root_domain",
      "tracked_urls",
      "processed_pdf_urls",
      "location",
      "config",
      "metadata",
      "is_active",
      "archive_enabled",
      "wayback_enabled",
      "consecutive_failures",
      "baseline_established_at",
      "schedule_last_dispatched_at",
      "created_at",
      "updated_at",
    ],
  },
  {
    name: "scout_runs",
    table: "scout_runs",
    key: ["id"],
    columns: [
      "scout_id",
      "status",
      "stage",
      "scraper_status",
      "criteria_status",
      "error_class",
      "error_message",
      "articles_count",
      "units_created_count",
      "units_merged_count",
      "merged_existing_count",
      "sources_scraped",
      "sources_failed",
      "notification_sent",
      "notification_status",
      "notification_reason",
      "notification_event_at",
      "page_notification_mode",
      "metadata",
      "started_at",
      "completed_at",
      "expires_at",
    ],
  },
  {
    name: "execution_records",
    table: "execution_records",
    key: ["id"],
    columns: [
      "scout_id",
      "scout_type",
      "summary_text",
      "content_hash",
      "is_duplicate",
      "metadata",
      "completed_at",
      "expires_at",
    ],
  },
  {
    name: "information_units",
    table: "information_units",
    key: ["id"],
    columns: [
      "scout_id",
      "project_id",
      "raw_capture_id",
      "scout_type",
      "article_id",
      "statement",
      "type",
      "entities",
      "context_excerpt",
      "source_url",
      "source_domain",
      "source_title",
      "source_type",
      "discovered_from_url",
      "event_date",
      "occurred_at",
      "country",
      "state",
      "city",
      "topic",
      "dataset_id",
      "used_in_article",
      "used_at",
      "used_in_url",
      "verified",
      "verification_notes",
      "verified_by",
      "verified_at",
      "fact_checked",
      "confidence_score",
      "abstained",
      "abstain_reason",
      "occurrence_count",
      "source_count",
      "first_seen_at",
      "last_seen_at",
      "extracted_at",
      "expires_at",
      "deleted_at",
      "deleted_by",
      "deletion_reason",
    ],
  },
  {
    name: "unit_occurrences",
    table: "unit_occurrences",
    key: ["id"],
    columns: [
      "unit_id",
      "project_id",
      "scout_id",
      "scout_run_id",
      "raw_capture_id",
      "scout_type",
      "source_kind",
      "source_url",
      "normalized_source_url",
      "source_title",
      "source_domain",
      "discovered_from_url",
      "content_sha256",
      "statement_hash",
      "occurred_at",
      "extracted_at",
      "metadata",
      "created_at",
    ],
  },
  {
    name: "entities",
    table: "entities",
    key: ["id"],
    columns: [
      "canonical_name",
      "type",
      "aliases",
      "metadata",
      "mention_count",
      "first_seen_at",
      "last_seen_at",
      "created_at",
      "updated_at",
    ],
  },
  {
    name: "unit_entities",
    table: "unit_entities",
    key: ["unit_id", "mention_text"],
    columns: ["entity_id", "confidence", "resolved_at"],
  },
  {
    name: "reflections",
    table: "reflections",
    key: ["id"],
    columns: [
      "project_id",
      "scope_description",
      "content",
      "time_range_start",
      "time_range_end",
      "generated_by",
      "source_unit_ids",
      "source_entity_ids",
      "metadata",
      "created_at",
    ],
  },
  {
    name: "ingests",
    table: "ingests",
    key: ["id"],
    columns: [
      "project_id",
      "kind",
      "source_url",
      "title",
      "criteria",
      "notes",
      "status",
      "error_message",
      "created_at",
      "completed_at",
    ],
  },
  {
    // Capture bodies stay out; each capture is listed so it can be requested.
    name: "page_captures",
    table: "raw_captures",
    key: ["id"],
    columns: [
      "scout_id",
      "scout_run_id",
      "ingest_id",
      "source_url",
      "source_domain",
      "content_sha256",
      "canonical_content_sha256",
      "token_count",
      "page_response_status",
      "captured_at",
      "expires_at",
    ],
  },
  {
    name: "page_snapshots",
    table: "page_snapshots",
    key: ["id"],
    columns: [
      "scout_id",
      "scout_run_id",
      "raw_capture_id",
      "capture_kind",
      "fidelity",
      "requested_url",
      "final_url",
      "http_status",
      "content_sha256",
      "markdown_bytes",
      "mhtml_bytes",
      "screenshot_bytes",
      "rawhtml_bytes",
      "tsa_status",
      "wayback_status",
      "wayback_url",
      "captured_at",
      "expires_at",
      "created_at",
    ],
  },
  {
    name: "social_snapshots",
    table: "post_snapshots",
    key: ["id"],
    columns: ["scout_id", "platform", "handle", "post_count", "updated_at"],
  },
  {
    name: "source_expressions",
    table: "source_expressions",
    key: ["id"],
    columns: [
      "raw_capture_id",
      "exact_text",
      "start_byte",
      "end_byte",
      "start_line",
      "end_line",
      "language",
      "attribution",
      "is_direct_quote",
      "lifecycle_status",
      "created_at",
    ],
  },
  {
    name: "source_expression_links",
    table: "source_expression_links",
    key: ["id"],
    columns: [
      "source_expression_id",
      "unit_id",
      "unit_occurrence_id",
      "relation_kind",
      "link_method",
      "review_status",
      "reviewed_at",
      "review_notes",
      "created_at",
    ],
  },
  {
    name: "promises",
    table: "promises",
    key: ["id"],
    columns: [
      "scout_id",
      "unit_id",
      "promise_text",
      "context",
      "source_url",
      "source_title",
      "meeting_date",
      "due_date",
      "date_confidence",
      "status",
      "active_revision_id",
      "due_notified_at",
      "created_at",
      "updated_at",
    ],
  },
  {
    name: "promise_revisions",
    table: "promise_revisions",
    key: ["id"],
    columns: [
      "promise_id",
      "due_date",
      "date_confidence",
      "due_date_text",
      "source_url",
      "context",
      "previous_revision_id",
      "amendment_reason",
      "created_at",
    ],
  },
  {
    name: "promise_status_history",
    table: "promise_status_history",
    key: ["id"],
    columns: [
      "promise_id",
      "from_status",
      "to_status",
      "reason",
      "evidence_url",
      "created_at",
    ],
  },
  {
    name: "civic_document_baselines",
    table: "civic_document_baselines",
    key: ["scout_id", "source_url"],
    columns: ["content_sha256", "observed_at"],
  },
  {
    name: "transport_tracking",
    table: "transport_scout_state",
    key: ["scout_id", "object_id"],
    columns: ["first_seen", "last_seen", "alerted_at", "metadata"],
  },
  {
    name: "api_keys",
    table: "api_keys",
    key: ["id"],
    columns: ["name", "key_prefix", "source", "created_at", "last_used_at"],
  },
  {
    name: "cli_authorizations",
    table: "cli_device_authorizations",
    owner: "approved_by",
    key: ["id"],
    columns: [
      "client_name",
      "agent_label",
      "device_label",
      "site_origin",
      "status",
      "decided_at",
      "consumed_at",
      "created_at",
    ],
  },
  {
    name: "mcp_clients",
    table: "mcp_oauth_clients",
    key: ["client_id"],
    columns: ["client_name", "redirect_uris", "created_at", "last_used_at"],
  },
];

/** Written into the file so the reader knows what is deliberately absent. */
export const DATA_EXPORT_EXCLUSIONS: readonly string[] = [
  "Embedding vectors and search indexes derived from your text.",
  "Secrets: API key, OAuth client and sign-in code hashes, access and refresh tokens.",
  "Captured page and social post bodies, HTML, screenshots and archive files; page_captures, page_snapshots and social_snapshots list each capture instead.",
  "Internal processing state: queues, leases, retries, run diagnostics, deduplication signatures, notification delivery ledgers and short-lived previews.",
  "Shared team data: team credit accounts and other people's records.",
  "Trust-and-safety review records.",
];

export interface DataExportAccount {
  id: string;
  email: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  user_metadata: Record<string, unknown>;
}

export interface DataExportBudget {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Consumes one export from the caller's hourly budget through the shared
 * hashed fixed-window limiter (`consume_cli_auth_rate_limit`, 00098). Its
 * expired rows are already swept by the CLI cleanup cron.
 */
export async function consumeDataExportBudget(
  svc: SupabaseClient,
  userId: string,
): Promise<DataExportBudget> {
  const { data, error } = await svc.rpc("consume_cli_auth_rate_limit", {
    p_bucket_hash: await sha256Hex(`user-data-export:${userId}`),
    p_action: "data_export",
    p_limit: DATA_EXPORT_LIMIT,
    p_window_seconds: DATA_EXPORT_WINDOW_SECONDS,
  });
  if (error) throw new Error("data export rate limit check failed");
  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: row?.allowed === true,
    retryAfterSeconds: Number(row?.retry_after) || DATA_EXPORT_WINDOW_SECONDS,
  };
}

export async function loadDataExportAccount(
  svc: SupabaseClient,
  userId: string,
): Promise<DataExportAccount> {
  const { data, error } = await svc.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error("data export account lookup failed");
  return {
    id: data.user.id,
    email: data.user.email ?? null,
    created_at: data.user.created_at ?? null,
    last_sign_in_at: data.user.last_sign_in_at ?? null,
    user_metadata: data.user.user_metadata ?? {},
  };
}

/** PostgREST logic-tree value, quoted so URLs and labels cannot break it. */
function filterValue(value: unknown): string {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Rows strictly after `last` in key order:
 * `k1 > v1 OR (k1 = v1 AND k2 > v2) OR ...`.
 */
function afterKey(key: readonly string[], last: Record<string, unknown>) {
  return key.map((column, index) => {
    const equal = key.slice(0, index).map((prior) =>
      `${prior}.eq.${filterValue(last[prior])}`
    );
    const greater = `${column}.gt.${filterValue(last[column])}`;
    return equal.length ? `and(${[...equal, greater].join(",")})` : greater;
  }).join(",");
}

async function* sectionPages(
  svc: SupabaseClient,
  section: DataExportSection,
  userId: string,
): AsyncGenerator<Record<string, unknown>[]> {
  const select = [...new Set([...section.key, ...section.columns])].join(",");
  let last: Record<string, unknown> | null = null;
  while (true) {
    let query = svc
      .from(section.table)
      .select(select)
      .eq(section.owner ?? "user_id", userId);
    if (last) query = query.or(afterKey(section.key, last));
    for (const column of section.key) {
      query = query.order(column, { ascending: true });
    }
    const { data, error } = await query.limit(DATA_EXPORT_PAGE_SIZE);
    if (error) {
      throw new Error(`data export read failed for ${section.name}`);
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    // Only an empty page ends a section: a short page may just be a lower
    // server row cap.
    if (rows.length === 0) return;
    yield rows;
    last = rows[rows.length - 1];
  }
}

async function* documentChunks(
  svc: SupabaseClient,
  account: DataExportAccount,
  sections: readonly DataExportSection[],
  generatedAt: Date,
): AsyncGenerator<string> {
  yield `{"format":"scoutpost-personal-data","version":1,"generated_at":${
    JSON.stringify(generatedAt.toISOString())
  },"account":${JSON.stringify(account)},"excluded":${
    JSON.stringify(DATA_EXPORT_EXCLUSIONS)
  },"sections":{`;
  for (const [index, section] of sections.entries()) {
    yield `${index ? "," : ""}${JSON.stringify(section.name)}:{"rows":[`;
    let count = 0;
    for await (const rows of sectionPages(svc, section, account.id)) {
      yield (count ? "," : "") +
        rows.map((row) => JSON.stringify(row)).join(",");
      count += rows.length;
    }
    yield `],"count":${count}}`;
  }
  yield "}}";
}

/** Streams the caller's export as an attachment. */
export function dataExportResponse(
  req: Request,
  svc: SupabaseClient,
  account: DataExportAccount,
  sections: readonly DataExportSection[] = DATA_EXPORT_SECTIONS,
  generatedAt = new Date(),
): Response {
  const chunks = documentChunks(svc, account, sections, generatedAt);
  const logged = async function* () {
    try {
      yield* chunks;
      logEvent({
        level: "info",
        fn: "user",
        event: "data_export_completed",
        user_id: account.id,
      });
    } catch (error) {
      logEvent({
        level: "error",
        fn: "user",
        event: "data_export_failed",
        user_id: account.id,
        msg: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const date = generatedAt.toISOString().slice(0, 10);
  return new Response(
    ReadableStream.from(logged()).pipeThrough(new TextEncoderStream()),
    {
      status: 200,
      headers: {
        ...makeCorsHeaders(req.headers.get("origin")),
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition":
          `attachment; filename="scoutpost-data-${date}.json"`,
        "Cache-Control": "no-store",
        // Cross-origin fetches only see this header when it is exposed.
        "Access-Control-Expose-Headers": "Content-Disposition",
      },
    },
  );
}
