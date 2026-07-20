/** Signed Resend delivery webhook with idempotent run reconciliation. */

import { handleCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonOk } from "../_shared/responses.ts";
import { logEvent } from "../_shared/log.ts";
import {
  deliveryStatusForEvent,
  parseResendEmailEvent,
  sanitizedDeliveryDetails,
  verifyResendWebhookSignature,
} from "./resend_webhook.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return jsonError("method not allowed", 405);

  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET")?.trim();
  if (!secret) {
    logEvent({
      level: "error",
      fn: "resend-webhook",
      event: "secret_missing",
    });
    return jsonError("webhook not configured", 503);
  }

  const payload = await req.text();
  const svixId = req.headers.get("svix-id") ?? "";
  try {
    await verifyResendWebhookSignature(payload, {
      id: svixId,
      timestamp: req.headers.get("svix-timestamp") ?? "",
      signature: req.headers.get("svix-signature") ?? "",
    }, secret);
  } catch (error) {
    logEvent({
      level: "warn",
      fn: "resend-webhook",
      event: "signature_rejected",
      msg: error instanceof Error ? error.message : String(error),
    });
    return jsonError("invalid webhook signature", 400);
  }

  let event;
  try {
    event = parseResendEmailEvent(JSON.parse(payload));
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "invalid webhook payload",
      400,
    );
  }

  const sanitized = sanitizedDeliveryDetails(event);
  const svc = getServiceClient();
  const { data, error } = await svc.rpc("record_resend_delivery_event", {
    p_svix_id: svixId,
    p_provider_email_id: event.data.email_id,
    p_event_type: event.type,
    p_delivery_status: deliveryStatusForEvent(event.type),
    p_event_created_at: event.created_at,
    p_recipient_count: sanitized.recipientCount,
    p_reason: sanitized.reason,
    p_details: sanitized.details,
  });
  if (error) {
    logEvent({
      level: "error",
      fn: "resend-webhook",
      event: "persist_failed",
      provider_email_id: event.data.email_id,
      event_type: event.type,
      msg: error.message,
    });
    return jsonError("failed to persist webhook event", 500);
  }
  const result = Array.isArray(data) ? data[0] : data;
  logEvent({
    level: "info",
    fn: "resend-webhook",
    event: result?.inserted === false ? "duplicate" : "reconciled",
    event_type: event.type,
    provider_email_id: event.data.email_id,
    run_id: result?.matched_run_id ?? null,
    matched: !!result?.matched_run_id,
    status_reconciled: result?.reconciled === true,
  });
  return jsonOk({
    received: true,
    duplicate: result?.inserted === false,
    matched: !!result?.matched_run_id,
    reconciled: result?.reconciled === true,
  });
});
