/** Daily, idempotent reminders for due and overdue open Civic promises. */
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { logEvent } from "../_shared/log.ts";
import { sendCivicPromiseDigest } from "../_shared/notifications.ts";

interface ClaimedReminder {
  delivery_id: string;
  promise_id: string;
  user_id: string;
  promise_text: string;
  source_url: string | null;
  source_title: string | null;
  due_date: string;
  provider_idempotency_key: string;
  needs_provider_submission: boolean;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return jsonError("method not allowed", 405);
  try {
    requireServiceKey(req);
  } catch (error) {
    return jsonFromError(error);
  }

  let body: { date?: string; dry_run?: boolean } = {};
  try {
    if (req.headers.get("content-length") !== "0") body = await req.json();
  } catch { /* defaults */ }
  const dueOnOrBefore =
    typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : new Date().toISOString().slice(0, 10);
  const dryRun = body.dry_run === true;
  const svc = getServiceClient();
  const workerId = crypto.randomUUID();

  if (dryRun) {
    const { count, error } = await svc.from("promises").select("id", {
      count: "exact",
      head: true,
    })
      .lte("due_date", dueOnOrBefore).in("status", ["new", "in_progress"]).is(
        "due_notified_at",
        null,
      );
    if (error) return jsonError(`query failed: ${error.message}`, 500);
    return jsonOk({
      date: dueOnOrBefore,
      dry_run: true,
      promises_considered: count ?? 0,
      promises_notified: 0,
      users_notified: 0,
    });
  }

  const { data, error } = await svc.rpc("claim_due_promise_reminders", {
    p_worker_id: workerId,
    p_due_on_or_before: dueOnOrBefore,
    p_limit: 100,
    p_lease_seconds: 900,
  });
  if (error) return jsonError(`claim failed: ${error.message}`, 500);
  const claimed = (data ?? []) as ClaimedReminder[];
  const usersNotified = new Set<string>();
  let promisesNotified = 0;
  // Each deadline owns its provider key. Re-batching failed reminders with
  // newly due promises would change the key and resend an accepted deadline.
  for (const reminder of claimed) {
    const deliveryIds = [reminder.delivery_id];
    let accepted = !reminder.needs_provider_submission;
    try {
      if (!accepted) {
        const result = await sendCivicPromiseDigest(svc, {
          userId: reminder.user_id,
          items: [{
            promiseText: reminder.promise_text,
            sourceUrl: reminder.source_url,
            sourceTitle: reminder.source_title,
            dueDate: reminder.due_date,
          }],
          providerIdempotencyKey: reminder.provider_idempotency_key,
        });
        if (!result.ok) throw new Error(result.error ?? result.reason ?? "send failed");
        accepted = true;
        const { data: marked, error: markError } = await svc.rpc(
          "mark_due_promise_reminders_provider_accepted",
          {
            p_worker_id: workerId,
            p_delivery_ids: deliveryIds,
            p_provider_id: result.providerId ?? null,
          },
        );
        if (markError || marked !== 1) throw new Error(markError?.message ?? "reminder lease lost");
      }
      const { data: finalized, error: finalizeError } = await svc.rpc(
        "finalize_due_promise_reminders",
        {
          p_worker_id: workerId,
          p_delivery_ids: deliveryIds,
          p_success: true,
          p_error: null,
        },
      );
      if (finalizeError) throw new Error(finalizeError.message);
      if (finalized === 1) {
        usersNotified.add(reminder.user_id);
        promisesNotified++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Keep accepted/sending state on an ambiguous DB failure. The next
      // claim reconciles acceptance or resubmits the same deadline key.
      if (!accepted) {
        const { error: finalizeError } = await svc.rpc("finalize_due_promise_reminders", {
          p_worker_id: workerId,
          p_delivery_ids: deliveryIds,
          p_success: false,
          p_error: message,
        });
        if (finalizeError) logEvent({ level: "warn", fn: "promise-digest", event: "failure_finalize_failed", msg: finalizeError.message });
      }
      logEvent({
        level: "warn",
        fn: "promise-digest",
        event: "delivery_failed",
        user_id: reminder.user_id,
        msg: message,
      });
    }
  }
  return jsonOk({
    date: dueOnOrBefore,
    users_notified: usersNotified.size,
    promises_considered: claimed.length,
    promises_notified: promisesNotified,
  });
});

