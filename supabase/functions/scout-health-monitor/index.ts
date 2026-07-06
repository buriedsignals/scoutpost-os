/**
 * scout-health-monitor Edge Function — weekly pg_cron OPERATOR digest.
 *
 * Operator decision (2026-07-06): users do NOT receive weekly health digests
 * — only the operator does. Users still get the immediate per-scout
 * deactivation email when the 3-strike threshold trips (that one respects
 * their `health_notifications_enabled` preference; see
 * `_shared/notifications.ts` sendScoutDeactivated).
 *
 * This function finds every auto-paused scout (is_active=false AND
 * consecutive_failures >= 3) across ALL users, groups them by owner email,
 * and sends ONE digest to the operator recipients so silent user-churn risk
 * is visible weekly. Skips sending entirely if RESEND_API_KEY is not set
 * (logged) or nothing is paused.
 *
 * Owner emails are fetched from `auth.users` via the service-role admin API
 * at send-time — nothing is persisted in `public.*`.
 *
 * Route:
 *   POST /scout-health-monitor
 *     body: {}
 *     -> 200 { emailed: 0|1, paused_scouts: total, owners: N }
 *
 * Env:
 *   HEALTH_REPORT_RECIPIENTS — comma-separated operator emails
 *                              (default: tom@buriedsignals.com)
 *
 * Auth: shared service auth (X-Service-Key from cron, with service-role bearer
 *       fallback for operator tooling).
 */

import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { AuthError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";

const EMAIL_FROM = "Scoutpost <alerts@scoutpost.ai>";
const DEFAULT_RECIPIENTS = "tom@buriedsignals.com";

interface PausedScout {
  id: string;
  name: string;
  user_id: string;
  consecutive_failures: number;
  type: string;
  updated_at: string | null;
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
    return jsonFromError(e instanceof AuthError ? e : new AuthError());
  }

  const svc = getServiceClient();
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const recipients = (Deno.env.get("HEALTH_REPORT_RECIPIENTS") ?? DEFAULT_RECIPIENTS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const { data: scouts, error } = await svc
      .from("scouts")
      .select("id, name, user_id, consecutive_failures, type, updated_at")
      .eq("is_active", false)
      .gte("consecutive_failures", 3);
    if (error) throw new Error(error.message);

    const pausedScouts = (scouts ?? []) as PausedScout[];
    const totalPaused = pausedScouts.length;

    if (totalPaused === 0) {
      logEvent({
        level: "info",
        fn: "scout-health-monitor",
        event: "no_paused_scouts",
      });
      return jsonOk({ emailed: 0, paused_scouts: 0, owners: 0 });
    }

    // Group by user_id, then resolve each owner's email once for display.
    const grouped = new Map<string, PausedScout[]>();
    for (const s of pausedScouts) {
      if (!s.user_id) continue;
      const bucket = grouped.get(s.user_id);
      if (bucket) bucket.push(s);
      else grouped.set(s.user_id, [s]);
    }

    const ownerEmails = new Map<string, string>();
    for (const userId of grouped.keys()) {
      try {
        const { data, error: authErr } = await svc.auth.admin.getUserById(
          userId,
        );
        if (authErr) throw new Error(authErr.message);
        ownerEmails.set(userId, data.user?.email ?? userId);
      } catch (e) {
        logEvent({
          level: "warn",
          fn: "scout-health-monitor",
          event: "auth_lookup_failed",
          user_id: userId,
          msg: e instanceof Error ? e.message : String(e),
        });
        ownerEmails.set(userId, userId);
      }
    }

    if (!resendKey) {
      logEvent({
        level: "warn",
        fn: "scout-health-monitor",
        event: "resend_key_missing",
        paused_scouts: totalPaused,
        owners: grouped.size,
      });
      return jsonOk({
        emailed: 0,
        paused_scouts: totalPaused,
        owners: grouped.size,
      });
    }

    const subject =
      `⚠️ Scoutpost operator digest: ${totalPaused} auto-paused scout${
        totalPaused === 1 ? "" : "s"
      } across ${grouped.size} user${grouped.size === 1 ? "" : "s"}`;
    const html = buildOperatorHtml(grouped, ownerEmails);

    let emailed = 0;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: recipients,
          subject,
          html,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(
          `resend responded ${res.status}: ${detail.slice(0, 500)}`,
        );
      }
      await res.body?.cancel();
      emailed = 1;
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "scout-health-monitor",
        event: "resend_failed",
        msg: e instanceof Error ? e.message : String(e),
      });
    }

    logEvent({
      level: "info",
      fn: "scout-health-monitor",
      event: "done",
      paused_scouts: totalPaused,
      owners: grouped.size,
      emailed,
    });
    return jsonOk({
      emailed,
      paused_scouts: totalPaused,
      owners: grouped.size,
    });
  } catch (e) {
    logEvent({
      level: "error",
      fn: "scout-health-monitor",
      event: "unhandled",
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

function buildOperatorHtml(
  grouped: Map<string, PausedScout[]>,
  ownerEmails: Map<string, string>,
): string {
  const sections = [...grouped.entries()]
    .map(([userId, scouts]) => {
      const owner = escapeHtml(ownerEmails.get(userId) ?? userId);
      const items = scouts
        .map(
          (s) =>
            `<li><strong>${escapeHtml(s.name)}</strong> (${
              escapeHtml(s.type)
            }): ${s.consecutive_failures} consecutive failures${
              s.updated_at ? `, paused since ${s.updated_at.slice(0, 10)}` : ""
            }</li>`,
        )
        .join("");
      return `<p style="margin-bottom:2px;"><strong>${owner}</strong> — ${scouts.length} paused</p><ul style="margin-top:2px;">${items}</ul>`;
    })
    .join("");
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1F1A17;">',
    "<h2>Auto-paused scouts (operator digest)</h2>",
    "<p>These scouts stopped after 3+ consecutive failures. Owners received an immediate deactivation email at pause time; this weekly digest is operator-only.</p>",
    sections,
    "</div>",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
