/**
 * Agent-first response shapers. Produce self-contained JSON so an LLM never
 * needs a follow-up fetch to understand a unit or a scout.
 */

import type { SupabaseClient } from "./supabase.ts";

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

export interface UnitEntityRef {
  entity_id: string | null;
  canonical_name: string | null;
  type: string | null;
  mention_text: string;
}

export interface UnitSourceRef {
  url: string | null;
  title: string | null;
  domain: string | null;
  discovered_from_url: string | null;
  extracted_at: string | null;
}

export interface LinkedScoutRef {
  id: string | null;
  name: string | null;
  type: string | null;
}

export interface UnitResponse {
  id: string;
  statement: string | null;
  context_excerpt: string | null;
  unit_type: string | null;
  entities: UnitEntityRef[];
  location: Record<string, unknown> | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  topic?: string | null;
  scout_type?: string | null;
  occurred_at: string | null;
  extracted_at: string | null;
  occurrence_count: number;
  source: {
    url: string | null;
    title: string | null;
    domain: string | null;
    discovered_from_url: string | null;
  };
  sources: UnitSourceRef[];
  linked_scouts: LinkedScoutRef[];
  scout_id: string | null;
  scout_name: string | null;
  verification: {
    verified: boolean;
    verified_at: string | null;
    verified_by: string | null;
    notes: string | null;
  };
  usage: {
    used_in_article: boolean;
    used_at: string | null;
    used_in_url: string | null;
  };
  deletion: {
    deleted: boolean;
    deleted_at: string | null;
    deleted_by: string | null;
    reason: string | null;
  };
  tags: string[];
}

interface RawUnitRow {
  id: string;
  statement?: string | null;
  context_excerpt?: string | null;
  type?: string | null; // column is named `type` in the schema; surfaced as unit_type in the response
  scout_id?: string | null;
  location?: Record<string, unknown> | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  topic?: string | null;
  scout_type?: string | null;
  occurred_at?: string | null;
  extracted_at?: string | null;
  last_seen_at?: string | null;
  source_url?: string | null;
  source_title?: string | null;
  source_domain?: string | null;
  discovered_from_url?: string | null;
  occurrence_count?: number | null;
  entities?: string[] | null;
  verified?: boolean | null;
  verified_at?: string | null;
  verified_by?: string | null;
  verification_notes?: string | null;
  used_in_article?: boolean | null;
  used_at?: string | null;
  used_in_url?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  deletion_reason?: string | null;
  tags?: string[] | null;
}

