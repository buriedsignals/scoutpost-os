/**
 * user Edge Function — authed user profile + preferences.
 *
 * Routes:
 *   GET   /user/me                   caller profile from JWT
 *   GET   /user/preferences          user_preferences row (or {} if absent)
 *   PATCH /user/preferences          upsert preference fields
 *   POST  /user/onboarding-complete  mark onboarding_completed = TRUE
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import {
  AuthedUser,
  requireUser,
  requireUserOrApiKey,
} from "../_shared/auth.ts";
import { getServiceClient, getUserClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";

/**
 * The spec lists fields (timezone, language, onboarding_completed,
 * email_notifications, digest_frequency, ui_density, theme).
 *
 * The DB (00002_tables.sql) only has explicit columns for `timezone`,
 * `preferred_language`, and `onboarding_completed`. The remaining fields
 * are stored inside the `preferences` JSONB blob.
 *
 * We map `language` -> `preferred_language`, and fold email_notifications /
 * digest_frequency / ui_density / theme into preferences.* on upsert.
 */
// Location bag accepted from the New-Scout modal's geocoder — kept loose to
// avoid enforcing a stable MapTiler shape across the stack.
const LocationSchema = z.object({
  displayName: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  coords: z
    .object({ lat: z.number().optional(), lon: z.number().optional() })
    .partial()
    .optional(),
}).passthrough();

const PreferencesSchema = z.object({
  timezone: z.string().min(1).max(64).optional(),
  language: z.string().min(2).max(8).optional(),
  preferred_language: z.string().min(2).max(8).optional(),
  onboarding_completed: z.boolean().optional(),
  onboarding_tour_completed: z.boolean().optional(),
  email_notifications: z.boolean().optional(),
  digest_frequency: z.enum(["off", "daily", "weekly", "monthly"]).optional(),
  ui_density: z.enum(["comfortable", "compact"]).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  // Opt-in for the weekly scout-health-monitor digest. Default TRUE in DB.
  health_notifications_enabled: z.boolean().optional(),
  // Default location pre-fills the Location-Scout modal. Accepts `null` to clear.
  default_location: LocationSchema.nullable().optional(),
  // Domains excluded from beat/beat searches (case-insensitive).
  excluded_domains: z.array(z.string().min(1).max(253)).max(100).optional(),
  // CMS export target (Markdown / REST). Token is stored verbatim for now —
  // a crypto wrapper will be added before we ship the CMS exporter to users.
  cms_api_url: z.string().url().nullable().optional(),
  cms_api_token: z.string().min(1).max(4096).nullable().optional(),
});

type PreferencesInput = z.infer<typeof PreferencesSchema>;

