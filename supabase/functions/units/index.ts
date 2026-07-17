/**
 * units Edge Function — information units (atomic facts extracted from scout
 * results) with verification, usage tracking, soft delete, and scoped search.
 *
 * Routes:
 *   GET    /units              list caller's units (filter + paginate)
 *   GET    /units/locations    legacy feed compatibility route
 *   GET    /units/topics       legacy feed compatibility route
 *   GET    /units/all          legacy feed compatibility route
 *   GET    /units/unused       legacy feed compatibility route
 *   GET    /units/by-topic     legacy feed compatibility route
 *   GET    /units/search       legacy feed compatibility route
 *   PATCH  /units/mark-used    legacy feed compatibility route
 *   POST   /units/search       semantic, keyword, or hybrid search over caller's units
 *   GET    /units/:id          fetch a single unit
 *   GET    /units/:id/evidence owner-only exact source expressions
 *   PATCH  /units/:id/evidence/:linkId  review an evidence relation
 *   PATCH  /units/:id          update verification/usage fields
 *   DELETE /units/:id          soft delete a unit
 *
 * Auth: requireUser for every route. User-scoped client for reads/updates;
 * service-role client is used only to invoke the SECURITY DEFINER
 * semantic_search_units RPC (we pass user.id explicitly so RLS would over-
 * filter the call).
 *
 * Column note: the schema column is `type`, exposed as `unit_type` via
 * shapeUnitResponse.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import {
  AuthedUser,
  getCallerClient,
  requireUserOrApiKey,
} from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import {
  jsonError,
  jsonFromError,
  jsonOk,
  jsonPaginated,
} from "../_shared/responses.ts";
import { NotFoundError, ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { shapeUnitResponse } from "../_shared/db.ts";
import { embedText } from "../_shared/embedding.ts";
import type { SupabaseClient } from "../_shared/supabase.ts";
import {
  buildSearchMatchInfo,
  filterPreciseSearchResults,
} from "./search_utils.ts";

const SearchSchema = z.object({
  query_text: z.string().min(1).max(4000),
  mode: z.enum(["semantic", "keyword", "hybrid"]).optional(),
  project_id: z.string().uuid().optional(),
  scout_id: z.string().uuid().optional(),
  verified: z.boolean().optional(),
  used_in_article: z.boolean().optional(),
  include_deleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const MarkUsedSchema = z.object({
  unit_keys: z.array(
    z.object({
      pk: z.string().min(1),
      sk: z.string().min(1),
    }),
  ).min(1).max(200),
});

const UpdateSchema = z.object({
  verified: z.boolean().optional(),
  verification_notes: z.string().max(4000).nullable().optional(),
  verified_by: z.string().max(200).nullable().optional(),
  used_in_article: z.boolean().optional(),
  used_at: z.string().datetime().nullable().optional(),
  used_in_url: z.string().url().nullable().optional(),
  deletion_reason: z.string().max(4000).nullable().optional(),
});

const ReviewEvidenceSchema = z.object({
  review_status: z.enum(["accepted", "rejected"]),
  review_notes: z.string().max(4000).nullable().optional(),
});

Deno.serve(async (req): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  let user: AuthedUser;
  try {
    user = await requireUserOrApiKey(req);
  } catch (e) {
    return jsonFromError(e);
  }

  const url = new URL(req.url);
  // Trim the "/units" prefix Kong leaves on the path. "/units" -> "",
  // "/units/<id>" -> "/<id>", "/units/search" -> "/search".
  const path = url.pathname.replace(/^.*\/units/, "") || "/";
  const idMatch = path.match(/^\/([0-9a-f-]{36})$/i);
  const evidenceMatch = path.match(/^\/([0-9a-f-]{36})\/evidence$/i);
  const reviewEvidenceMatch = path.match(
    /^\/([0-9a-f-]{36})\/evidence\/([0-9a-f-]{36})$/i,
  );
  const isRead = req.method === "GET" || req.method === "HEAD";

  try {
    if (path === "/locations" && isRead) {
      return await listLegacyLocations(req, user);
    }
    if (path === "/topics" && isRead) {
      return await listLegacyTopics(req, user);
    }
    if (path === "/all" && isRead) {
      return await listLegacyUnits(req, user, { unusedOnly: true });
    }
    if (path === "/unused" && isRead) {
      return await listLegacyUnits(req, user, {
        unusedOnly: true,
        requireLocation: true,
      });
    }
    if (path === "/by-topic" && isRead) {
      return await listLegacyUnits(req, user, { topicOnly: true });
    }
    if (path === "/search" && isRead) {
      return await searchUnitsLegacy(req, user);
    }
    if (path === "/mark-used" && req.method === "PATCH") {
      return await markUnitsUsed(req, user);
    }
    if (path === "/" && isRead) {
      return await listUnits(req, user);
    }
    if (path === "/search" && req.method === "POST") {
      return await searchUnits(req, user);
    }
    if (evidenceMatch && isRead) {
      return await getUnitEvidence(user, evidenceMatch[1]);
    }
    if (reviewEvidenceMatch && req.method === "PATCH") {
      return await reviewUnitEvidence(
        req,
        user,
        reviewEvidenceMatch[1],
        reviewEvidenceMatch[2],
      );
    }
    if (idMatch && isRead) {
      return await getUnit(user, idMatch[1]);
    }
    if (idMatch && req.method === "PATCH") {
      return await updateUnit(req, user, idMatch[1]);
    }
    if (idMatch && req.method === "DELETE") {
      return await deleteUnit(user, idMatch[1]);
    }
    return jsonError("method not allowed", 405);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "units",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

function parseBool(v: string | null): boolean | null {
  if (v === null) return null;
  const s = v.toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return null;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function locationKeyFromParts(
  country: string | null,
  state: string | null,
  city: string | null,
): string | null {
  if (!country && !state && !city) return null;
  return [country ?? "_", state ?? "_", city ?? "_"].join("#");
}

function parseLegacyLocationParams(url: URL): {
  country: string | null;
  state: string | null;
  city: string | null;
} {
  return {
    country: pickString(url.searchParams.get("country")),
    state: pickString(url.searchParams.get("state")),
    city: pickString(url.searchParams.get("city")),
  };
}

function unitMatchesLocation(
  unit: Record<string, unknown>,
  expected: {
    country: string | null;
    state: string | null;
    city: string | null;
  },
): boolean {
  if (!expected.country && !expected.state && !expected.city) return true;

  const location = asRecord(unit.location);
  const country = pickString(
    unit.country,
    location?.country,
    location?.countryCode,
  );
  const state = pickString(unit.state, location?.state, location?.region);
  const city = pickString(unit.city, location?.city, location?.displayName);

  if (expected.country && country !== expected.country) return false;
  if (expected.state && state !== expected.state) return false;
  if (expected.city && city !== expected.city) return false;
  return true;
}

function shapeLegacyUnit(
  row: Record<string, unknown>,
  userId: string,
): Record<string, unknown> {
  const source = asRecord(row.source);
  const usage = asRecord(row.usage);
  const location = asRecord(row.location);
  const unitId = pickString(row.unit_id, row.id) ?? "";
  const createdAt = pickString(row.created_at, row.extracted_at) ?? "";

  const entitiesRaw = Array.isArray(row.entities) ? row.entities : [];
  const entities = entitiesRaw
    .map((entity) => {
      if (typeof entity === "string") return entity;
      const record = asRecord(entity);
      return pickString(record?.canonical_name, record?.mention_text);
    })
    .filter((value): value is string => Boolean(value));

  const country = pickString(
    row.country,
    location?.country,
    location?.countryCode,
  );
  const state = pickString(row.state, location?.state, location?.region);
  const city = pickString(row.city, location?.city, location?.displayName);

  return {
    unit_id: unitId,
    pk: pickString(row.pk) ?? `USER#${userId}#`,
    sk: pickString(row.sk) ?? `UNIT#${createdAt}#${unitId}`,
    statement: pickString(row.statement) ?? "",
    unit_type: pickString(row.unit_type, row.type) ?? "fact",
    entities,
    source_url: pickString(row.source_url, source?.url) ?? "",
    source_domain: pickString(row.source_domain, source?.domain),
    source_title: pickString(row.source_title, source?.title) ?? "",
    scout_type: pickString(row.scout_type) ?? "web",
    scout_id: pickString(row.scout_id) ?? "",
    topic: pickString(row.topic),
    created_at: createdAt,
    used_in_article: Boolean(usage?.used_in_article ?? row.used_in_article),
    date: pickString(row.date, row.occurred_at, row.event_date),
    country,
    state,
    city,
  };
}

async function fetchLegacyUnitRows(
  user: AuthedUser,
  opts: {
    unusedOnly?: boolean;
    topic?: string | null;
    location?: {
      country: string | null;
      state: string | null;
      city: string | null;
    };
    limit?: number;
  } = {},
): Promise<Record<string, unknown>[]> {
  const { db, needsExplicitScope } = getCallerClient(user);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  let q = db
    .from("information_units")
    .select("*")
    .order("extracted_at", { ascending: false })
    .limit(limit);

  if (needsExplicitScope) q = q.eq("user_id", user.id);
  q = q.is("deleted_at", null);
  if (opts.unusedOnly) q = q.eq("used_in_article", false);
  if (opts.topic) q = q.eq("topic", opts.topic);
  if (opts.location?.country) q = q.eq("country", opts.location.country);
  if (opts.location?.state) q = q.eq("state", opts.location.state);
  if (opts.location?.city) q = q.eq("city", opts.location.city);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Record<string, unknown>[];
}

async function listLegacyLocations(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
  const rows = await fetchLegacyUnitRows(user, { limit: 500 });
  const keys = new Set<string>();
  for (const row of rows) {
    const key = locationKeyFromParts(
      pickString(row.country),
      pickString(row.state),
      pickString(row.city),
    );
    if (key) keys.add(key);
  }
  return jsonOk({ locations: Array.from(keys).sort() }, 200, req);
}

async function listLegacyTopics(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
  const rows = await fetchLegacyUnitRows(user, { limit: 500 });
  const topics = new Set<string>();
  for (const row of rows) {
    const topic = pickString(row.topic);
    if (topic) topics.add(topic);
  }
  return jsonOk({ topics: Array.from(topics).sort() }, 200, req);
}

async function listLegacyUnits(
  req: Request,
  user: AuthedUser,
  opts: {
    unusedOnly?: boolean;
    requireLocation?: boolean;
    topicOnly?: boolean;
  } = {},
): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)),
  );
  const topic = opts.topicOnly
    ? pickString(url.searchParams.get("topic"))
    : null;
  const location = parseLegacyLocationParams(url);

  if (opts.requireLocation && !location.country) {
    throw new ValidationError("country is required");
  }
  if (opts.topicOnly && !topic) {
    throw new ValidationError("topic is required");
  }

  const rows = await fetchLegacyUnitRows(user, {
    unusedOnly: opts.unusedOnly,
    topic,
    location: opts.requireLocation
      ? location
      : location.country
      ? location
      : undefined,
    limit,
  });
  const units = rows.map((row) => shapeLegacyUnit(row, user.id));
  return jsonOk({ units, count: units.length }, 200, req);
}

async function searchUnitsLegacy(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
  const url = new URL(req.url);
  const query = pickString(url.searchParams.get("query"));
  if (!query || query.length < 2) {
    throw new ValidationError("query must be at least 2 characters");
  }

  const limit = Math.min(
    50,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10)),
  );
  const topic = pickString(url.searchParams.get("topic"));
  const location = parseLegacyLocationParams(url);

  const items = await runUnitSearch(user, {
    query_text: query,
    mode: "hybrid",
    limit: Math.min(100, Math.max(limit * 4, limit)),
  });

  const filtered = items
    .filter((item) => !topic || pickString(item.topic) === topic)
    .filter((item) => unitMatchesLocation(item, location))
    .slice(0, limit)
    .map((item) => ({
      ...shapeLegacyUnit(item, user.id),
      similarity_score: typeof item.similarity === "number"
        ? item.similarity
        : typeof item.similarity_score === "number"
        ? item.similarity_score
        : 0,
    }));

  return jsonOk({ units: filtered, count: filtered.length, query }, 200, req);
}

async function markUnitsUsed(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = MarkUsedSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const ids = parsed.data.unit_keys
    .map((key) => {
      const parts = key.sk.split("#");
      return parts[parts.length - 1];
    })
    .filter((value) => /^[0-9a-f-]{36}$/i.test(value));

  if (ids.length === 0) {
    throw new ValidationError("no valid unit ids provided");
  }

  const { db, needsExplicitScope } = getCallerClient(user);
  let q = db
    .from("information_units")
    .update({
      used_in_article: true,
      used_at: new Date().toISOString(),
    })
    .in("id", ids);
  if (needsExplicitScope) q = q.eq("user_id", user.id);
  const { data, error } = await q.select("id");
  if (error) throw new Error(error.message);

  return jsonOk(
    {
      marked_count: (data ?? []).length,
      total_requested: parsed.data.unit_keys.length,
    },
    200,
    req,
  );
}

async function listUnits(req: Request, user: AuthedUser): Promise<Response> {
  const url = new URL(req.url);
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10),
  );
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)),
  );

  const projectId = url.searchParams.get("project_id");
  const scoutId = url.searchParams.get("scout_id");
  const verified = parseBool(url.searchParams.get("verified"));
  const used = parseBool(
    url.searchParams.get("used_in_article") ?? url.searchParams.get("used"),
  );
  const includeDeleted = parseBool(url.searchParams.get("include_deleted")) ===
    true;
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const { db, needsExplicitScope } = getCallerClient(user);
  const scopedIds = await resolveScopedUnitIds(db, user.id, projectId, scoutId);
  if (scopedIds && scopedIds.length === 0) {
    return jsonPaginated([], 0, offset, limit);
  }

  let q = db
    .from("information_units")
    .select("*", { count: "exact" })
    .order("last_seen_at", { ascending: false, nullsFirst: false });

  if (needsExplicitScope) q = q.eq("user_id", user.id);
  if (scopedIds) q = q.in("id", scopedIds);
  if (!includeDeleted) q = q.is("deleted_at", null);
  if (verified !== null) q = q.eq("verified", verified);
  if (used !== null) q = q.eq("used_in_article", used);
  if (from) q = q.gte("last_seen_at", from);
  if (to) q = q.lte("last_seen_at", to);

  const { data, count, error } = await q.range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);

  const shaped = await Promise.all(
    (data ?? []).map((row) => shapeUnitResponse(db, row)),
  );
  return jsonPaginated(shaped, count ?? 0, offset, limit);
}

async function searchUnits(req: Request, user: AuthedUser): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = SearchSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const items = await runUnitSearch(user, parsed.data);
  return jsonOk({ items }, 200, req);
}

async function runUnitSearch(
  user: AuthedUser,
  params: z.infer<typeof SearchSchema>,
): Promise<Record<string, unknown>[]> {
  const {
    query_text,
    project_id,
    scout_id,
    limit,
    verified,
    used_in_article,
    include_deleted,
    mode,
  } = params;
  const effectiveLimit = limit ?? 20;
  const searchMode = mode ?? "hybrid";

  // Short-circuit: if the user has no units at all, skip the embedding call.
  const { db: userDb, needsExplicitScope } = getCallerClient(user);
  const scopedIds = await resolveScopedUnitIds(
    userDb,
    user.id,
    project_id ?? null,
    scout_id ?? null,
  );
  if (scopedIds && scopedIds.length === 0) {
    return [];
  }
  let countQ = userDb
    .from("information_units")
    .select("id", { count: "exact", head: true });
  if (needsExplicitScope) countQ = countQ.eq("user_id", user.id);
  if (scopedIds) countQ = countQ.in("id", scopedIds);
  if (!include_deleted) countQ = countQ.is("deleted_at", null);
  if (verified !== undefined) countQ = countQ.eq("verified", verified);
  if (used_in_article !== undefined) {
    countQ = countQ.eq("used_in_article", used_in_article);
  }
  const { count: unitCount, error: countErr } = await countQ;
  if (countErr) throw new Error(countErr.message);
  if (!unitCount) {
    return [];
  }

  // The RPC supports hybrid search by combining FTS + vectors. We selectively
  // disable one branch by passing p_query_text or p_embedding null.
  let embedding: number[] | null = null;
  if (searchMode !== "keyword") {
    try {
      embedding = await embedText(query_text, "RETRIEVAL_QUERY");
    } catch (e) {
      if (searchMode === "semantic") throw e;
      logEvent({
        level: "warn",
        fn: "units",
        event: "embed_failed_fts_fallback",
        user_id: user.id,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const svc = getServiceClient();
  const { data, error } = await svc.rpc("semantic_search_units_v2", {
    p_embedding: searchMode === "keyword" ? null : embedding,
    p_user_id: user.id,
    p_project_id: project_id ?? null,
    p_scout_id: scout_id ?? null,
    p_limit: Math.min(effectiveLimit * 4, 100),
    p_query_text: searchMode === "semantic" ? null : query_text,
  });
  if (error) throw new Error(error.message);

  // The RPC returns a minimal projection (id, statement, context_excerpt,
  // unit_type, occurred_at, extracted_at, project_id, similarity). We rehydrate
  // each hit via shapeUnitResponse so agents get the full envelope, and we
  // preserve the similarity score.
  const items = await Promise.all(
    (data ?? []).map(async (row: Record<string, unknown>) => {
      let fetchQ = userDb
        .from("information_units")
        .select("*")
        .eq("id", row.id as string);
      if (needsExplicitScope) fetchQ = fetchQ.eq("user_id", user.id);
      const { data: full, error: fetchErr } = await fetchQ.maybeSingle();
      if (fetchErr) throw new Error(fetchErr.message);
      if (!full) {
        // Row filtered by RLS (shouldn't happen since the RPC already scoped
        // to user_id) — fall back to the projection + similarity.
        const semanticSimilarity = typeof row.semantic_similarity === "number"
          ? row.semantic_similarity
          : null;
        return {
          ...row,
          search_match: buildSearchMatchInfo(
            query_text,
            row,
            semanticSimilarity,
          ),
        };
      }
      if (!include_deleted && full.deleted_at) return null;
      if (verified !== undefined && full.verified !== verified) return null;
      if (
        used_in_article !== undefined &&
        full.used_in_article !== used_in_article
      ) {
        return null;
      }
      const shaped = await shapeUnitResponse(userDb, full);
      const semanticSimilarity = typeof row.semantic_similarity === "number"
        ? row.semantic_similarity
        : null;
      return {
        ...shaped,
        similarity: row.similarity ?? null,
        search_rank: row.similarity ?? null,
        search_match: buildSearchMatchInfo(
          query_text,
          shaped as unknown as Record<string, unknown>,
          semanticSimilarity,
        ),
      };
    }),
  );
  const hydrated = items.filter((item): item is Record<string, unknown> =>
    item !== null
  );
  const filtered = searchMode === "semantic"
    ? hydrated
    : filterPreciseSearchResults(query_text, hydrated);
  return filtered.slice(0, effectiveLimit);
}

async function getUnit(user: AuthedUser, id: string): Promise<Response> {
  const { db, needsExplicitScope } = getCallerClient(user);
  let q = db.from("information_units").select("*").eq("id", id);
  if (needsExplicitScope) q = q.eq("user_id", user.id);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("unit");
  return jsonOk(await shapeUnitResponse(db, data));
}

/** Evidence is deliberately owner-only in V1, even where a team can read a unit. */
async function getUnitEvidence(
  user: AuthedUser,
  id: string,
): Promise<Response> {
  const { db } = getCallerClient(user);
  const { data: unit, error: unitError } = await db
    .from("information_units")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (unitError) throw new Error(unitError.message);
  if (!unit) throw new NotFoundError("unit");

  const { data: links, error: linksError } = await db
    .from("source_expression_links")
    .select(
      "id, relation_kind, link_method, review_status, reviewed_at, review_notes, created_at, source_expressions(id, exact_text, start_byte, end_byte, start_line, end_line, locator_version, capture_payload_sha256, passage_sha256, language, attribution, is_direct_quote, lifecycle_status, created_at)",
    )
    .eq("unit_id", id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (linksError) throw new Error(linksError.message);

  const expressions = (links ?? []).map((link) => {
    const row = link as Record<string, unknown>;
    return {
      link_id: row.id,
      relation_kind: row.relation_kind,
      link_method: row.link_method,
      review_status: row.review_status,
      reviewed_at: row.reviewed_at,
      review_notes: row.review_notes,
      expression: row.source_expressions,
    };
  });
  const active = expressions.filter((item) => {
    const expression = asRecord(item.expression);
    return expression?.lifecycle_status === "active";
  });
  return jsonOk({
    unit_id: id,
    evidence_status: {
      active_expression_count: active.length,
      accepted_support_count: active.filter((item) =>
        item.relation_kind === "supports" && item.review_status === "accepted"
      ).length,
      has_rejected_evidence: expressions.some((item) =>
        item.review_status === "rejected" ||
        asRecord(item.expression)?.lifecycle_status === "rejected"
      ),
    },
    expressions,
  });
}

async function reviewUnitEvidence(
  req: Request,
  user: AuthedUser,
  unitId: string,
  linkId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = ReviewEvidenceSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  const { db } = getCallerClient(user);
  const { data: link, error: linkError } = await db
    .from("source_expression_links")
    .select("id")
    .eq("id", linkId)
    .eq("unit_id", unitId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (linkError) throw new Error(linkError.message);
  if (!link) throw new NotFoundError("source expression link");
  const { error } = await db.rpc("review_source_expression_link", {
    p_user_id: user.id,
    p_link_id: linkId,
    p_review_status: parsed.data.review_status,
    p_review_notes: parsed.data.review_notes ?? null,
  });
  if (error) throw new Error(error.message);
  return jsonOk({ id: linkId, review_status: parsed.data.review_status });
}

async function resolveScopedUnitIds(
  db: SupabaseClient,
  userId: string,
  projectId: string | null,
  scoutId: string | null,
): Promise<string[] | null> {
  if (!projectId && !scoutId) return null;

  let q = db
    .from("unit_occurrences")
    .select("unit_id, extracted_at")
    .eq("user_id", userId)
    .order("extracted_at", { ascending: false });
  if (projectId) q = q.eq("project_id", projectId);
  if (scoutId) q = q.eq("scout_id", scoutId);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of data ?? []) {
    const unitId = (row as { unit_id?: string | null }).unit_id;
    if (!unitId || seen.has(unitId)) continue;
    seen.add(unitId);
    ids.push(unitId);
  }
  return ids;
}

async function updateUnit(
  req: Request,
  user: AuthedUser,
  id: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    throw new ValidationError("no updatable fields provided");
  }

  // Stamp verified_at automatically when verified flips true and no client-
  // supplied timestamp is needed. (verified_at isn't on the allowed input
  // list, so we derive it here.)
  const patch: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.verified === true) {
    patch.verified_at = new Date().toISOString();
  } else if (parsed.data.verified === false) {
    patch.verified_at = null;
  }
  if (parsed.data.used_in_article === true && !parsed.data.used_at) {
    patch.used_at = new Date().toISOString();
  } else if (parsed.data.used_in_article === false) {
    patch.used_at = null;
    patch.used_in_url = null;
  }

  const { db, needsExplicitScope } = getCallerClient(user);
  let updQ = db.from("information_units").update(patch).eq("id", id);
  if (needsExplicitScope) updQ = updQ.eq("user_id", user.id);
  const { data, error } = await updQ.select("*").maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("unit");

  logEvent({
    level: "info",
    fn: "units",
    event: "updated",
    user_id: user.id,
    unit_id: id,
  });
  return jsonOk(await shapeUnitResponse(db, data));
}

async function deleteUnit(user: AuthedUser, id: string): Promise<Response> {
  const { db, needsExplicitScope } = getCallerClient(user);
  let q = db
    .from("information_units")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: user.id,
    })
    .eq("id", id)
    .is("deleted_at", null);
  if (needsExplicitScope) q = q.eq("user_id", user.id);
  const { error, data } = await q.select("id");
  if (error) throw new Error(error.message);
  if (!(data?.length)) throw new NotFoundError("unit");

  logEvent({
    level: "info",
    fn: "units",
    event: "deleted",
    user_id: user.id,
    unit_id: id,
  });
  return new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