export async function shapeUnitResponse(
  db: SupabaseClient,
  row: RawUnitRow,
): Promise<UnitResponse> {
  const [{ data: entityRows }, { data: occurrenceRows }] = await Promise.all([
    db
      .from("unit_entities")
      .select("entity_id, mention_text, entities(canonical_name, type)")
      .eq("unit_id", row.id),
    db
      .from("unit_occurrences")
      .select(
        "scout_id, source_url, source_title, source_domain, discovered_from_url, extracted_at, scouts(id, name, type)",
      )
      .eq("unit_id", row.id)
      .order("extracted_at", { ascending: false }),
  ]);

  const resolvedEntities: UnitEntityRef[] = (entityRows ?? []).map((r) => {
    const ent =
      (r as { entities?: { canonical_name?: string; type?: string } | null })
        .entities;
    return {
      entity_id: r.entity_id ?? null,
      canonical_name: ent?.canonical_name ?? null,
      type: ent?.type ?? null,
      mention_text: (r as { mention_text: string }).mention_text,
    };
  });

  const entities: UnitEntityRef[] = resolvedEntities.length > 0
    ? resolvedEntities
    : (row.entities ?? []).map((mention) => ({
      entity_id: null,
      canonical_name: null,
      type: null,
      mention_text: mention,
    }));

  const sources: UnitSourceRef[] = [];
  const linkedScouts: LinkedScoutRef[] = [];
  const seenSources = new Set<string>();
  const seenScouts = new Set<string>();

  for (const raw of occurrenceRows ?? []) {
    const occurrence = raw as {
      scout_id?: string | null;
      source_url?: string | null;
      source_title?: string | null;
      source_domain?: string | null;
      discovered_from_url?: string | null;
      extracted_at?: string | null;
      scouts?:
        | { id?: string | null; name?: string | null; type?: string | null }
        | Array<{
          id?: string | null;
          name?: string | null;
          type?: string | null;
        }>
        | null;
    };
    const sourceKey = [
      occurrence.source_url ?? "",
      occurrence.source_title ?? "",
      occurrence.source_domain ?? "",
      occurrence.discovered_from_url ?? "",
    ].join("|");
    if (!seenSources.has(sourceKey)) {
      seenSources.add(sourceKey);
      sources.push({
        url: occurrence.source_url ?? null,
        title: occurrence.source_title ?? null,
        domain: occurrence.source_domain ?? null,
        discovered_from_url: occurrence.discovered_from_url ?? null,
        extracted_at: occurrence.extracted_at ?? null,
      });
    }

    const scout = Array.isArray(occurrence.scouts)
      ? occurrence.scouts[0]
      : occurrence.scouts;
    const scoutKey = scout?.id ?? occurrence.scout_id ?? "";
    if (scoutKey && !seenScouts.has(scoutKey)) {
      seenScouts.add(scoutKey);
      linkedScouts.push({
        id: scout?.id ?? occurrence.scout_id ?? null,
        name: scout?.name ?? null,
        type: scout?.type ?? null,
      });
    }
  }

  const primarySource = sources[0] ?? {
    url: row.source_url ?? null,
    title: row.source_title ?? null,
    domain: row.source_domain ?? null,
    discovered_from_url: row.discovered_from_url ?? null,
    extracted_at: row.last_seen_at ?? row.extracted_at ?? null,
  };
  const primaryScout = linkedScouts[0] ?? {
    id: row.scout_id ?? null,
    name: null,
    type: null,
  };

  return {
    id: row.id,
    statement: row.statement ?? null,
    context_excerpt: row.context_excerpt ?? null,
    unit_type: row.type ?? null,
    entities,
    location: row.location ??
      (row.country || row.state || row.city
        ? {
          country: row.country ?? null,
          state: row.state ?? null,
          city: row.city ?? null,
        }
        : null),
    country: row.country ?? null,
    state: row.state ?? null,
    city: row.city ?? null,
    topic: row.topic ?? null,
    scout_type: row.scout_type ?? null,
    occurred_at: row.occurred_at ?? null,
    extracted_at: row.last_seen_at ?? row.extracted_at ?? null,
    occurrence_count: row.occurrence_count ?? (sources.length || 1),
    source: {
      url: primarySource.url,
      title: primarySource.title,
      domain: primarySource.domain,
      discovered_from_url: primarySource.discovered_from_url,
    },
    sources,
    linked_scouts: linkedScouts,
    scout_id: primaryScout.id,
    scout_name: primaryScout.name,
    verification: {
      verified: Boolean(row.verified),
      verified_at: row.verified_at ?? null,
      verified_by: row.verified_by ?? null,
      notes: row.verification_notes ?? null,
    },
    usage: {
      used_in_article: Boolean(row.used_in_article),
      used_at: row.used_at ?? null,
      used_in_url: row.used_in_url ?? null,
    },
    deletion: {
      deleted: Boolean(row.deleted_at),
      deleted_at: row.deleted_at ?? null,
      deleted_by: row.deleted_by ?? null,
      reason: row.deletion_reason ?? null,
    },
    tags: row.tags ?? [],
  };
}

// ---------------------------------------------------------------------------
// Scout
// ---------------------------------------------------------------------------

