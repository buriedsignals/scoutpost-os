/** Five-minute operator monitor for queue delay and vessel sampler health. */

import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { AuthError } from "../_shared/errors.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { getServiceClient, type SupabaseClient } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";
import {
  DEFAULT_QUEUE_DELAY_MS,
  DEFAULT_SAMPLER_STALE_MS,
  evaluateQueueIncident,
  evaluateVesselSamplerIncident,
  type OperationalIncident,
} from "../_shared/operations_health.ts";

const DEFAULT_RECIPIENTS = "tom@buriedsignals.com";
const EMAIL_FROM = "Scoutpost <alerts@scoutpost.ai>";

interface SamplerRow {
  started_at: string;
  status: string;
  error_code: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return jsonError("method not allowed", 405);
  try {
    requireServiceKey(req);
  } catch (error) {
    return jsonFromError(error instanceof AuthError ? error : new AuthError());
  }

  const svc = getServiceClient();
  try {
    const observations = await collectIncidents(svc);
    const notifications: Array<{
      incident: OperationalIncident;
      transition: string;
    }> = [];
    for (const incident of observations) {
      const { data, error } = await svc.rpc("record_operator_incident", {
        p_incident_key: incident.key,
        p_kind: incident.kind,
        p_active: incident.active,
        p_severity: incident.severity,
        p_summary: incident.summary,
        p_details: incident.details,
        p_repeat_seconds: envInt(
          "OPERATIONS_ALERT_REPEAT_SECONDS",
          21600,
          300,
          86400,
        ),
      });
      if (error) throw new Error(error.message);
      const result = Array.isArray(data) ? data[0] : data;
      if (result?.should_notify === true) {
        notifications.push({
          incident,
          transition: String(result.transition ?? "changed"),
        });
      }
    }

    const emailed = notifications.length > 0
      ? await sendOperatorAlert(notifications)
      : false;
    if (emailed) {
      const { error: ackError } = await svc.rpc(
        "ack_operator_incident_notifications",
        { p_incident_keys: notifications.map((item) => item.incident.key) },
      );
      if (ackError) {
        throw new Error(
          `incident notification ack failed: ${ackError.message}`,
        );
      }
    }
    logEvent({
      level: "info",
      fn: "operations-monitor",
      event: "checked",
      active_incidents: observations.filter((item) => item.active).length,
      transitions: notifications.length,
      emailed,
    });
    return jsonOk({
      checked: observations.length,
      active_incidents: observations.filter((item) => item.active).length,
      transitions: notifications.map((item) => ({
        key: item.incident.key,
        transition: item.transition,
      })),
      emailed: emailed ? 1 : 0,
    });
  } catch (error) {
    logEvent({
      level: "error",
      fn: "operations-monitor",
      event: "failed",
      msg: error instanceof Error ? error.message : String(error),
    });
    return jsonFromError(error);
  }
});

async function collectIncidents(
  svc: SupabaseClient,
): Promise<OperationalIncident[]> {
  const now = new Date();
  const queueThreshold = envInt(
    "OPERATIONS_QUEUE_DELAY_SECONDS",
    DEFAULT_QUEUE_DELAY_MS / 1000,
    60,
    86400,
  ) * 1000;
  const samplerThreshold = envInt(
    "OPERATIONS_VESSEL_STALE_SECONDS",
    DEFAULT_SAMPLER_STALE_MS / 1000,
    300,
    86400,
  ) * 1000;

  const [dispatch, civic, latestSampler, latestSuccess] = await Promise.all([
    queueObservation(svc, "scout_dispatch_queue", ["queued"], ["leased"]),
    queueObservation(svc, "civic_extraction_queue", ["pending"], [
      "processing",
    ]),
    latestSamplerRow(svc, false),
    latestSamplerRow(svc, true),
  ]);

  return [
    evaluateQueueIncident(
      {
        key: "dispatch_queue_delay",
        kind: "dispatch_queue_delay",
        label: "Scout dispatch",
        ...dispatch,
      },
      now,
      queueThreshold,
    ),
    evaluateQueueIncident(
      {
        key: "civic_queue_delay",
        kind: "civic_queue_delay",
        label: "Civic extraction",
        ...civic,
      },
      now,
      queueThreshold,
    ),
    evaluateVesselSamplerIncident(
      {
        latestStartedAt: latestSampler?.started_at ?? null,
        latestStatus: latestSampler?.status ?? null,
        latestErrorCode: latestSampler?.error_code ?? null,
        latestSuccessAt: latestSuccess?.started_at ?? null,
      },
      now,
      samplerThreshold,
    ),
  ];
}

async function queueObservation(
  svc: SupabaseClient,
  table: string,
  queuedStatuses: string[],
  activeStatuses: string[],
): Promise<{
  queuedCount: number;
  activeCount: number;
  failedCount: number;
  oldestQueuedAt: string | null;
}> {
  const [queued, active, failed, oldest] = await Promise.all([
    rowCount(svc, table, queuedStatuses),
    rowCount(svc, table, activeStatuses),
    rowCount(svc, table, ["failed"]),
    svc.from(table).select("created_at").in("status", queuedStatuses)
      .order("created_at", { ascending: true }).limit(1).maybeSingle(),
  ]);
  if (oldest.error) throw new Error(oldest.error.message);
  return {
    queuedCount: queued,
    activeCount: active,
    failedCount: failed,
    oldestQueuedAt:
      (oldest.data as { created_at?: string } | null)?.created_at ?? null,
  };
}

async function rowCount(
  svc: SupabaseClient,
  table: string,
  statuses: string[],
): Promise<number> {
  const { count, error } = await svc.from(table).select("id", {
    count: "exact",
    head: true,
  }).in("status", statuses);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function latestSamplerRow(
  svc: SupabaseClient,
  successfulOnly: boolean,
): Promise<SamplerRow | null> {
  let query = svc.from("transport_sampler_runs")
    .select("started_at,status,error_code").eq("task", "ais")
    .order("started_at", { ascending: false }).limit(1);
  if (successfulOnly) query = query.eq("status", "succeeded");
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data as SamplerRow | null;
}

async function sendOperatorAlert(
  items: Array<{ incident: OperationalIncident; transition: string }>,
): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY")?.trim();
  if (!key) {
    logEvent({
      level: "warn",
      fn: "operations-monitor",
      event: "resend_key_missing",
    });
    return false;
  }
  const recipients = (Deno.env.get("OPERATIONS_ALERT_RECIPIENTS") ??
    Deno.env.get("HEALTH_REPORT_RECIPIENTS") ?? DEFAULT_RECIPIENTS)
    .split(",").map((value) => value.trim()).filter(Boolean);
  const active = items.filter((item) => item.incident.active).length;
  const subject = active > 0
    ? `⚠️ Scoutpost operations: ${active} incident update${
      active === 1 ? "" : "s"
    }`
    : "✅ Scoutpost operations recovered";
  const rows = items.map(({ incident, transition }) =>
    `<li><strong>${escapeHtml(transition.toUpperCase())}: ${
      escapeHtml(incident.kind)
    }</strong>` +
    ` — ${escapeHtml(incident.summary)}</li>`
  ).join("");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: recipients,
      subject,
      html: `<div style="font-family:Arial,Helvetica,sans-serif"><h2>${
        escapeHtml(subject)
      }</h2><ul>${rows}</ul></div>`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 500)}`);
  }
  await res.body?.cancel();
  return true;
}

function envInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(Deno.env.get(name) ?? "", 10);
  return Math.min(
    max,
    Math.max(min, Number.isFinite(parsed) ? parsed : fallback),
  );
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
