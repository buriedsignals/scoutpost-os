/**
 * snapshots Edge Function — retrieval for Page Archive evidence snapshots
 * (PAGE-ARCHIVE-PRD U5, R7). Separate function mirroring `units` (Decision 6).
 *
 * Routes:
 *   GET  /snapshots?scout_id=<uuid>   list the caller's snapshots (paginated,
 *                                     newest first)
 *   POST /snapshots/:id/url           body {artifact} → short-lived signed
 *                                     download URL for one artifact
 *
 * Auth: requireUserOrApiKey for every route. Rows are read through the
 * caller-scoped client (RLS owner-select), so a cross-user id simply 404s. The
 * signed URL is minted with the service-role client AFTER that ownership read
 * — KTD3: SaaS retrieval goes through the EF, storage writes/signs are
 * service-role. Downloads are ALWAYS content-disposition attachment (hard
 * invariant): archived hostile HTML must never render on the storage origin.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import {
  AuthedUser,
  getCallerClient,
  requireUserOrApiKey,
} from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk, jsonPaginated } from "../_shared/responses.ts";
import { NotFoundError, ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { SNAPSHOT_BUCKET } from "../_shared/snapshot_store.ts";
import {
  ARTIFACT_KINDS,
  ARTIFACTS,
  artifactDownloadName,
  clampInt,
  isUuid,
  shapeSnapshot,
  SNAPSHOT_ROW_COLUMNS,
} from "./snapshot_view.ts";

const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes (R7)

const UrlSchema = z.object({
  artifact: z.enum(ARTIFACT_KINDS),
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
  const path = url.pathname.replace(/^.*\/snapshots/, "") || "/";
  const isRead = req.method === "GET" || req.method === "HEAD";
  // Match any single id segment; the id is validated as a UUID inside the
  // handler so a malformed id returns a clean 400, not a 405 (no route) or a
  // Postgres cast 500 (a loose regex letting a non-UUID reach `.eq()`).
  const urlMatch = path.match(/^\/([^/]+)\/url$/);

  try {
    if (path === "/" && isRead) {
      return await listSnapshots(req, user);
    }
    if (urlMatch && req.method === "POST") {
      return await signArtifactUrl(req, user, urlMatch[1]);
    }
    return jsonError("method not allowed", 405);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "snapshots",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

async function listSnapshots(req: Request, user: AuthedUser): Promise<Response> {
  const url = new URL(req.url);
  // parseInt yields NaN for non-numeric params; NaN survives Math.min/max and
  // would reach .range(NaN, NaN) → PostgREST 500. Fall back to the defaults.
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Infinity);
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  const scoutId = url.searchParams.get("scout_id");
  if (scoutId && !isUuid(scoutId)) {
    throw new ValidationError("scout_id must be a UUID");
  }

  const { db, needsExplicitScope } = getCallerClient(user);
  let q = db
    .from("page_snapshots")
    .select(SNAPSHOT_ROW_COLUMNS, { count: "exact" })
    .order("captured_at", { ascending: false });
  if (needsExplicitScope) q = q.eq("user_id", user.id);
  if (scoutId) q = q.eq("scout_id", scoutId);

  const { data, count, error } = await q.range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);

  const shaped = (data ?? []).map((row) =>
    shapeSnapshot(row as unknown as Record<string, unknown>)
  );
  return jsonPaginated(shaped, count ?? 0, offset, limit);
}

async function signArtifactUrl(
  req: Request,
  user: AuthedUser,
  id: string,
): Promise<Response> {
  // Validate the path id before it reaches a uuid column (a loose route match
  // lets non-UUIDs through → Postgres cast 500). Malformed id → clean 400.
  if (!isUuid(id)) throw new ValidationError("snapshot id must be a UUID");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = UrlSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const meta = ARTIFACTS[parsed.data.artifact];

  // Ownership read through the caller-scoped client: a snapshot the caller does
  // not own is invisible (RLS) → 404, which is also the cross-user probe answer.
  const { db, needsExplicitScope } = getCallerClient(user);
  // Static select of all path columns (a dynamic select string breaks
  // supabase-js's column-type parser); pick the requested one below.
  let q = db
    .from("page_snapshots")
    .select(
      "id, markdown_path, mhtml_path, screenshot_path, rawhtml_path, manifest_path, tsa_path",
    )
    .eq("id", id);
  if (needsExplicitScope) q = q.eq("user_id", user.id);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("snapshot");

  const objectPath = (data as unknown as Record<string, unknown>)[meta.column];
  if (typeof objectPath !== "string" || !objectPath) {
    // The row exists but doesn't hold this artifact (e.g. mhtml on a
    // markdown_only row, or tsr before the trust layer succeeded).
    throw new NotFoundError(`snapshot artifact '${parsed.data.artifact}'`);
  }

  // Sign with the service-role client. `download` forces a content-disposition
  // attachment (hard invariant) so a rawHTML/MHTML object never renders on the
  // storage origin — it downloads as a file.
  const svc = getServiceClient();
  const { data: signed, error: signErr } = await svc.storage
    .from(SNAPSHOT_BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS, {
      download: artifactDownloadName(id, parsed.data.artifact),
    });
  if (signErr || !signed?.signedUrl) {
    throw new Error(`could not sign artifact url: ${signErr?.message ?? "no url"}`);
  }

  logEvent({
    level: "info",
    fn: "snapshots",
    event: "artifact_signed",
    user_id: user.id,
    msg: `${id}:${parsed.data.artifact}`,
  });

  return jsonOk({
    url: signed.signedUrl,
    artifact: parsed.data.artifact,
    content_type: meta.contentType,
    expires_in: SIGNED_URL_TTL_SECONDS,
  });
}
