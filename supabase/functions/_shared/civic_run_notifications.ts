import type { SupabaseClient } from "./supabase.ts";
import { sendCivicAlert } from "./notifications.ts";
import { markNotificationAttempted, markNotificationResult } from "./run_lifecycle.ts";
import { logEvent } from "./log.ts";

/** Drain sealed run alerts independently of extraction: a completed queue row
 * cannot be reclaimed after a crash between persistence and email delivery. */
export async function drainCivicRunAlerts(
  svc: SupabaseClient,
  workerId: string,
  runId: string | null = null,
): Promise<void> {
  let query = svc.from("civic_run_alert_deliveries")
    .select("scout_run_id")
    .or(`state.in.(pending,failed,provider_accepted),and(state.eq.sending,lease_expires_at.lte.${new Date().toISOString()})`)
    .order("updated_at")
    .limit(10);
  if (runId) query = query.eq("scout_run_id", runId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  for (const delivery of data ?? []) {
    await deliverCivicRunAlert(svc, delivery.scout_run_id, workerId);
  }
}

async function deliverCivicRunAlert(
  svc: SupabaseClient,
  runId: string,
  workerId: string,
): Promise<void> {
  let claim: {
    delivery_id: string;
    user_id: string;
    fencing_token: number;
    provider_idempotency_key: string;
    needs_provider_submission: boolean;
  } | undefined;
  let providerAccepted = false;
  try {
    const { data, error } = await svc.rpc("claim_civic_run_alert_delivery", {
      p_run_id: runId,
      p_worker_id: workerId,
      p_lease_seconds: 900,
    });
    if (error) throw new Error(error.message);
    claim = data?.[0];
    if (!claim) return;
    const fence = {
      p_delivery_id: claim.delivery_id,
      p_worker_id: workerId,
      p_fencing_token: claim.fencing_token,
    };
    providerAccepted = !claim.needs_provider_submission;
    let skipped = false;
    if (!providerAccepted) {
      const { data: run, error: runError } = await svc.from("scout_runs")
        .select("scout_id, scouts!inner(name)").eq("id", runId)
        .eq("user_id", claim.user_id).single();
      if (runError) throw new Error(runError.message);
      const { data: alerts, error: alertError } = await svc.from("civic_run_alert_items")
        .select("unit_id").eq("scout_run_id", runId).eq("user_id", claim.user_id)
        .is("delivered_at", null);
      if (alertError) throw new Error(alertError.message);
      const unitIds = (alerts ?? []).map((item) => item.unit_id);
      // Read the stored tracker, not extracted candidates or stale outbox text.
      const { data: promises, error: promiseError } = unitIds.length
        ? await svc.from("promises")
          .select("promise_text, source_url, source_title, due_date, information_units!inner(id)")
          .eq("user_id", claim.user_id).in("unit_id", unitIds)
          .eq("information_units.user_id", claim.user_id)
          .is("information_units.deleted_at", null)
        : { data: [], error: null };
      if (promiseError) throw new Error(promiseError.message);
      skipped = !promises?.length;
      if (skipped) {
        await markNotificationResult(svc, runId, "skipped", { reason: "no_new_promises" });
      } else {
        await markNotificationAttempted(svc, runId);
        const scout = run.scouts as unknown as { name: string };
        const result = await sendCivicAlert(svc, {
          userId: claim.user_id,
          scoutId: run.scout_id,
          runId,
          scoutName: scout.name,
          items: promises!.map((promise) => ({
            promiseText: promise.promise_text,
            sourceUrl: promise.source_url,
            sourceTitle: promise.source_title,
            dueDate: promise.due_date,
          })),
          providerIdempotencyKey: claim.provider_idempotency_key,
        });
        skipped = result.reason === "email_disabled" || result.reason === "missing_email";
        if (!result.ok && !skipped) throw new Error(result.error ?? result.reason ?? "send failed");
        if (result.ok) {
          // If recording acceptance fails, retain the lease and the stable key.
          providerAccepted = true;
          const { data: accepted, error: acceptedError } = await svc.rpc(
            "mark_civic_run_alert_provider_accepted",
            { ...fence, p_provider_id: result.providerId ?? null },
          );
          if (acceptedError || !accepted) throw new Error(acceptedError?.message ?? "alert lease lost");
        }
        await markNotificationResult(svc, runId, skipped ? "skipped" : "sent", {
          reason: result.reason,
          providerId: result.providerId ?? null,
        });
      }
    } else {
      await markNotificationResult(svc, runId, "sent");
    }
    // Finalize the fenced ledger first; stale workers must not consume items.
    const { data: finalized, error: finalizeError } = await svc.rpc("finalize_civic_run_alert_delivery", {
      ...fence,
      p_state: "sent",
      p_error: skipped ? "skipped" : null,
    });
    if (finalizeError || !finalized) throw new Error(finalizeError?.message ?? "alert lease lost");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claim && !providerAccepted) {
      const { error: finalizeError } = await svc.rpc("finalize_civic_run_alert_delivery", {
        p_delivery_id: claim.delivery_id,
        p_worker_id: workerId,
        p_fencing_token: claim.fencing_token,
        p_state: "failed",
        p_error: message,
      });
      if (finalizeError) logEvent({ level: "warn", fn: "civic-run-alert", event: "finalize_failed", msg: finalizeError.message });
    }
    await markNotificationResult(svc, runId, "failed", message);
    logEvent({ level: "warn", fn: "civic-run-alert", event: "notify_failed", run_id: runId, msg: message });
  }
}
