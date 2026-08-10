/** Daily, idempotent reminders for overdue open Civic promises. */
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
  const byUser = new Map<string, ClaimedReminder[]>();
  for (const reminder of claimed) {
    const bucket = byUser.get(reminder.user_id) ?? [];
    bucket.push(reminder);
    byUser.set(reminder.user_id, bucket);
  }

  let usersNotified = 0;
  let promisesNotified = 0;
  for (const [userId, reminders] of byUser) {
    const toSubmit = reminders.filter((reminder) =>
      reminder.needs_provider_submission
    );
    const accepted = reminders.filter((reminder) =>
      !reminder.needs_provider_submission
    );
    let submitted = toSubmit.length === 0;
    let providerId: string | null = null;
    let sendError: string | null = null;
    if (toSubmit.length > 0) {
      try {
        const result = await sendCivicPromiseDigest(svc, {
          userId,
          items: toSubmit.map((reminder) => ({
            promiseText: reminder.promise_text,
            sourceUrl: reminder.source_url,
            sourceTitle: reminder.source_title,
            dueDate: reminder.due_date,
          })),
          providerIdempotencyKey: await reminderBatchKey(toSubmit),
        });
        submitted = result.ok;
        providerId = result.providerId ?? null;
        sendError = result.error ?? result.reason ?? null;
      } catch (error) {
        sendError = error instanceof Error ? error.message : String(error);
        logEvent({
          level: "warn",
          fn: "promise-digest",
          event: "send_failed",
          user_id: userId,
          msg: sendError,
        });
      }
    }
    if (submitted && toSubmit.length > 0) {
      const { error: acceptedError } = await svc.rpc(
        "mark_due_promise_reminders_provider_accepted",
        {
          p_worker_id: workerId,
          p_delivery_ids: toSubmit.map((reminder) => reminder.delivery_id),
          p_provider_id: providerId,
        },
      );
      if (acceptedError) {
        logEvent({
          level: "warn",
          fn: "promise-digest",
          event: "provider_acceptance_record_failed",
          user_id: userId,
          msg: acceptedError.message,
        });
        submitted = false;
        sendError = acceptedError.message;
      }
    }
    const delivered = submitted ? [...accepted, ...toSubmit] : accepted;
    const failed = submitted ? [] : toSubmit;
    const { data: finalized, error: finalizeError } = delivered.length > 0
      ? await svc.rpc(
        "finalize_due_promise_reminders",
        {
          p_worker_id: workerId,
          p_delivery_ids: delivered.map((reminder) => reminder.delivery_id),
          p_success: true,
          p_error: null,
        },
      )
      : { data: 0, error: null };
    if (failed.length > 0) {
      const { error: failedFinalizeError } = await svc.rpc(
        "finalize_due_promise_reminders",
        {
          p_worker_id: workerId,
          p_delivery_ids: failed.map((reminder) => reminder.delivery_id),
          p_success: false,
          p_error: sendError ?? "provider delivery failed",
        },
      );
      if (failedFinalizeError) {
        logEvent({
          level: "warn",
          fn: "promise-digest",
          event: "failure_finalize_failed",
          user_id: userId,
          msg: failedFinalizeError.message,
        });
      }
    }
    if (finalizeError) {
      logEvent({
        level: "warn",
        fn: "promise-digest",
        event: "finalize_failed",
        user_id: userId,
        msg: finalizeError.message,
      });
      continue;
    }
    if (delivered.length > 0) {
      usersNotified += 1;
      promisesNotified += Number(finalized ?? 0);
    }
  }
  return jsonOk({
    date: dueOnOrBefore,
    users_notified: usersNotified,
    promises_considered: claimed.length,
    promises_notified: promisesNotified,
  });
});

async function reminderBatchKey(reminders: ClaimedReminder[]): Promise<string> {
  const identities = reminders.map((reminder) =>
    reminder.provider_idempotency_key
  )
    .sort().join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identities),
  );
  const hex = [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `civic/reminder-batch/${reminders[0]?.user_id ?? "unknown"}/${hex}`;
}