Deno.serve(async (req): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/user/, "") || "/";
  const isRead = req.method === "GET" || req.method === "HEAD";

  let user: AuthedUser;
  try {
    user = path === "/me" && isRead
      ? await requireUserOrApiKey(req)
      : await requireUser(req);
  } catch (e) {
    return jsonFromError(e);
  }

  try {
    if (path === "/me" && isRead) {
      return await getMe(user);
    }
    if (path === "/preferences" && isRead) {
      return await getPreferences(user);
    }
    if (path === "/preferences" && req.method === "PATCH") {
      return await patchPreferences(req, user);
    }
    if (path === "/onboarding-complete" && req.method === "POST") {
      return await completeOnboarding(user);
    }
    return jsonError("method not allowed", 405);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "user",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

const PRO_UPGRADE_URL =
  "https://accounts.muckrock.com/plans/70-cojournalist-pro/?source=cojournalist";
const TEAM_UPGRADE_URL =
  "https://accounts.muckrock.com/plans/71-cojournalist-team/?source=cojournalist";

const DEFAULT_MONTHLY_CAPS: Record<"free" | "pro" | "team", number> = {
  free: 100,
  pro: 1000,
  team: 5000,
};

interface MeResponse {
  user_id: string;
  email?: string;
  muckrock_subject?: string;
  tier: "free" | "pro" | "team";
  credits: number;
  monthly_cap: number;
  org_id: string | null;
  team: { org_id: string; org_name: string; seat_count: number } | null;
  upgrade_url: string;
  team_upgrade_url: string;
  preferred_language: string | null;
  timezone: string | null;
  health_notifications_enabled: boolean;
}

/**
 * GET /me — returns the shape consumed by `$authStore.user` on the frontend
 * (mirrors the source backend/app/routers/auth.py /auth/me response).
 *
 * Reads via the service client — `credit_accounts` / `user_preferences` live
 * behind SELECT RLS for the user themselves, but we also want to include the
 * team pool row when the user is an org member, which we trust the DB-stored
 * active_org_id + membership check to gate.
 */
async function getMe(user: AuthedUser): Promise<Response> {
  const svc = getServiceClient();

  const { data: prefs } = await svc
    .from("user_preferences")
    .select(
      "tier, active_org_id, preferred_language, timezone, health_notifications_enabled",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  const tier = (prefs?.tier ?? "free") as "free" | "pro" | "team";
  const activeOrgId = (prefs?.active_org_id ?? null) as string | null;
  const preferredLanguage = (prefs?.preferred_language ?? null) as
    | string
    | null;
  const timezone = (prefs?.timezone ?? null) as string | null;
  const healthNotificationsEnabled =
    (prefs?.health_notifications_enabled ?? true) as boolean;

  // Read the applicable credit row: team pool first, else the user's own.
  const { data: creditRow } = activeOrgId
    ? await svc
      .from("credit_accounts")
      .select("balance, monthly_cap, tier")
      .eq("org_id", activeOrgId)
      .maybeSingle()
    : await svc
      .from("credit_accounts")
      .select("balance, monthly_cap, tier")
      .eq("user_id", user.id)
      .maybeSingle();

  const effectiveTier = (creditRow?.tier ?? tier) as "free" | "pro" | "team";
  const credits = creditRow?.balance ?? 0;
  const monthlyCap = creditRow?.monthly_cap ??
    DEFAULT_MONTHLY_CAPS[effectiveTier];

  let team: MeResponse["team"] = null;
  if (activeOrgId) {
    const { data: org } = await svc
      .from("orgs")
      .select("id, name")
      .eq("id", activeOrgId)
      .maybeSingle();
    const { count: seatCount } = await svc
      .from("org_members")
      .select("user_id", { count: "exact", head: true })
      .eq("org_id", activeOrgId);
    if (org) {
      team = {
        org_id: org.id,
        org_name: org.name,
        seat_count: seatCount ?? 0,
      };
    }
  }

  const body: MeResponse = {
    user_id: user.id,
    email: user.email,
    muckrock_subject: user.muckrockSubject,
    tier: effectiveTier,
    credits,
    monthly_cap: monthlyCap,
    org_id: activeOrgId,
    team,
    upgrade_url: PRO_UPGRADE_URL,
    team_upgrade_url: TEAM_UPGRADE_URL,
    preferred_language: preferredLanguage,
    timezone,
    health_notifications_enabled: healthNotificationsEnabled,
  };
  return jsonOk(body);
}

async function getPreferences(user: AuthedUser): Promise<Response> {
  const db = getUserClient(user.token);
  const { data, error } = await db
    .from("user_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return jsonOk(data ?? {});
}

async function patchPreferences(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = PreferencesSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    throw new ValidationError("no updatable fields provided");
  }

  return await upsertPreferences(user, parsed.data);
}

async function completeOnboarding(user: AuthedUser): Promise<Response> {
  return await upsertPreferences(user, { onboarding_completed: true });
}

async function upsertPreferences(
  user: AuthedUser,
  input: PreferencesInput,
): Promise<Response> {
  const db = getUserClient(user.token);

  // Fetch existing row so we can merge JSONB `preferences` without clobbering.
  const { data: existing, error: readErr } = await db
    .from("user_preferences")
    .select("preferences")
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);

  const jsonbPatch: Record<string, unknown> = {};
  if (input.email_notifications !== undefined) {
    jsonbPatch.email_notifications = input.email_notifications;
  }
  if (input.digest_frequency !== undefined) {
    jsonbPatch.digest_frequency = input.digest_frequency;
  }
  if (input.ui_density !== undefined) jsonbPatch.ui_density = input.ui_density;
  if (input.theme !== undefined) jsonbPatch.theme = input.theme;

  const mergedPreferences = {
    ...((existing?.preferences as Record<string, unknown> | null) ?? {}),
    ...jsonbPatch,
  };

  const row: Record<string, unknown> = {
    user_id: user.id,
    updated_at: new Date().toISOString(),
  };
  if (input.timezone !== undefined) row.timezone = input.timezone;
  if (input.language !== undefined) row.preferred_language = input.language;
  if (input.preferred_language !== undefined) {
    row.preferred_language = input.preferred_language;
  }
  if (input.onboarding_completed !== undefined) {
    row.onboarding_completed = input.onboarding_completed;
  }
  if (input.onboarding_tour_completed !== undefined) {
    row.onboarding_tour_completed = input.onboarding_tour_completed;
  }
  if (input.health_notifications_enabled !== undefined) {
    row.health_notifications_enabled = input.health_notifications_enabled;
  }
  if (input.default_location !== undefined) {
    row.default_location = input.default_location;
  }
  if (input.excluded_domains !== undefined) {
    row.excluded_domains = input.excluded_domains;
  }
  if (input.cms_api_url !== undefined) row.cms_api_url = input.cms_api_url;
  if (input.cms_api_token !== undefined) {
    row.cms_api_token = input.cms_api_token;
  }
  if (Object.keys(jsonbPatch).length > 0 || existing?.preferences) {
    row.preferences = mergedPreferences;
  }

  const { data, error } = await db
    .from("user_preferences")
    .upsert(row, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) throw new Error(error.message);

  logEvent({
    level: "info",
    fn: "user",
    event: "preferences_updated",
    user_id: user.id,
  });
  return jsonOk(data);
}
