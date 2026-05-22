/**
 * runs Edge Function — read-only scout run diagnostics for CLI/agent use.
 *
 * Routes:
 *   GET /runs/:id  -> scout_runs row + scout_run_events + unit IDs observed
 *
 * Auth: Supabase JWT or cj_ API key. The caller can only read runs owned by
 * their resolved user_id through the caller client and explicit filters.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import {
  type AuthedUser,
  getCallerClient,
  requireUserOrApiKey,
} from "../_shared/auth.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { NotFoundError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";

const RunId = z.string().uuid();

Deno.serve(async (req): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  let user: AuthedUser;
  try {
    user = await requireUserOrApiKey(req);
  } catch (e) {
    return jsonFromError(e);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return jsonError("method not allowed", 405);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/runs/, "") || "/";
  const id = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const parsed = RunId.safeParse(id);
  if (!parsed.success) return jsonError("invalid run id", 400);

  try {
    const { db } = getCallerClient(user);
    const { data: run, error: runErr } = await db
      .from("scout_runs")
      .select("*")
      .eq("id", parsed.data)
      .eq("user_id", user.id)
      .maybeSingle();
    if (runErr) throw new Error(runErr.message);
    if (!run) throw new NotFoundError("run");

    const [{ data: events, error: eventsErr }, { data: occurrences }] =
      await Promise.all([
        db
          .from("scout_run_events")
          .select("*")
          .eq("scout_run_id", parsed.data)
          .eq("user_id", user.id)
          .order("created_at", { ascending: true }),
        db
          .from("unit_occurrences")
          .select("unit_id")
          .eq("scout_run_id", parsed.data)
          .eq("user_id", user.id),
      ]);
    if (eventsErr) throw new Error(eventsErr.message);

    const mergedUnitIds = [
      ...new Set(
        (occurrences ?? [])
          .map((row) => (row as { unit_id?: string | null }).unit_id)
          .filter((unitId): unitId is string => Boolean(unitId)),
      ),
    ];

    return jsonOk({
      run,
      events: events ?? [],
      merged_unit_ids: mergedUnitIds,
    });
  } catch (e) {
    logEvent({
      level: "error",
      fn: "runs",
      event: "show_failed",
      user_id: user.id,
      run_id: parsed.data,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});
