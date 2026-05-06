/**
 * scout-health-monitor Edge Function — weekly pg_cron digest.
 *
 * Finds scouts that have been auto-paused (is_active=false AND
 * consecutive_failures >= 3), groups by owner, and emails each owner a markdown
 * digest via Resend. Skips sending entirely if RESEND_API_KEY is not set
 * (logged).
 *
 * Email lookup: fetched per-owner from `auth.users` via the service-role
 * admin API at send-time. No email address is persisted in `public.*` —
 * matches the per-scout notification pipelines for strict parity with the
 * "never store emails outside auth.users" policy.
 *
 * Route:
 *   POST /scout-health-monitor
 *     body: {}
 *     -> 200 { emailed: N, paused_scouts: total }
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

const EMAIL_FROM = "coJournalist <alerts@cojournalist.ai>";
const EMAIL_SUBJECT = "\u26A0\uFE0F Scout health digest";

interface PausedScout {
  id: string;
  name: string;
  user_id: string;
  consecutive_failures: number;
  type: string;
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

  try {
    const { data: scouts, error } = await svc
      .from("scouts")
      .select("id, name, user_id, consecutive_failures, type")
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
      return jsonOk({ emailed: 0, paused_scouts: 0 });
    }

    // Group by user_id.
    const grouped = new Map<string, PausedScout[]>();
    for (const s of pausedScouts) {
      if (!s.user_id) continue;
      const bucket = grouped.get(s.user_id);
      if (bucket) bucket.push(s);
      else grouped.set(s.user_id, [s]);
    }

    // Respect opt-out: skip users with health_notifications_enabled=false.
    // Missing user_preferences rows fall back to the column default (TRUE), so
    // new users are opted in until they change the toggle.
    const allUserIds = Array.from(grouped.keys());
    if (allUserIds.length > 0) {
      const { data: optedOut, error: prefErr } = await svc
        .from("user_preferences")
        .select("user_id")
        .in("user_id", allUserIds)
        .eq("health_notifications_enabled", false);
      if (prefErr) {
        logEvent({
          level: "warn",
          fn: "scout-health-monitor",
          event: "opt_out_lookup_failed",
          msg: prefErr.message,
        });
      } else if (optedOut) {
        for (const row of optedOut) {
          if (row.user_id) grouped.delete(row.user_id);
        }
      }
    }

    if (grouped.size === 0) {
      logEvent({
        level: "info",
        fn: "scout-health-monitor",
        event: "all_owners_opted_out",
        paused_scouts: totalPaused,
      });
      return jsonOk({ emailed: 0, paused_scouts: totalPaused });
    }

    if (!resendKey) {
      logEvent({
        level: "warn",
        fn: "scout-health-monitor",
        event: "resend_key_missing",
        paused_scouts: totalPaused,
        owners: grouped.size,
      });
      return jsonOk({ emailed: 0, paused_scouts: totalPaused });
    }

    let emailed = 0;
    for (const [userId, userScouts] of grouped) {
      // Fetch email fresh from auth.users each time — nothing is stored in
      // `public.*`. Matches the per-run scout notification pattern.
      let to: string | null = null;
      try {
        const { data, error: authErr } = await svc.auth.admin.getUserById(
          userId,
        );
        if (authErr) throw new Error(authErr.message);
        to = data.user?.email ?? null;
      } catch (e) {
        logEvent({
          level: "warn",
          fn: "scout-health-monitor",
          event: "auth_lookup_failed",
          user_id: userId,
          msg: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (!to) {
        logEvent({
          level: "info",
          fn: "scout-health-monitor",
          event: "skipped_no_email",
          user_id: userId,
          scouts: userScouts.length,
        });
        continue;
      }
      try {
        const sent = await sendDigest(resendKey, to, userScouts);
        if (sent) emailed += 1;
      } catch (e) {
        logEvent({
          level: "warn",
          fn: "scout-health-monitor",
          event: "resend_failed",
          user_id: userId,
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logEvent({
      level: "info",
      fn: "scout-health-monitor",
      event: "done",
      paused_scouts: totalPaused,
      owners: grouped.size,
      emailed,
    });
    return jsonOk({ emailed, paused_scouts: totalPaused });
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

function buildMarkdown(scouts: PausedScout[]): string {
  const lines = scouts.map(
    (s) =>
      `- **${
        escapeMd(s.name)
      }** (${s.type}): ${s.consecutive_failures} consecutive failures.`,
  );
  return [
    "# Scout health alert",
    "",
    "The following scouts have been paused after repeated failures:",
    "",
    ...lines,
    "",
    "Re-enable from the scouts dashboard after investigating the source.",
    "",
  ].join("\n");
}

function buildHtml(scouts: PausedScout[]): string {
  const items = scouts
    .map(
      (s) =>
        `<li><strong>${escapeHtml(s.name)}</strong> (${
          escapeHtml(s.type)
        }): ${s.consecutive_failures} consecutive failures.</li>`,
    )
    .join("");
  return [
    "<h1>Scout health alert</h1>",
    "<p>The following scouts have been paused after repeated failures:</p>",
    `<ul>${items}</ul>`,
    "<p>Re-enable from the scouts dashboard after investigating the source.</p>",
  ].join("\n");
}

async function sendDigest(
  resendKey: string,
  to: string,
  scouts: PausedScout[],
): Promise<boolean> {
  const text = buildMarkdown(scouts);
  const html = buildHtml(scouts);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject: EMAIL_SUBJECT,
      text,
      html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`resend responded ${res.status}: ${detail.slice(0, 500)}`);
  }
  await res.body?.cancel();
  return true;
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\[\]])/g, "\\$1");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
