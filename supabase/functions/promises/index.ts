/** Owner-scoped Civic promise lifecycle reads and transitions. */
import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireUser } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { ValidationError } from "../_shared/errors.ts";

const EvidenceUrlSchema = z.string().url().max(2000).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}, "evidence_url must be a credential-free HTTP(S) URL");

const TransitionSchema = z.object({
  status: z.enum(["in_progress", "fulfilled", "broken"]),
  expected_updated_at: z.string().datetime(),
  reason: z.string().max(2000).optional(),
  evidence_url: EvidenceUrlSchema.optional(),
  idempotency_key: z.string().min(8).max(200).optional(),
});

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  let user;
  try {
    user = await requireUser(req);
  } catch (error) {
    return jsonFromError(error);
  }
  const url = new URL(req.url);
  const match = url.pathname.match(
    /\/promises\/([0-9a-f-]{36})(?:\/status)?$/i,
  );
  if (!match) return jsonError("not found", 404);
  const promiseId = match[1];
  try {
    if (req.method === "GET") return await getPromise(user.id, promiseId);
    if (req.method === "PATCH" && url.pathname.endsWith("/status")) {
      return await transition(req, user.id, promiseId);
    }
    return jsonError("method not allowed", 405);
  } catch (error) {
    return jsonFromError(error);
  }
});

async function getPromise(
  userId: string,
  promiseId: string,
): Promise<Response> {
  const svc = getServiceClient();
  const { data: promise, error } = await svc.from("promises").select("*").eq(
    "id",
    promiseId,
  ).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!promise) return jsonError("not found", 404);
  const { data: history, error: historyError } = await svc.from(
    "promise_status_history",
  )
    .select("id,from_status,to_status,reason,evidence_url,created_at").eq(
      "promise_id",
      promiseId,
    ).eq("user_id", userId).order("created_at", { ascending: false });
  if (historyError) throw new Error(historyError.message);
  const { data: revisions, error: revisionsError } = await svc.from(
    "promise_revisions",
  )
    .select(
      "id,due_date,date_confidence,due_date_text,source_url,context,previous_revision_id,amendment_reason,created_at",
    ).eq("promise_id", promiseId).eq("user_id", userId).order("created_at", {
      ascending: false,
    });
  if (revisionsError) throw new Error(revisionsError.message);
  return jsonOk({
    api_version: "1",
    promise,
    history: history ?? [],
    revisions: revisions ?? [],
  });
}

async function transition(
  req: Request,
  userId: string,
  promiseId: string,
): Promise<Response> {
  const parsed = TransitionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  const input = parsed.data;
  const { data, error } = await getServiceClient().rpc(
    "transition_civic_promise_status",
    {
      p_promise_id: promiseId,
      p_user_id: userId,
      p_target_status: input.status,
      p_expected_updated_at: input.expected_updated_at,
      p_reason: input.reason ?? null,
      p_evidence_url: input.evidence_url ?? null,
      p_idempotency_key: input.idempotency_key ?? null,
    },
  );
  if (error) {
    if (error.message.includes("not found")) return jsonError("not found", 404);
    if (error.message.includes("version conflict")) {
      return jsonError("promise version conflict", 409);
    }
    if (error.message.includes("invalid promise status transition")) {
      return jsonError("invalid promise status transition", 409);
    }
    throw new Error(error.message);
  }
  return jsonOk({ api_version: "1", ...(data as Record<string, unknown>) });
}
