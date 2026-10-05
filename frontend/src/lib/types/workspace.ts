/**
 * Workspace types — shapes derived from Supabase Edge Functions (OSS) and
 * FastAPI routes (SaaS).
 *
 * Envelope divergence is tolerated by the api-client helpers in
 * `$lib/api-client.ts` via a unified unwrap rule:
 *
 *   body.data ?? body.items ?? body
 *
 * This lets the frontend treat Edge Function responses like
 * `{items, pagination}` and FastAPI responses like `{data: [...]}` (or bare
 * arrays) uniformly. Where a bespoke shape is needed, the helper documents it
 * in JSDoc.
 *
 * See `docs/migration-plans/04-workspace-ui.md` PR 1 for authoritative
 * contracts and the full shape-mismatch audit.
 */

// ---------------------------------------------------------------------------
// Scout
// ---------------------------------------------------------------------------

/**
 * Backend scout type (persisted to the database).
 */
export type ScoutType = "web" | "pulse" | "social" | "civic" | "transport";

/**
 * Scout — periodic job that produces units.
 *
 * Shape derived from:
 *  - Edge Function `supabase/functions/scouts/index.ts` →
 *    `shapeScoutResponse` in `supabase/functions/_shared/db.ts` (the canonical
 *    agent-first envelope with nested `last_run`).
 *  - FastAPI `backend/app/routers/v1.py` (`/v1/scouts`) returns a similar flat
 *    row; the api-client tolerates both.
 */
export interface Scout {
  id: string;
  name: string;
  type: string;
  is_demo?: boolean;
  description?: string | null;
  criteria?: string | null;
  topic?: string | null;
  url?: string | null;
  source_mode?: string | null;
  excluded_domains?: string[];
  priority_sources?: string[];
  platform?: string | null;
  profile_handle?: string | null;
  monitor_mode?: string | null;
  track_removals?: boolean;
  root_domain?: string | null;
  tracked_urls?: string[];
  location?: Record<string, unknown> | null;
  project_id?: string | null;
  regularity?: string | null;
  schedule_cron?: string | null;
  is_active: boolean;
  consecutive_failures?: number;
  last_run?: {
    started_at: string | null;
    status: string | null;
    articles_count: number | null;
    merged_existing_count?: number | null;
    stage?: string | null;
    error_class?: string | null;
    notification_status?: string | null;
    notification_reason?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  created_at?: string | null;
}

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

/**
 * Entity reference embedded in a unit (chip-style display in the drawer).
 *
 * Shape derived from `UnitEntityRef` in `supabase/functions/_shared/db.ts`.
 */
export interface UnitEntityRef {
  entity_id: string | null;
  canonical_name: string | null;
  type: string | null;
  mention_text: string;
}

/**
 * Information unit (atomic fact from a scout run or manual ingest).
 *
 * Shape derived from `UnitResponse` in `supabase/functions/_shared/db.ts`.
 * FastAPI `backend/app/routers/units.py` exposes a flatter
 * `InformationUnit` shape; the api-client helpers surface the richer
 * Edge Function envelope and fall back to the flat FastAPI shape where the
 * nested fields are absent.
 */
export interface Unit {
  id: string;
  is_demo?: boolean;
  statement: string | null;
  context_excerpt?: string | null;
  unit_type: string | null;
  entities: UnitEntityRef[];
  location?: Record<string, unknown> | null;
  occurred_at?: string | null;
  extracted_at: string | null;
  occurrence_count?: number;
  source: {
    url: string | null;
    title: string | null;
    domain: string | null;
  };
  sources?: Array<{
    url: string | null;
    title: string | null;
    domain: string | null;
    extracted_at: string | null;
  }>;
  linked_scouts?: Array<{
    id: string | null;
    name: string | null;
    type: string | null;
  }>;
  verification?: {
    verified: boolean;
    verified_at: string | null;
    verified_by: string | null;
    notes: string | null;
  };
  usage?: {
    used_in_article: boolean;
    used_at: string | null;
    used_in_url: string | null;
  };
  deletion?: {
    deleted: boolean;
    deleted_at: string | null;
    deleted_by: string | null;
    reason: string | null;
  };
  tags?: string[];
  scout_id?: string;
  scout_name?: string;
  similarity?: number | null;
  search_rank?: number | null;
  search_match?: {
    category: "direct" | "related" | "loose";
    reason: string;
    keyword_fields: Array<
      | "statement"
      | "context_excerpt"
      | "source"
      | "entities"
      | "scout_name"
      | "linked_scouts"
      | "tags"
    >;
    semantic_similarity: number | null;
    below_interest_threshold: boolean;
  };
}

// ---------------------------------------------------------------------------
// Paginated envelopes
// ---------------------------------------------------------------------------

/**
 * Paginated units page used by the Inbox store. `next_cursor` is a stringified
 * integer offset (the Edge Functions paginate by `{offset, limit}`; the
 * client encodes the next offset as a cursor to keep the API surface cursor-
 * shaped for a future cursor-native backend).
 */
export interface PaginatedUnits {
  units: Unit[];
  next_cursor: string | null;
}

/** Paginated scout page used by the workspace scout index. */
export interface PaginatedScouts {
  scouts: Scout[];
  next_cursor: string | null;
  total: number;
}
