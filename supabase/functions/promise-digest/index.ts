/**
 * promise-digest Edge Function — daily civic-promise email digest.
 *
 * Runs once per day (08:00 UTC via pg_cron, see 00033_promise_digest_cron.sql).
 * Scans public.promises for rows where due_date is today and status is 'new',
 * groups them by user_id, sends a single digest email per user via
 * sendCivicPromiseDigest, then flips each notified row's status to
 * 'notified' so a re-fire of the job (manual or failover) doesn't re-email.
 *
 * Ports the behaviour of the legacy aws/lambdas/promise-checker-lambda
 * (EventBridge daily, FastAPI /civic/notify-promises → mark_promises_notified).
 *
 * Auth: shared service auth (invoked by pg_cron or operator curl).
 *
 * Route:
 *   POST /promise-digest
 *     body: optional `{ date?: "YYYY-MM-DD", dry_run?: boolean }`
 *     -> 200 { date, users_notified, promises_considered, promises_notified }
 */

import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { logEvent } from "../_shared/log.ts";
import {
  PromiseDigestItem,
  sendCivicPromiseDigest,
} from "../_shared/notifications.ts";

interface PromiseRow {
  id: string;
  user_id: string;
  scout_id: string | null;
  promise_text: string;
  source_url: string | null;
  source_title: string | null;
  due_date: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  try {
    requireServiceKey(req);
  } catch (e) {
    return jsonFromError(e);
  }

  let body: { date?: string; dry_run?: boolean } = {};
  try {
    if (req.headers.get("content-length") !== "0") {
      body = await req.json() as typeof body;
    }
  } catch {
    // Empty or bad body — treat as defaults.
  }

  const today =
    typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : new Date().toISOString().slice(0, 10);
  const dryRun = body.dry_run === true;

  const svc = getServiceClient();

  const { data, error } = await svc
    .from("promises")
    .select(
      "id, user_id, scout_id, promise_text, source_url, source_title, due_date",
    )
    .eq("due_date", today)
    .eq("status", "new");
  if (error) {
    logEvent({
      level: "error",
      fn: "promise-digest",
      event: "query_failed",
      msg: error.message,
    });
    return jsonError(`query failed: ${error.message}`, 500);
  }

  const promises = (data ?? []) as PromiseRow[];
  if (promises.length === 0) {
    logEvent({
      level: "info",
      fn: "promise-digest",
      event: "nothing_due",
      date: today,
    });
    return jsonOk({
      date: today,
      users_notified: 0,
      promises_considered: 0,
      promises_notified: 0,
    });
  }

  const byUser = new Map<string, PromiseRow[]>();
  for (const p of promises) {
    if (!p.user_id || !p.promise_text?.trim()) continue;
    const bucket = byUser.get(p.user_id) ?? [];
    bucket.push(p);
    byUser.set(p.user_id, bucket);
  }

  let usersNotified = 0;
  let promisesNotified = 0;

  for (const [userId, rows] of byUser) {
    const items: PromiseDigestItem[] = rows.map((r) => ({
      promiseText: r.promise_text,
      sourceUrl: r.source_url,
      sourceTitle: r.source_title,
      dueDate: r.due_date,
    }));

    if (dryRun) {
      logEvent({
        level: "info",
        fn: "promise-digest",
        event: "dry_run",
        user_id: userId,
        promise_count: items.length,
      });
      continue;
    }

    let sent = false;
    try {
      sent = await sendCivicPromiseDigest(svc, { userId, items });
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "promise-digest",
        event: "send_failed",
        user_id: userId,
        msg: e instanceof Error ? e.message : String(e),
      });
    }

    if (!sent) continue;

    usersNotified += 1;
    const ids = rows.map((r) => r.id);
    const { error: updErr } = await svc
      .from("promises")
      .update({ status: "notified", updated_at: new Date().toISOString() })
      .in("id", ids);
    if (updErr) {
      logEvent({
        level: "warn",
        fn: "promise-digest",
        event: "status_update_failed",
        user_id: userId,
        count: ids.length,
        msg: updErr.message,
      });
      continue;
    }
    promisesNotified += ids.length;
  }

  logEvent({
    level: "info",
    fn: "promise-digest",
    event: "done",
    date: today,
    users_notified: usersNotified,
    promises_considered: promises.length,
    promises_notified: promisesNotified,
  });

  return jsonOk({
    date: today,
    users_notified: usersNotified,
    promises_considered: promises.length,
    promises_notified: promisesNotified,
  });
});
