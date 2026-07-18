/**
 * reflections Edge Function — CRUD + semantic search for agent-written
 * synthesized summaries over units and entities.
 *
 * Routes:
 *   GET    /reflections          list caller's reflections (paginated)
 *   POST   /reflections          create a reflection (embeds content)
 *   GET    /reflections/:id      fetch a single reflection
 *   POST   /reflections/search   semantic search over reflections.embedding
 *   DELETE /reflections/:id      delete a reflection
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
import { EMBEDDING_MODEL_TAG, embedText } from "../_shared/embedding.ts";
import { logEvent } from "../_shared/log.ts";

const UuidArray = z.array(z.string().uuid()).optional();

const CreateSchema = z.object({
  scope_description: z.string().min(1),
  content: z.string().min(1),
  project_id: z.string().uuid().optional(),
  time_range_start: z.string().datetime().optional(),
  time_range_end: z.string().datetime().optional(),
  generated_by: z.string().min(1),
  source_unit_ids: UuidArray,
  source_entity_ids: UuidArray,
  metadata: z.record(z.unknown()).optional(),
});

const SearchSchema = z.object({
  query_text: z.string().min(1),
  project_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
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
  // Trim the "/reflections" prefix Kong leaves on the path.
  const path = url.pathname.replace(/^.*\/reflections/, "") || "/";
  const isRead = req.method === "GET" || req.method === "HEAD";

  try {
    if (path === "/" && isRead) {
      return await listReflections(req, user);
    }
    if (path === "/" && req.method === "POST") {
      return await createReflection(req, user);
    }
    if (path === "/search" && req.method === "POST") {
      return await searchReflections(req, user);
    }
    const idMatch = path.match(/^\/([0-9a-f-]{36})$/i);
    if (idMatch && isRead) {
      return await getReflection(user, idMatch[1]);
    }
    if (idMatch && req.method === "DELETE") {
      return await deleteReflection(user, idMatch[1]);
    }
    return jsonError("method not allowed", 405);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "reflections",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

async function listReflections(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
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

  const { db } = getCallerClient(user);
  let query = db
    .from("reflections")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (projectId) {
    query = query.eq("project_id", projectId);
  }

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);
  return jsonPaginated(data ?? [], count ?? 0, offset, limit);
}

async function createReflection(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const row: Record<string, unknown> = {
    user_id: user.id,
    scope_description: parsed.data.scope_description,
    content: parsed.data.content,
    generated_by: parsed.data.generated_by,
    project_id: parsed.data.project_id ?? null,
    time_range_start: parsed.data.time_range_start ?? null,
    time_range_end: parsed.data.time_range_end ?? null,
    source_unit_ids: parsed.data.source_unit_ids ?? [],
    source_entity_ids: parsed.data.source_entity_ids ?? [],
    metadata: parsed.data.metadata ?? {},
  };

  // Embed content if OpenRouter is configured. On failure or absence,
  // log a warning and insert without embedding so the reflection is still
  // stored (semantic search simply skips rows with NULL embedding).
  if (Deno.env.get("OPENROUTER_API_KEY")) {
    try {
      const embedding = await embedText(
        parsed.data.content,
        "RETRIEVAL_DOCUMENT",
      );
      row.embedding_v2 = embedding;
      row.embedding_model_v2 = EMBEDDING_MODEL_TAG;
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "reflections",
        event: "embed_failed",
        user_id: user.id,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    logEvent({
      level: "warn",
      fn: "reflections",
      event: "embed_skipped",
      user_id: user.id,
      msg: "OPENROUTER_API_KEY not set; inserting reflection without embedding",
    });
  }

  const { db } = getCallerClient(user);
  const { data, error } = await db
    .from("reflections")
    .insert(row)
    .select("*")
    .single();

  if (error) throw new Error(error.message);

  logEvent({
    level: "info",
    fn: "reflections",
    event: "created",
    user_id: user.id,
    reflection_id: data.id,
  });
  return jsonOk(data, 201);
}

async function getReflection(user: AuthedUser, id: string): Promise<Response> {
  const { db } = getCallerClient(user);
  const { data, error } = await db
    .from("reflections")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("reflection");
  return jsonOk(data);
}

async function searchReflections(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
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

  const embedding = await embedText(
    parsed.data.query_text,
    "RETRIEVAL_QUERY",
  );

  const svc = getServiceClient();
  const { data, error } = await svc.rpc("semantic_search_reflections_v2", {
    p_embedding: embedding,
    p_embedding_model: EMBEDDING_MODEL_TAG,
    p_user_id: user.id,
    p_project_id: parsed.data.project_id ?? null,
    p_limit: parsed.data.limit ?? 20,
  });

  if (error) throw new Error(error.message);
  return jsonOk({ items: data ?? [] });
}

async function deleteReflection(
  user: AuthedUser,
  id: string,
): Promise<Response> {
  const { db } = getCallerClient(user);
  const { error, count } = await db
    .from("reflections")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) throw new Error(error.message);
  if (!count) throw new NotFoundError("reflection");
  return new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
