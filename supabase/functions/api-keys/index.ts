/**
 * api-keys Edge Function — CRUD for the caller's agent API keys.
 *
 * Routes (all session-auth via requireUser):
 *   POST   /api-keys {name}     create — returns the raw key ONCE
 *   GET    /api-keys             list — never includes the raw key or hash
 *   DELETE /api-keys/:id         revoke (RLS-scoped)
 *
 * Raw keys are sha256-hashed before insert. The first 11 chars (`cj_xxxxxxxx`)
 * are stored as `key_prefix` so the UI can show users which key is which
 * without exposing the secret.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import {
  type AuthedUser,
  requireIdentity,
  requireIdentityOrApiKey,
  requireUser,
} from "../_shared/auth.ts";
import { getServiceClient, getUserClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { NotFoundError, ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
});

Deno.serve(async (req): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/api-keys/, "") || "/";
  if (path === "/self" && req.method === "DELETE") {
    try {
      return await revokeSelf(req);
    } catch (e) {
      return jsonFromError(e, req);
    }
  }

  let user: AuthedUser;
  try {
    user = req.method === "POST"
      ? await requireUser(req)
      : await requireIdentity(req);
  } catch (e) {
    return jsonFromError(e);
  }

  const idMatch = path.match(/^\/([0-9a-f-]{36})$/i);
  const isRead = req.method === "GET" || req.method === "HEAD";

  try {
    if (path === "/" && isRead) return await listKeys(user);
    if (path === "/" && req.method === "POST") {
      return await createKey(req, user);
    }
    if (idMatch && req.method === "DELETE") {
      return await revokeKey(user, idMatch[1]);
    }
    return jsonError("method not allowed", 405);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "api-keys",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

async function listKeys(user: AuthedUser): Promise<Response> {
  const db = getUserClient(user.token);
  const { data, error } = await db
    .from("api_keys")
    .select("id, key_prefix, name, created_at, last_used_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return jsonOk({
    keys: (data ?? []).map((row) => ({
      key_id: row.id,
      key_prefix: row.key_prefix,
      name: row.name,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    })),
    count: data?.length ?? 0,
  });
}

async function createKey(req: Request, user: AuthedUser): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(
        "; ",
      ),
    );
  }

  const svc = getServiceClient();
  const { data, error } = await svc.rpc("create_api_key_atomic", {
    p_user_id: user.id,
    p_name: parsed.data.name,
    p_source: "manual",
  });
  if (error) throw new Error(error.message);
  const created = Array.isArray(data) ? data[0] : data;
  if (created?.result === "key_limit_reached") {
    return jsonError(
      "A maximum of five API keys is allowed. Revoke one before creating another.",
      409,
      "api_key_limit_reached",
      req,
    );
  }
  if (!created?.api_key || !created?.key_id) {
    throw new Error("API key creation failed");
  }

  logEvent({
    level: "info",
    fn: "api-keys",
    event: "created",
    user_id: user.id,
    key_id: created.key_id,
  });

  return jsonOk(
    {
      key: created.api_key,
      key_id: created.key_id,
      key_prefix: created.key_prefix,
      name: created.key_name,
      created_at: created.created_at,
    },
    201,
  );
}

async function revokeSelf(req: Request): Promise<Response> {
  const user = await requireIdentityOrApiKey(req);
  if (user.authMethod !== "api_key" || !user.apiKeyId) {
    return jsonError(
      "API-key authentication required",
      401,
      "api_key_required",
      req,
    );
  }

  const forwardedApiKey = req.headers.get("x-cojo-api-key") ??
    req.headers.get("X-Cojo-Api-Key");
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const rawKey = forwardedApiKey?.trim() || bearer?.trim();
  if (!rawKey?.startsWith("cj_")) {
    return jsonError(
      "API-key authentication required",
      401,
      "api_key_required",
      req,
    );
  }

  const svc = getServiceClient();
  const { data, error } = await svc.rpc("revoke_current_api_key", {
    p_key: rawKey,
  });
  if (error) throw new Error(error.message);
  if (data !== user.apiKeyId) throw new NotFoundError("api_key");

  logEvent({
    level: "info",
    fn: "api-keys",
    event: "self_revoked",
    user_id: user.id,
    key_id: user.apiKeyId,
  });
  return new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

async function revokeKey(user: AuthedUser, id: string): Promise<Response> {
  const db = getUserClient(user.token);
  const { error, count } = await db
    .from("api_keys")
    .delete({ count: "exact" })
    .eq("id", id);
  if (error) throw new Error(error.message);
  if (!count) throw new NotFoundError("api_key");

  logEvent({
    level: "info",
    fn: "api-keys",
    event: "revoked",
    user_id: user.id,
    key_id: id,
  });

  return new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