export interface ScoutResponse {
  id: string;
  name: string;
  type: string;
  description: string | null;
  criteria: string | null;
  topic: string | null;
  url: string | null;
  location: Record<string, unknown> | null;
  source_mode: string | null;
  excluded_domains: string[];
  priority_sources: string[];
  platform: string | null;
  profile_handle: string | null;
  monitor_mode: string | null;
  track_removals: boolean;
  root_domain: string | null;
  tracked_urls: string[];
  project_id: string | null;
  regularity: string | null;
  schedule_cron: string | null;
  is_active: boolean;
  consecutive_failures: number;
  config: Record<string, unknown>;
  last_run: {
    started_at: string | null;
    status: string | null;
    stage: string | null;
    articles_count: number | null;
    merged_existing_count: number | null;
    sources_scraped: number | null;
    sources_failed: number | null;
    units_created_count: number | null;
    units_merged_count: number | null;
    error_class: string | null;
    notification_status: string | null;
    notification_reason: string | null;
    notification_provider_id: string | null;
    metadata: Record<string, unknown> | null;
  } | null;
  created_at: string | null;
}

interface RawScoutRow {
  id: string;
  name?: string | null;
  type?: string | null;
  description?: string | null;
  criteria?: string | null;
  topic?: string | null;
  url?: string | null;
  location?: Record<string, unknown> | null;
  source_mode?: string | null;
  excluded_domains?: string[] | null;
  priority_sources?: string[] | null;
  platform?: string | null;
  profile_handle?: string | null;
  monitor_mode?: string | null;
  track_removals?: boolean | null;
  root_domain?: string | null;
  tracked_urls?: string[] | null;
  project_id?: string | null;
  regularity?: string | null;
  schedule_cron?: string | null;
  is_active?: boolean | null;
  consecutive_failures?: number | null;
  created_at?: string | null;
  config?: Record<string, unknown> | null;
}

export async function shapeScoutResponse(
  db: SupabaseClient,
  row: RawScoutRow,
): Promise<ScoutResponse> {
  const { data: lastRun } = await db
    .from("scout_runs")
    .select(
      "started_at, status, stage, articles_count, merged_existing_count, sources_scraped, sources_failed, units_created_count, units_merged_count, error_class, notification_status, notification_reason, notification_provider_id, metadata",
    )
    .eq("scout_id", row.id)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    id: row.id,
    name: row.name ?? "",
    type: row.type ?? "",
    description: row.description ?? null,
    criteria: row.criteria ?? null,
    topic: row.topic ?? null,
    url: row.url ?? null,
    location: row.location ?? null,
    source_mode: row.source_mode ?? null,
    excluded_domains: row.excluded_domains ?? [],
    priority_sources: row.priority_sources ?? [],
    platform: row.platform ?? null,
    profile_handle: row.profile_handle ?? null,
    monitor_mode: row.monitor_mode ?? null,
    track_removals: Boolean(row.track_removals),
    root_domain: row.root_domain ?? null,
    tracked_urls: row.tracked_urls ?? [],
    project_id: row.project_id ?? null,
    regularity: row.regularity ?? null,
    schedule_cron: row.schedule_cron ?? null,
    is_active: row.is_active ?? true,
    consecutive_failures: row.consecutive_failures ?? 0,
    config: row.config ?? {},
    last_run: lastRun
      ? {
        started_at: (lastRun as { started_at: string | null }).started_at,
        status: (lastRun as { status: string | null }).status,
        stage: (lastRun as { stage: string | null }).stage ?? null,
        articles_count:
          (lastRun as { articles_count: number | null }).articles_count,
        merged_existing_count:
          (lastRun as { merged_existing_count: number | null })
            .merged_existing_count,
        sources_scraped: (lastRun as { sources_scraped: number | null })
          .sources_scraped ?? null,
        sources_failed: (lastRun as { sources_failed: number | null })
          .sources_failed ?? null,
        units_created_count: (lastRun as { units_created_count: number | null })
          .units_created_count ?? null,
        units_merged_count: (lastRun as { units_merged_count: number | null })
          .units_merged_count ?? null,
        error_class: (lastRun as { error_class: string | null }).error_class ??
          null,
        notification_status: (lastRun as { notification_status: string | null })
          .notification_status ?? null,
        notification_reason: (lastRun as { notification_reason: string | null })
          .notification_reason ?? null,
        notification_provider_id:
          (lastRun as { notification_provider_id: string | null })
            .notification_provider_id ?? null,
        metadata: (lastRun as { metadata?: Record<string, unknown> | null })
          .metadata ?? null,
      }
      : null,
    created_at: row.created_at ?? null,
  };
}
