/**
 * scouts Edge Function — CRUD + lifecycle for scouts.
 *
 * Routes:
 *   GET    /scouts              list caller's scouts (paginated)
 *   POST   /scouts              create scout
 *   GET    /scouts/:id          fetch a single scout
 *   PATCH  /scouts/:id          update scout
 *   DELETE /scouts/:id          delete scout + unschedule cron
 *   POST   /scouts/:id/run      trigger on-demand run (202 + run_id)
 *   POST   /scouts/:id/pause    set is_active=false + unschedule cron
 *   POST   /scouts/:id/resume   set is_active=true + (re)schedule cron
 *
 * Scout queries accept Supabase JWTs and cj_ API keys. API-key callers use
 * the service client with explicit user_id filters. Scheduling/trigger RPCs
 * are SECURITY DEFINER and invoked via getServiceClient() because they touch
 * cron.job and vault secrets.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import {
  AuthedUser,
  getCallerClient,
  internalServiceAuthHeaders,
  requireUserOrApiKey,
} from "../_shared/auth.ts";
import { getServiceClient, getSupabaseUrl } from "../_shared/supabase.ts";
import {
  jsonError,
  jsonFromError,
  jsonOk,
  jsonPaginated,
} from "../_shared/responses.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { shapeScoutResponse } from "../_shared/db.ts";
import {
  isInvalidLinkedInProfileUrl,
  isLinkedInCompanyUrl,
  normalizeSocialHandle,
} from "../_shared/social_profiles.ts";
import {
  deriveScheduleAnchor,
  resolveScheduleAction,
  schedulePolicyError,
  subDailyCronFromParts,
} from "../_shared/schedule_policy.ts";
import {
  type TransportConfig,
  validateTransportConfig,
} from "../_shared/transport_config.ts";
import {
  buildTransportBaselineRows,
  MAX_TRANSPORT_BASELINE_IDS,
  validateTransportBaselineIds,
} from "../_shared/transport_baseline.ts";
import { assertTransportEntitled } from "../_shared/transport_entitlement.ts";
import { doubleProbe, firecrawlScrape } from "../_shared/scrape_firecrawl.ts";
import { scrape } from "../_shared/scrape.ts";
import { writeCanonicalBaseline } from "../_shared/canonical_baseline.ts";
import { geminiExtract } from "../_shared/gemini.ts";
import { compressContext } from "../_shared/taco_compress.ts";
import {
  captureWebBaselineSnapshot,
  ensureWebBaseline,
} from "../_shared/web_scout_baseline.ts";
import { creditsEnabled } from "../_shared/credits.ts";
import { runSnapshotInBackground } from "../_shared/snapshot_capture.ts";
import { deleteScoutSnapshots } from "../_shared/snapshot_store.ts";
import { ApiError } from "../_shared/errors.ts";
import {
  WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
  webCanonicalHashEnabled,
} from "../_shared/web_content_canonical.ts";
import {
  formatSocialBaselinePosts,
  scanSocialBaseline,
} from "../_shared/social_baseline.ts";
import templates from "../scout-templates/templates.json" with { type: "json" };

interface ScoutTemplate {
  slug: string;
  name: string;
  type: string;
  description: string;
  defaults: Record<string, unknown>;
  fields: Array<{
    key: string;
    label: string;
    required?: boolean;
    multiline?: boolean;
  }>;
  example_fill?: Record<string, unknown>;
}

const TEMPLATES = templates as ScoutTemplate[];

// Fields that are stored as TEXT[] in the scouts table. When the client sends
// these as a newline-separated string (e.g. via a <textarea>), split + trim.
const ARRAY_FIELDS = new Set(["tracked_urls", "priority_sources"]);

const FromTemplateSchema = z.object({
  template_slug: z.string(),
  name: z.string().min(1).max(200),
  fields: z.record(z.unknown()).default({}),
  project_id: z.string().uuid().nullable().optional(),
});

const ScoutType = z.enum(["web", "beat", "social", "civic", "transport"]);
// Sub-daily values are accepted by the enum but rejected for every type
// except transport via schedulePolicyError.
const Regularity = z.enum(["daily", "weekly", "monthly", "3h", "6h", "12h"]);
const TimeStr = z.string().regex(/^\d{1,2}:\d{2}$/);
const SocialPlatform = z.enum([
  "instagram",
  "x",
  "facebook",
  "tiktok",
  "linkedin",
]);
const SocialMonitorMode = z.enum(["summarize", "criteria"]);
const BaselinePostSchema = z.record(z.unknown());
const TopicSchema = z.string().max(200).superRefine((value, ctx) => {
  const tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (tags.length === 0) return;
  if (tags.length > 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "use at most 3 comma-separated topic tags",
    });
  }
  for (const tag of tags) {
    if (tag.length > 50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "each topic tag must be 50 characters or less; put longer context in description or criteria",
      });
      return;
    }
  }
});
const InitialPromiseSchema = z.object({
  promise_text: z.string().min(1).max(4000),
  context: z.string().max(8000).default(""),
  source_url: z.string().url().max(2000),
  source_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_confidence: z.enum(["high", "medium", "low"]),
  criteria_match: z.boolean(),
});

const CreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: ScoutType,
    description: z.string().max(2000).optional(),
    criteria: z.string().max(4000).optional(),
    topic: TopicSchema.optional(),
    url: z.string().url().max(2000).optional(),
    location: z.record(z.unknown()).optional(),
    source_mode: z.enum(["reliable", "niche"]).optional(),
    excluded_domains: z.array(z.string().max(253)).max(100).optional(),
    regularity: Regularity.optional(),
    schedule_cron: z.string().min(1).max(200).optional(),
    // Legacy schedule fields — server synthesises schedule_cron from these
    // when schedule_cron isn't provided.
    day_number: z.number().int().min(0).max(31).optional(),
    time: TimeStr.optional(),
    provider: z.string().max(100).optional(),
    project_id: z.string().uuid().optional(),
    priority_sources: z.array(z.string().max(500)).max(100).optional(),
    platform: SocialPlatform.optional(),
    profile_handle: z.string().min(1).max(200).optional(),
    monitor_mode: SocialMonitorMode.optional(),
    track_removals: z.boolean().optional(),
    // Page-archive gates (PAGE-ARCHIVE-PRD KTD5/KTD6). archive_enabled is
    // Pro/Team-gated at runtime via assertArchiveEntitled; wayback_enabled is
    // a per-scout opt-out from public Internet Archive submission.
    archive_enabled: z.boolean().optional(),
    wayback_enabled: z.boolean().optional(),
    baseline_posts: z.array(BaselinePostSchema).max(100).optional(),
    transport_baseline_ids: z.array(z.string().min(1).max(128))
      .max(MAX_TRANSPORT_BASELINE_IDS).optional(),
    root_domain: z.string().min(1).max(300).optional(),
    tracked_urls: z.array(z.string().url().max(2000)).min(1).max(20).optional(),
    initial_promises: z.array(InitialPromiseSchema).max(100).optional(),
    // Type-specific overflow config (scouts.config JSONB). Currently used by
    // transport scouts; validated per-type in superRefine.
    config: z.record(z.unknown()).optional(),
    // Extraction/notification language for this scout's runs. Workers fall
    // back to "en" when NULL. Missing from this schema until 2026-07-06 —
    // zod silently stripped it, every scout row stayed NULL, and ALL
    // extractions were forced English regardless of the user's language
    // (caught by the weekly page benchmark's language check).
    preferred_language: z
      .string()
      .regex(/^[a-zA-Z]{2}$/, "ISO 639-1 two-letter code")
      .transform((s) => s.toLowerCase())
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "web" && !v.url?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "required for web scouts",
      });
    }
    if (v.type === "social") {
      if (!v.platform) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["platform"],
          message: "required for social scouts",
        });
      }
      if (!v.profile_handle?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profile_handle"],
          message: "required for social scouts",
        });
      }
      if (v.monitor_mode === "criteria" && !v.criteria?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["criteria"],
          message: "required when monitor_mode is criteria",
        });
      }
      if (
        v.platform === "linkedin" && v.profile_handle &&
        isLinkedInCompanyUrl(v.profile_handle)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profile_handle"],
          message:
            "LinkedIn company pages are not supported — use a personal profile URL or handle (linkedin.com/in/...)",
        });
      } else if (
        v.platform === "linkedin" && v.profile_handle &&
        isInvalidLinkedInProfileUrl(v.profile_handle)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profile_handle"],
          message:
            "LinkedIn profile URLs must use a personal profile path (linkedin.com/in/...)",
        });
      }
    }
    // Transport scouts are scoped by config.geofence / config.watch_ids,
    // not by topic/location.
    if (v.type !== "transport" && !v.topic?.trim() && !v.location) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topic"],
        message:
          "required when location is not provided; use 1-3 short comma-separated tags",
      });
    }
    if (v.type === "transport") {
      const validated = validateTransportConfig(v.config ?? {});
      if (validated.config === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["config"],
          message: validated.error,
        });
      } else if (v.transport_baseline_ids) {
        const baselineError = validateTransportBaselineIds(
          validated.config,
          v.transport_baseline_ids,
        );
        if (baselineError) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["transport_baseline_ids"],
            message: baselineError,
          });
        }
      }
    } else if (v.config && Object.keys(v.config).length > 0) {
      // Keep config write-gated: only transport defines a validated shape.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config"],
        message: "config is only supported for transport scouts",
      });
    }
    if (v.type !== "transport" && v.transport_baseline_ids !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transport_baseline_ids"],
        message:
          "transport_baseline_ids is only supported for transport scouts",
      });
    }
    if (v.type === "civic") {
      if (!v.root_domain?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["root_domain"],
          message: "required for civic scouts",
        });
      }
      if (!v.tracked_urls?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tracked_urls"],
          message: "required for civic scouts",
        });
      }
    }
    const scheduleError = schedulePolicyError(
      v.type,
      v.regularity,
      undefined,
      typeof v.config?.mode === "string" ? v.config.mode : undefined,
    );
    if (scheduleError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regularity"],
        message: scheduleError,
      });
    }
  });

const UpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    type: ScoutType.optional(),
    description: z.string().max(2000).nullable().optional(),
    criteria: z.string().max(4000).nullable().optional(),
    topic: TopicSchema.nullable().optional(),
    url: z.string().url().max(2000).nullable().optional(),
    location: z.record(z.unknown()).nullable().optional(),
    source_mode: z.enum(["reliable", "niche"]).nullable().optional(),
    excluded_domains: z.array(z.string().max(253)).max(100).nullable()
      .optional(),
    regularity: Regularity.nullable().optional(),
    schedule_cron: z.string().min(1).max(200).nullable().optional(),
    day_number: z.number().int().min(0).max(31).optional(),
    time: TimeStr.optional(),
    provider: z.string().max(100).nullable().optional(),
    project_id: z.string().uuid().nullable().optional(),
    priority_sources: z.array(z.string().max(500)).max(100).nullable()
      .optional(),
    is_active: z.boolean().optional(),
    platform: SocialPlatform.nullable().optional(),
    profile_handle: z.string().max(200).nullable().optional(),
    monitor_mode: SocialMonitorMode.nullable().optional(),
    track_removals: z.boolean().optional(),
    archive_enabled: z.boolean().optional(),
    wayback_enabled: z.boolean().optional(),
    root_domain: z.string().max(300).nullable().optional(),
    tracked_urls: z.array(z.string().url().max(2000)).max(20).nullable()
      .optional(),
    config: z.record(z.unknown()).optional(),
    preferred_language: z
      .string()
      .regex(/^[a-zA-Z]{2}$/, "ISO 639-1 two-letter code")
      .transform((s) => s.toLowerCase())
      .nullable()
      .optional(),
  })
  .superRefine((v, ctx) => {
    const scheduleError = schedulePolicyError(v.type, v.regularity);
    if (scheduleError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regularity"],
        message: scheduleError,
      });
    }
  });

/** Derive a cron expression from the legacy (regularity, day_number, time)
 *  triple the UI's "Set Up Page Scout" modal still sends. day_number is
 *  1=Mon..7=Sun for weekly, 1..31 for monthly, ignored for daily.
 *  Returns null if inputs are insufficient. */
function cronFromParts(
  regularity: string | undefined,
  day: number | undefined,
  time: string | undefined,
): string | null {
  if (!regularity || !time) return null;
  const [hh, mm] = time.split(":").map((s) => parseInt(s, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  switch (regularity) {
    case "daily":
      return `${mm} ${hh} * * *`;
    case "weekly": {
      // day_number 1=Mon..7=Sun → cron 0=Sun..6=Sat (so 7→0).
      const d = day ?? 1;
      const cronDay = d === 7 ? 0 : d;
      return `${mm} ${hh} * * ${cronDay}`;
    }
    case "monthly":
      return `${mm} ${hh} ${day ?? 1} * *`;
    default:
      // Transport sub-daily regularities (3h/6h/12h) anchor to the chosen time.
      return subDailyCronFromParts(regularity, time);
  }
}

Deno.serve(async (req): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  let user: AuthedUser;
  try {
    user = await requireUserOrApiKey(req);
  } catch (e) {
    return jsonFromError(e);
  }

  const url = new URL(req.url);
  // Trim the "/scouts" prefix Kong leaves on the path. "/scouts" -> "",
  // "/scouts/<id>" -> "/<id>", "/scouts/<id>/run" -> "/<id>/run".
  const path = url.pathname.replace(/^.*\/scouts/, "") || "/";
  const idMatch = path.match(/^\/([0-9a-f-]{36})$/i);
  const idActionMatch = path.match(/^\/([0-9a-f-]{36})\/(run|pause|resume)$/i);
  const isRead = req.method === "GET" || req.method === "HEAD";

  try {
    if (path === "/" && isRead) {
      return await listScouts(req, user);
    }
    if (path === "/" && req.method === "POST") {
      return await createScout(req, user);
    }
    if (path === "/from-template" && req.method === "POST") {
      return await createScoutFromTemplate(req, user);
    }
    if (path === "/test" && req.method === "POST") {
      return await testScout(req, user);
    }
    if (idMatch && isRead) {
      return await getScout(user, idMatch[1]);
    }
    if (idMatch && req.method === "PATCH") {
      return await updateScout(req, user, idMatch[1]);
    }
    if (idMatch && req.method === "DELETE") {
      return await deleteScout(user, idMatch[1]);
    }
    if (idActionMatch && req.method === "POST") {
      const [, id, action] = idActionMatch;
      if (action === "run") return await runScout(user, id);
      if (action === "pause") return await pauseScout(user, id);
      if (action === "resume") return await resumeScout(user, id);
    }
    return jsonError("method not allowed", 405);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "scouts",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

async function listScouts(req: Request, user: AuthedUser): Promise<Response> {
  const url = new URL(req.url);
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10),
  );
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)),
  );
  const typeParam = url.searchParams.get("type");
  let typeFilter: z.infer<typeof ScoutType> | null = null;
  if (typeParam !== null && typeParam !== "") {
    const parsedType = ScoutType.safeParse(typeParam);
    if (!parsedType.success) {
      throw new ValidationError("invalid scout type filter");
    }
    typeFilter = parsedType.data;
  }

  const { db } = getCallerClient(user);
  let query = db
    .from("scouts")
    .select("*", { count: "exact" })
    .eq("user_id", user.id);
  if (typeFilter) {
    query = query.eq("type", typeFilter);
  }
  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);

  const shaped = await Promise.all(
    (data ?? []).map((row) => shapeScoutResponse(db, row)),
  );
  return jsonPaginated(shaped, count ?? 0, offset, limit);
}

async function scheduleScoutOrThrow(
  svc: ReturnType<typeof getServiceClient>,
  scoutId: string,
  cronExpr: string,
  userId: string,
): Promise<void> {
  const { error } = await svc.rpc("schedule_scout", {
    p_scout_id: scoutId,
    p_cron_expr: cronExpr,
  });
  if (!error) return;
  logEvent({
    level: "error",
    fn: "scouts",
    event: "schedule_failed",
    user_id: userId,
    scout_id: scoutId,
    msg: error.message,
  });
  throw new Error(`failed to schedule scout: ${error.message}`);
}

async function unscheduleScoutOrThrow(
  svc: ReturnType<typeof getServiceClient>,
  scoutId: string,
  userId: string,
): Promise<void> {
  const { error } = await svc.rpc("unschedule_scout", {
    p_scout_id: scoutId,
  });
  if (!error) return;
  logEvent({
    level: "error",
    fn: "scouts",
    event: "unschedule_failed",
    user_id: userId,
    scout_id: scoutId,
    msg: error.message,
  });
  throw new Error(`failed to unschedule scout: ${error.message}`);
}

async function rollbackScoutUpdate(
  svc: ReturnType<typeof getServiceClient>,
  scoutId: string,
  userId: string,
  current: Record<string, unknown>,
  attempted: Record<string, unknown>,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(attempted)) {
    patch[key] = current[key] ?? null;
  }
  if (Object.keys(patch).length === 0) return;

  const { error } = await svc.from("scouts").update(patch).eq("id", scoutId);
  if (error) {
    logEvent({
      level: "error",
      fn: "scouts",
      event: "rollback_failed",
      user_id: userId,
      scout_id: scoutId,
      msg: error.message,
    });
  }
}

async function rollbackCreatedScout(
  svc: ReturnType<typeof getServiceClient>,
  scoutId: string,
  userId: string,
): Promise<void> {
  const { error } = await svc.from("scouts").delete().eq("id", scoutId);
  if (error) {
    logEvent({
      level: "error",
      fn: "scouts",
      event: "rollback_failed",
      user_id: userId,
      scout_id: scoutId,
      msg: error.message,
      rollback_action: "delete_created_scout",
    });
  }
}

/** Pre-parse normalisation: accept legacy field aliases the v1 UI still
 *  sends (`scout_type` → `type`). Also coerces `day_number` from string
 *  if it arrived that way. Doesn't validate — that's zod's job. */
function normalizeScoutBody(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  if (out.type === undefined && typeof out.scout_type === "string") {
    out.type = out.scout_type;
  }
  delete out.scout_type;
  if (out.type === "pulse") {
    out.type = "beat";
  }
  if (typeof out.day_number === "string") {
    const n = parseInt(out.day_number, 10);
    if (!Number.isNaN(n)) out.day_number = n;
  }
  if (
    typeof out.profile_handle === "string" && typeof out.platform === "string"
  ) {
    const platform = out.platform;
    if (
      platform === "instagram" || platform === "x" || platform === "facebook" ||
      platform === "tiktok" || platform === "linkedin"
    ) {
      out.profile_handle = normalizeSocialHandle(platform, out.profile_handle);
    }
  }
  if (typeof out.root_domain === "string") {
    out.root_domain = out.root_domain
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
  }
  if (typeof out.topic === "string") {
    out.topic = out.topic
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .join(", ");
  }
  if (typeof out.description === "string") {
    out.description = out.description.trim();
  }
  return out;
}

// Two 463 km (250 nm) ADS-B query tiles — the creation-time bound that keeps
// aircraft-mode geofences coverable by a handful of adsb.lol point queries.
const AIRCRAFT_MAX_PRESET_DIMENSION_KM = 926;

/** Resolve a transport geofence preset: it must exist, and for aircraft mode
 * its bbox must fit the ADS-B tiling budget. No-op for circle geofences. */
async function ensureTransportPresetValid(
  svc: ReturnType<typeof getServiceClient>,
  config: TransportConfig,
): Promise<void> {
  const presetId = config.geofence?.preset_id?.trim();
  if (!presetId) return;
  const { data, error } = await svc
    .from("transport_geofence_presets")
    .select("id, min_lat, min_lon, max_lat, max_lon")
    .eq("id", presetId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw new ValidationError(`unknown geofence preset: ${presetId}`);
  }
  if (config.mode === "aircraft") {
    const heightKm = (data.max_lat - data.min_lat) * 111;
    const midLat = (data.max_lat + data.min_lat) / 2;
    const widthKm = Math.abs(
      (data.max_lon - data.min_lon) * 111 * Math.cos(midLat * Math.PI / 180),
    );
    if (Math.max(heightKm, widthKm) > AIRCRAFT_MAX_PRESET_DIMENSION_KM) {
      throw new ValidationError(
        `preset ${presetId} is too large for aircraft mode (ADS-B query tiling cap)`,
      );
    }
  }
}

function validateTopicAndScope(payload: Record<string, unknown>): void {
  const topic = typeof payload.topic === "string" ? payload.topic : "";
  if (topic) {
    const topicResult = TopicSchema.safeParse(topic);
    if (!topicResult.success) {
      throw new ValidationError(
        topicResult.error.issues.map((i) => i.message).join("; "),
      );
    }
  }
  if (!topic.trim() && !payload.location) {
    throw new ValidationError(
      "scouts require either location or 1-3 short topic tags",
    );
  }
}

function needsScheduledBaseline(scout: BaselineableScout): boolean {
  return ["web", "beat", "social", "civic"].includes(scout.type);
}

function normalizeTrackedUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, CIVIC_BASELINE_MAX_TRACKED);
}

async function stampBaseline(
  svc: ReturnType<typeof getServiceClient>,
  scoutId: string,
  patch: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await svc
    .from("scouts")
    .update({
      baseline_established_at: new Date().toISOString(),
      ...patch,
    })
    .eq("id", scoutId);
  if (error) throw new Error(error.message);
}

async function seedTransportBaseline(
  svc: ReturnType<typeof getServiceClient>,
  scoutId: string,
  userId: string,
  baselineIds: string[] | undefined,
): Promise<string | null> {
  // `undefined` is the legacy/non-preview path: leave the scout unstamped so
  // its first scheduled run establishes a silent baseline. An explicit empty
  // array is a valid live-test result for a quiet area and must still stamp the
  // baseline, otherwise the next run could silently absorb real entrants.
  if (baselineIds === undefined) return null;
  const observedAt = new Date().toISOString();
  const rows = buildTransportBaselineRows(
    scoutId,
    userId,
    baselineIds,
    observedAt,
  );
  if (rows.length > 0) {
    const { error } = await svc.from("transport_scout_state").insert(rows);
    if (error) throw new Error(error.message);
  }
  await stampBaseline(svc, scoutId, {
    baseline_established_at: observedAt,
  });
  return observedAt;
}

async function establishCivicBaseline(
  svc: ReturnType<typeof getServiceClient>,
  scout: BaselineableScout,
): Promise<void> {
  const tracked = normalizeTrackedUrls(scout.tracked_urls);
  if (tracked.length === 0) {
    throw new ValidationError(
      "civic scouts require tracked_urls before scheduling",
    );
  }

  // Write a canonical-hash baseline per tracked URL with NO scout_run_id, so
  // the first scheduled run finds an immediately-usable baseline to diff
  // against (schedule-time inserts are always usable). Mirrors
  // establishWebBaseline; replaces the retired Firecrawl changeTracking prime.
  //
  // Empty markdown is NON-FATAL: the retired changeTracking prime never
  // checked content, so a tracked page that renders empty markdown (image/JS
  // pages, or onlyMainContent stripping everything) must not block scout
  // creation. Skip its baseline — at run time an empty page classifies "new"
  // and is processed via its rawHtml link extraction, exactly as before.
  //
  // Viability, however, IS enforced: if not a single tracked URL is reachable
  // (all scrapes threw or every page returned a 4xx/5xx error status), the
  // scout is dead-on-arrival — refuse to stamp a functionless baseline and
  // surface the bad URLs to the user at creation time.
  let reachedCount = 0;
  for (const url of tracked) {
    let scraped;
    try {
      scraped = await scrape(url, {
        formats: ["markdown"],
        onlyMainContent: true,
      });
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "scouts",
        event: "civic_baseline_scrape_failed",
        scout_id: scout.id,
        url,
        msg: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    // An error-status target (both providers return HTTP 200 with the error
    // page's body and the target's real status in status_code) must never be
    // baselined — the error page's content would poison the first run's diff.
    // It also does not count toward reachability: a scout whose every tracked
    // URL is an error page cannot function.
    const status = scraped.status_code;
    if (typeof status === "number" && status >= 400) {
      logEvent({
        level: "warn",
        fn: "scouts",
        event: "civic_baseline_error_status",
        scout_id: scout.id,
        url,
        upstream_status: status,
      });
      continue;
    }
    reachedCount += 1;
    const markdown = scraped.markdown ?? "";
    if (!markdown.trim()) {
      logEvent({
        level: "warn",
        fn: "scouts",
        event: "civic_baseline_empty_content",
        scout_id: scout.id,
        url,
      });
      continue;
    }
    await writeCanonicalBaseline(svc, {
      userId: scout.user_id,
      scoutId: scout.id,
      sourceUrl: url,
      markdown,
    });
  }
  if (reachedCount === 0) {
    throw new ValidationError(
      "could not reach any civic tracked URL (all failed to scrape or " +
        "returned an error status); check the URLs before scheduling",
    );
  }
}

/**
 * KTD6 tier gate on create/update: a SaaS free-tier user may not enable
 * archiving. OSS (credits disabled) allows it for everyone. Mirrors the
 * runtime gate in snapshot_capture.resolveArchiveGate — both read the
 * user_preferences.tier mirror. Only enforced when the caller is turning the
 * flag ON (turning it off, or omitting it, is always allowed). Denies with 403.
 *
 * Fails CLOSED on a tier-read error (same posture as resolveArchiveGate, which
 * returns false): a transient user_preferences read blip must not 500 and
 * block scout creation — it denies the archive flag with the normal 403. The
 * runtime capture gate re-checks tier on every run, so this is only the
 * early-UX guard, not the sole enforcement.
 */
async function assertArchiveEntitled(
  svc: ReturnType<typeof getServiceClient>,
  userId: string,
  archiveEnabled: boolean | undefined,
): Promise<void> {
  if (archiveEnabled !== true) return;
  if (!creditsEnabled()) return;
  const { data, error } = await svc
    .from("user_preferences")
    .select("tier")
    .eq("user_id", userId)
    .maybeSingle();
  // A read error leaves tier undefined → falls through to the 403 deny below
  // (fail closed), rather than throwing a 500 that aborts the whole request.
  if (error) {
    logEvent({
      level: "warn",
      fn: "scouts",
      event: "archive_entitlement_tier_read_failed",
      user_id: userId,
      msg: error.message,
    });
  }
  const tier = error ? undefined : (data as { tier?: string } | null)?.tier;
  if (tier !== "pro" && tier !== "team") {
    throw new ApiError(
      "Evidence archiving is a Pro/Team feature — upgrade to enable snapshots for this scout.",
      403,
      "archive_forbidden",
    );
  }
}

async function ensureScheduledBaseline(
  svc: ReturnType<typeof getServiceClient>,
  scout: BaselineableScout,
): Promise<void> {
  if (!needsScheduledBaseline(scout) || scout.baseline_established_at) return;
  if (scout.type === "web") {
    await ensureWebBaseline(svc, scout);
    return;
  }
  if (scout.type === "social") {
    if (!scout.platform || !scout.profile_handle) {
      throw new ValidationError(
        "social scouts require platform and profile_handle before scheduling",
      );
    }
    await ensureSocialBaseline(
      svc,
      scout.id,
      scout.user_id,
      scout.platform,
      scout.profile_handle,
    );
    return;
  }
  if (scout.type === "beat") {
    // Beat baseline runs the full 8-stage discovery pipeline and routinely
    // exceeds the synchronous-fetch budget between Edge Functions, surfacing
    // to clients as a 502 even though the scout row was already committed.
    // Kick it off in the background — scheduleBaselineAsync uses
    // EdgeRuntime.waitUntil so the create response returns immediately. If the
    // background baseline fails, repairMissingBeatBaseline on the next
    // scheduled run recovers from the first successful scrape.
    scheduleBeatBaselineInBackground(scout.id);
    return;
  }
  await establishCivicBaseline(svc, scout);
  await stampBaseline(svc, scout.id);
}

// EdgeRuntime is a Supabase Edge Functions global. Typed locally so callers
// don't see `any` and so tests can mock it. Falls back to synchronous fetch
// when the runtime global isn't present (deno test, self-host without the
// supabase wrapper).
declare const EdgeRuntime:
  | {
    waitUntil(promise: Promise<unknown>): void;
  }
  | undefined;

function scheduleBeatBaselineInBackground(scoutId: string): void {
  const work = establishBeatBaseline(scoutId).catch((err) => {
    logEvent({
      level: "warn",
      fn: "scouts",
      event: "beat_baseline_background_failed",
      scout_id: scoutId,
      msg: err instanceof Error ? err.message : String(err),
    });
  });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(work);
  }
  // Outside Supabase (tests, self-host without EdgeRuntime): we fire the
  // promise but don't await — same fire-and-forget semantics, callers don't
  // block. The catch above prevents an unhandled rejection.
}

async function establishBeatBaseline(scoutId: string): Promise<void> {
  const res = await fetch(
    `${getSupabaseUrl().replace(/\/$/, "")}/functions/v1/scout-beat-execute`,
    {
      method: "POST",
      headers: {
        ...internalServiceAuthHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scout_id: scoutId, baseline_only: true }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `unable to establish beat baseline: ${res.status} ${text}`.slice(
        0,
        1000,
      ),
    );
  }
}

async function seedSocialBaseline(
  svc: ReturnType<typeof getServiceClient>,
  scoutId: string,
  userId: string,
  platform: z.infer<typeof SocialPlatform>,
  handle: string,
  posts: Array<Record<string, unknown>>,
): Promise<void> {
  const normalizedPosts = posts
    .map((post) => {
      const id = typeof post.id === "string" && post.id.trim()
        ? post.id.trim()
        : typeof post.post_id === "string" && post.post_id.trim()
        ? post.post_id.trim()
        : typeof post.url === "string" && post.url.trim()
        ? post.url.trim()
        : null;
      return id ? { ...post, id, post_id: id } : null;
    })
    .filter((post): post is Record<string, unknown> & {
      id: string;
      post_id: string;
    } => Boolean(post));
  if (posts.length > 0 && normalizedPosts.length === 0) {
    throw new ValidationError(
      "baseline_posts must include id, post_id, or url for each post",
    );
  }
  const { error } = await svc.from("post_snapshots").upsert({
    scout_id: scoutId,
    user_id: userId,
    platform,
    handle,
    post_count: normalizedPosts.length,
    posts: normalizedPosts,
    updated_at: new Date().toISOString(),
  }, { onConflict: "scout_id" });
  if (error) throw new Error(error.message);
  await stampBaseline(svc, scoutId);
}

async function ensureSocialBaseline(
  svc: ReturnType<typeof getServiceClient>,
  scoutId: string,
  userId: string,
  platform: z.infer<typeof SocialPlatform>,
  handle: string,
  baselinePosts?: Array<Record<string, unknown>>,
): Promise<void> {
  if (Array.isArray(baselinePosts) && baselinePosts.length > 0) {
    await seedSocialBaseline(
      svc,
      scoutId,
      userId,
      platform,
      handle,
      baselinePosts,
    );
    return;
  }

  const scan = await scanSocialBaseline(platform, handle);
  await seedSocialBaseline(
    svc,
    scoutId,
    userId,
    platform,
    handle,
    formatSocialBaselinePosts(scan.posts),
  );
}

async function seedInitialPromises(
  svc: ReturnType<typeof getServiceClient>,
  scoutId: string,
  userId: string,
  promises: Array<z.infer<typeof InitialPromiseSchema>>,
): Promise<void> {
  if (promises.length === 0) return;
  const rows = promises.map((promise) => ({
    scout_id: scoutId,
    user_id: userId,
    promise_text: promise.promise_text,
    context: promise.context,
    source_url: promise.source_url,
    meeting_date: promise.source_date,
    due_date: promise.due_date ?? null,
    date_confidence: promise.date_confidence,
  }));
  const { error } = await svc.from("promises").insert(rows);
  if (error) throw new Error(error.message);
}

async function createScout(req: Request, user: AuthedUser): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = CreateSchema.safeParse(normalizeScoutBody(body));
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(
        "; ",
      ),
    );
  }

  // KTD6: a free-tier SaaS user may not enable archiving. Checked before the
  // insert so the scout is never created with a flag the user can't hold.
  await assertArchiveEntitled(
    getServiceClient(),
    user.id,
    parsed.data.archive_enabled,
  );

  // Strip legacy schedule fields; synthesise schedule_cron from them when
  // the client didn't provide one explicitly.
  const {
    schedule_cron: explicitCron,
    time,
    day_number,
    baseline_posts,
    transport_baseline_ids,
    initial_promises,
    ...rest
  } = parsed.data;
  const schedule_cron = explicitCron ??
    cronFromParts(rest.regularity, day_number, time);
  const scheduleError = schedulePolicyError(
    rest.type,
    rest.regularity,
    schedule_cron,
    typeof rest.config?.mode === "string" ? rest.config.mode : undefined,
  );
  if (scheduleError) throw new ValidationError(scheduleError);

  // Persist the NORMALIZED transport config (lowercased watch ids, trimmed
  // criteria, unknown keys stripped), not the raw request record, and verify
  // any named preset actually exists before committing the scout.
  if (rest.type === "transport") {
    const validated = validateTransportConfig(rest.config ?? {});
    if (validated.config === null) {
      throw new ValidationError(validated.error);
    }
    rest.config = validated.config as Record<string, unknown>;
    await ensureTransportPresetValid(getServiceClient(), validated.config);
    await assertTransportEntitled(getServiceClient(), user.id);
  }

  // Default the scout's language from the owner's profile preference when the
  // request doesn't set one — otherwise workers force "en" for everyone.
  if (!rest.preferred_language) {
    const { data: prefs } = await getServiceClient()
      .from("user_preferences")
      .select("preferred_language")
      .eq("user_id", user.id)
      .maybeSingle();
    if (
      typeof prefs?.preferred_language === "string" && prefs.preferred_language
    ) {
      rest.preferred_language = prefs.preferred_language;
    }
  }

  const { db } = getCallerClient(user);
  const { data, error } = await db
    .from("scouts")
    .insert({
      ...rest,
      schedule_cron: schedule_cron ?? null,
      user_id: user.id,
      is_active: schedule_cron ? true : false,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new ConflictError("scout name already exists");
    }
    throw new Error(error.message);
  }

  if (schedule_cron) {
    const svc = getServiceClient();
    const baselineScout: BaselineableScout = {
      ...(data as BaselineableScout),
      tracked_urls: rest.type === "civic"
        ? rest.tracked_urls ?? data.tracked_urls
        : data.tracked_urls,
    };
    try {
      if (data.type === "social" && data.platform && data.profile_handle) {
        await ensureSocialBaseline(
          svc,
          data.id,
          user.id,
          data.platform as z.infer<typeof SocialPlatform>,
          data.profile_handle,
          baseline_posts,
        );
        baselineScout.baseline_established_at = new Date().toISOString();
      }
      if (
        data.type === "civic" && Array.isArray(initial_promises) &&
        initial_promises.length > 0
      ) {
        await seedInitialPromises(svc, data.id, user.id, initial_promises);
      }
      if (data.type === "transport") {
        const establishedAt = await seedTransportBaseline(
          svc,
          data.id,
          user.id,
          transport_baseline_ids,
        );
        if (establishedAt) {
          baselineScout.baseline_established_at = establishedAt;
          data.baseline_established_at = establishedAt;
        }
      }
    } catch (e) {
      await rollbackCreatedScout(svc, data.id, user.id);
      throw e;
    }
    if (needsScheduledBaseline(baselineScout)) {
      try {
        await ensureScheduledBaseline(svc, baselineScout);
      } catch (e) {
        await rollbackCreatedScout(svc, data.id, user.id);
        throw e;
      }
    }
    try {
      await scheduleScoutOrThrow(svc, data.id, schedule_cron, user.id);
    } catch (e) {
      await rollbackCreatedScout(svc, data.id, user.id);
      throw e;
    }
  } else {
    const svc = getServiceClient();
    try {
      if (
        data.type === "social" &&
        data.platform &&
        data.profile_handle
      ) {
        await ensureSocialBaseline(
          svc,
          data.id,
          user.id,
          data.platform as z.infer<typeof SocialPlatform>,
          data.profile_handle,
          baseline_posts,
        );
        data.baseline_established_at = new Date().toISOString();
      }
      if (
        data.type === "civic" && Array.isArray(initial_promises) &&
        initial_promises.length > 0
      ) {
        await seedInitialPromises(svc, data.id, user.id, initial_promises);
      }
      if (data.type === "transport") {
        const establishedAt = await seedTransportBaseline(
          svc,
          data.id,
          user.id,
          transport_baseline_ids,
        );
        if (establishedAt) data.baseline_established_at = establishedAt;
      }
    } catch (e) {
      await rollbackCreatedScout(svc, data.id, user.id);
      throw e;
    }
  }

  // Baseline snapshot capture (PAGE-ARCHIVE-PRD R4) — fired in the background
  // AFTER the scout is committed and scheduled, off the create critical path:
  // a capture fetch can take tens of seconds, and web baselines are already
  // established synchronously above. Best-effort and self-gated on the archive
  // toggle + tier (captureWebBaselineSnapshot re-checks). Only for scheduled
  // web scouts, mirroring where the change-detection baseline is established.
  if (schedule_cron && data.type === "web" && data.archive_enabled) {
    runSnapshotInBackground(
      captureWebBaselineSnapshot(getServiceClient(), {
        id: data.id,
        user_id: user.id,
        url: data.url,
        provider: data.provider,
        archive_enabled: data.archive_enabled,
        wayback_enabled: data.wayback_enabled,
        name: data.name,
      }),
    );
  }

  logEvent({
    level: "info",
    fn: "scouts",
    event: "created",
    user_id: user.id,
    scout_id: data.id,
  });

  const shaped = await shapeScoutResponse(db, data);
  return jsonOk(shaped, 201);
}

async function getScout(user: AuthedUser, id: string): Promise<Response> {
  const { db } = getCallerClient(user);
  const { data, error } = await db
    .from("scouts")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("scout");
  return jsonOk(await shapeScoutResponse(db, data));
}

async function updateScout(
  req: Request,
  user: AuthedUser,
  id: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = UpdateSchema.safeParse(normalizeScoutBody(body));
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(
        "; ",
      ),
    );
  }
  // Synthesize schedule_cron from legacy fields if explicit one not given.
  const { time, day_number, ...rest } = parsed.data;
  if (
    rest.schedule_cron === undefined &&
    (time !== undefined || day_number !== undefined)
  ) {
    const synth = cronFromParts(rest.regularity ?? undefined, day_number, time);
    if (synth) rest.schedule_cron = synth;
  }
  if (Object.keys(rest).length === 0) {
    throw new ValidationError("no updatable fields provided");
  }
  // Replace parsed.data so the rest of the function sees the cleaned shape.
  (parsed as { data: typeof rest }).data = rest;

  const { db } = getCallerClient(user);
  // Fetch current row so we can diff schedule / is_active
  const { data: current, error: readErr } = await db
    .from("scouts")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!current) throw new NotFoundError("scout");

  // Transport criteria live in config so the executor can apply them only to
  // newly claimed entrants. Preserve generic clients' existing --criteria
  // PATCH shape by translating it during the compatibility window.
  if (
    current.type === "transport" &&
    Object.prototype.hasOwnProperty.call(parsed.data, "criteria") &&
    parsed.data.config === undefined
  ) {
    const currentConfig = current.config as Record<string, unknown> | null;
    if (!currentConfig) {
      throw new ValidationError("transport scout is missing config");
    }
    const legacyCriteria = parsed.data.criteria;
    const translatedConfig: Record<string, unknown> = { ...currentConfig };
    if (legacyCriteria === null) {
      delete translatedConfig.criteria;
    } else {
      translatedConfig.criteria = legacyCriteria;
    }
    (parsed.data as { config?: Record<string, unknown> }).config =
      translatedConfig;
    delete (parsed.data as Record<string, unknown>).criteria;
  }

  // KTD6: a free-tier SaaS user may not switch archiving on. Turning it off or
  // leaving it unchanged is always allowed (evidence is never destroyed by a
  // plan change — existing snapshots stay readable; captures just stop).
  await assertArchiveEntitled(
    getServiceClient(),
    user.id,
    (parsed.data as { archive_enabled?: boolean }).archive_enabled,
  );

  const nextScout = { ...current, ...parsed.data } as BaselineableScout & {
    schedule_cron?: string | null;
    regularity?: string | null;
    is_active?: boolean | null;
    topic?: string | null;
    location?: Record<string, unknown> | null;
    config?: Record<string, unknown> | null;
    criteria?: string | null;
    monitor_mode?: z.infer<typeof SocialMonitorMode> | null;
    platform?: z.infer<typeof SocialPlatform> | null;
    profile_handle?: string | null;
  };
  if (nextScout.type === "social") {
    if (
      nextScout.monitor_mode === "criteria" &&
      !nextScout.criteria?.trim()
    ) {
      throw new ValidationError(
        "criteria is required when monitor_mode is criteria",
      );
    }
    if (
      nextScout.platform === "linkedin" && nextScout.profile_handle &&
      isLinkedInCompanyUrl(nextScout.profile_handle)
    ) {
      throw new ValidationError(
        "LinkedIn company pages are not supported — use a personal profile URL or handle (linkedin.com/in/...)",
      );
    }
    if (
      nextScout.platform === "linkedin" && nextScout.profile_handle &&
      isInvalidLinkedInProfileUrl(nextScout.profile_handle)
    ) {
      throw new ValidationError(
        "LinkedIn profile URLs must use a personal profile path (linkedin.com/in/...)",
      );
    }
    if (
      nextScout.platform && nextScout.profile_handle &&
      Object.prototype.hasOwnProperty.call(parsed.data, "profile_handle")
    ) {
      const normalizedHandle = normalizeSocialHandle(
        nextScout.platform,
        nextScout.profile_handle,
      );
      parsed.data.profile_handle = normalizedHandle;
      nextScout.profile_handle = normalizedHandle;
    }
  }
  if (
    nextScout.type !== "transport" && !nextScout.topic?.trim() &&
    !nextScout.location
  ) {
    throw new ValidationError(
      "scouts require either location or 1-3 short topic tags",
    );
  }
  let nextTransportMode: string | undefined;
  if (nextScout.type === "transport") {
    const validated = validateTransportConfig(nextScout.config ?? {});
    if (validated.config === null) throw new ValidationError(validated.error);
    nextTransportMode = validated.config.mode;
    if (parsed.data.config !== undefined) {
      // Write back the normalized form, mirroring createScout.
      (parsed.data as { config?: Record<string, unknown> }).config = validated
        .config as Record<string, unknown>;
      await assertTransportEntitled(getServiceClient(), user.id);
    }
    await ensureTransportPresetValid(getServiceClient(), validated.config);
  } else if (
    parsed.data.config && Object.keys(parsed.data.config).length > 0
  ) {
    throw new ValidationError("config is only supported for transport scouts");
  }
  // A regularity-only PATCH must resynthesize the cron — otherwise the old
  // cadence keeps firing while the scout reports the new one.
  if (
    typeof parsed.data.regularity === "string" &&
    parsed.data.schedule_cron === undefined &&
    typeof current.schedule_cron === "string" && current.schedule_cron &&
    parsed.data.regularity !== current.regularity
  ) {
    const anchor = deriveScheduleAnchor(current.schedule_cron);
    const synth = anchor
      ? cronFromParts(parsed.data.regularity, anchor.day, anchor.time)
      : null;
    if (!synth) {
      throw new ValidationError(
        "changing regularity requires time (and day for weekly/monthly) so the schedule can be resynthesized",
      );
    }
    parsed.data.schedule_cron = synth;
    nextScout.schedule_cron = synth;
  }
  const nextHasWebUrl = typeof nextScout.url === "string" &&
    nextScout.url.trim().length > 0;
  const nextIsScheduled = nextScout.is_active === true ||
    (typeof nextScout.schedule_cron === "string" &&
      nextScout.schedule_cron.length > 0);
  if (nextScout.type === "web" && !nextHasWebUrl && nextIsScheduled) {
    throw new ValidationError(
      "web scouts require url before they can be active or scheduled",
    );
  }
  const scheduleError = schedulePolicyError(
    nextScout.type,
    nextScout.regularity ?? undefined,
    nextScout.schedule_cron ?? undefined,
    nextTransportMode,
  );
  if (scheduleError) throw new ValidationError(scheduleError);
  const willBeActive = nextScout.is_active === true;
  const willHaveSchedule = typeof nextScout.schedule_cron === "string" &&
    nextScout.schedule_cron.length > 0;
  // An active scout must have a schedule (DB constraint chk_active_has_schedule).
  // Reject the under-specified case with a clear 400 instead of letting the
  // write fail with a raw 500 — e.g. `regularity` without a `time` can't
  // synthesise a cron, so `--active true` alone would violate the constraint.
  if (willBeActive && !willHaveSchedule) {
    throw new ValidationError(
      "cannot activate a scout without a schedule; set schedule_cron, " +
        "or regularity together with a time",
    );
  }
  if (willBeActive && willHaveSchedule) {
    await ensureScheduledBaseline(getServiceClient(), nextScout);
  }

  const { data, error } = await db
    .from("scouts")
    .update(parsed.data)
    .eq("id", id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      throw new ConflictError("scout name already exists");
    }
    throw new Error(error.message);
  }
  if (!data) throw new NotFoundError("scout");

  const svc = getServiceClient();
  const cronChanged =
    Object.prototype.hasOwnProperty.call(parsed.data, "schedule_cron") &&
    parsed.data.schedule_cron !== current.schedule_cron;
  const activeChanged =
    Object.prototype.hasOwnProperty.call(parsed.data, "is_active") &&
    parsed.data.is_active !== current.is_active;

  // Reconcile the pg_cron job with the scout's next state. Covers pause,
  // reactivation, and cron changes (see resolveScheduleAction).
  const scheduleAction = resolveScheduleAction({
    activeChanged,
    cronChanged,
    willBeActive,
    hasSchedule: willHaveSchedule,
  });
  try {
    if (scheduleAction === "schedule") {
      await scheduleScoutOrThrow(
        svc,
        id,
        nextScout.schedule_cron as string,
        user.id,
      );
    } else if (scheduleAction === "unschedule") {
      await unscheduleScoutOrThrow(svc, id, user.id);
    }
  } catch (e) {
    await rollbackScoutUpdate(svc, id, user.id, current, parsed.data);
    throw e;
  }

  // Baseline snapshot on enable-later (PAGE-ARCHIVE-PRD R4): before this hook,
  // turning archiving on via PATCH captured nothing until the next page change,
  // so a static page stayed snapshot-less with archiving "on" and the pre-change
  // state of the first change was never archived. Mirrors createScout: fire the
  // background capture only on the false→true transition of a scheduled web
  // scout — captureWebBaselineSnapshot re-checks the gate + tier and never
  // throws, so this stays off the update critical path.
  const archiveTurnedOn = parsed.data.archive_enabled === true &&
    current.archive_enabled !== true;
  if (archiveTurnedOn && data.type === "web" && willHaveSchedule) {
    runSnapshotInBackground(
      captureWebBaselineSnapshot(svc, {
        id: data.id,
        user_id: user.id,
        url: data.url,
        provider: data.provider,
        archive_enabled: data.archive_enabled,
        wayback_enabled: data.wayback_enabled,
        name: data.name,
      }),
    );
  }

  return jsonOk(await shapeScoutResponse(db, data));
}

async function deleteScout(user: AuthedUser, id: string): Promise<Response> {
  const svc = getServiceClient();
  const { data: deleted, error: rpcErr } = await svc.rpc(
    "delete_scout_with_schedule",
    {
      p_scout_id: id,
      p_user_id: user.id,
    },
  );
  if (rpcErr) throw new Error(rpcErr.message);
  if (!deleted) throw new NotFoundError("scout");

  // Deletion contract (PAGE-ARCHIVE-PRD R3): the RPC cascades the
  // page_snapshots ROWS via FK, but a DB cascade can never reach Storage
  // objects — deleteScoutSnapshots is the only thing standing between R3's
  // promise and orphaned page copies. Runs AFTER the row delete (its two-pass
  // sweep then also collects any artifact an in-flight capture uploaded before
  // it failed on the now-missing scout FK). Best-effort: a storage-sweep
  // failure must not 500 a delete whose scout row is already gone — the
  // account-level sweep (docs/supabase/retention.md) is the backstop.
  try {
    await deleteScoutSnapshots(svc, user.id, id);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "scouts",
      event: "snapshot_object_sweep_failed",
      user_id: user.id,
      scout_id: id,
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  return new Response(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

async function runScout(user: AuthedUser, id: string): Promise<Response> {
  // Verify the scout exists for this caller (RLS-scoped).
  const { db } = getCallerClient(user);
  const { data: scout, error: readErr } = await db
    .from("scouts")
    .select("id, is_active")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!scout) throw new NotFoundError("scout");
  if (scout.is_active === false) {
    throw new ConflictError("scout is paused");
  }

  const svc = getServiceClient();
  const { data: runId, error: rpcErr } = await svc.rpc("trigger_scout_run", {
    p_scout_id: id,
    p_user_id: user.id,
  });
  if (rpcErr) throw new Error(rpcErr.message);

  logEvent({
    level: "info",
    fn: "scouts",
    event: "run_triggered",
    user_id: user.id,
    scout_id: id,
    run_id: typeof runId === "string" ? runId : String(runId),
  });

  return jsonOk({ scout_id: id, run_id: runId }, 202);
}

async function pauseScout(user: AuthedUser, id: string): Promise<Response> {
  const { db } = getCallerClient(user);
  const { data: current, error: readErr } = await db
    .from("scouts")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!current) throw new NotFoundError("scout");

  const { data, error } = await db
    .from("scouts")
    .update({ is_active: false })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("scout");

  const svc = getServiceClient();
  try {
    await unscheduleScoutOrThrow(svc, id, user.id);
  } catch (e) {
    await rollbackScoutUpdate(
      svc,
      id,
      user.id,
      current,
      { is_active: false },
    );
    throw e;
  }

  return jsonOk(await shapeScoutResponse(db, data));
}

async function resumeScout(user: AuthedUser, id: string): Promise<Response> {
  const { db } = getCallerClient(user);
  // chk_active_has_schedule requires schedule_cron when is_active=true.
  const { data: current, error: readErr } = await db
    .from("scouts")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!current) throw new NotFoundError("scout");
  if (!current.schedule_cron) {
    throw new ValidationError(
      "cannot resume scout without schedule_cron; set a schedule first",
    );
  }

  const svc = getServiceClient();
  await ensureScheduledBaseline(svc, current as BaselineableScout);

  const { data, error } = await db
    .from("scouts")
    .update({ is_active: true })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("scout");

  try {
    await scheduleScoutOrThrow(svc, id, current.schedule_cron, user.id);
  } catch (e) {
    await rollbackScoutUpdate(
      svc,
      id,
      user.id,
      current,
      { is_active: true },
    );
    throw e;
  }

  return jsonOk(await shapeScoutResponse(db, data));
}

async function createScoutFromTemplate(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = FromTemplateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const { template_slug, name, fields, project_id } = parsed.data;

  const tpl = TEMPLATES.find((t) => t.slug === template_slug);
  if (!tpl) throw new NotFoundError("template");

  // Validate required fields are present and non-empty.
  const missing: string[] = [];
  for (const f of tpl.fields) {
    if (!f.required) continue;
    const v = fields[f.key];
    if (v === undefined || v === null) {
      missing.push(f.key);
      continue;
    }
    if (typeof v === "string" && v.trim() === "") missing.push(f.key);
    if (Array.isArray(v) && v.length === 0) missing.push(f.key);
  }
  if (missing.length > 0) {
    throw new ValidationError(`missing required fields: ${missing.join(", ")}`);
  }

  // Normalise array fields that may come in as newline-separated strings.
  const normalisedFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ARRAY_FIELDS.has(key) && typeof value === "string") {
      normalisedFields[key] = value
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      normalisedFields[key] = value;
    }
  }

  const insertRow: Record<string, unknown> = {
    ...tpl.defaults,
    ...normalisedFields,
    name,
    description: normalisedFields.description ?? tpl.description,
    type: tpl.type,
    user_id: user.id,
    is_active: false,
  };
  const normalizedInsertRow = normalizeScoutBody(insertRow) as Record<
    string,
    unknown
  >;
  validateTopicAndScope(normalizedInsertRow);
  if (project_id !== undefined) insertRow.project_id = project_id;

  const { db } = getCallerClient(user);
  const { data, error } = await db
    .from("scouts")
    .insert(
      project_id !== undefined
        ? { ...normalizedInsertRow, project_id }
        : normalizedInsertRow,
    )
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new ConflictError("scout name already exists");
    }
    throw new Error(error.message);
  }

  logEvent({
    level: "info",
    fn: "scouts",
    event: "created_from_template",
    user_id: user.id,
    scout_id: data.id,
    template_slug,
  });

  const shaped = await shapeScoutResponse(db, data);
  return jsonOk(shaped, 201);
}

// ---------------------------------------------------------------------------

const TestSchema = z.object({
  url: z.string().url().max(2000),
  criteria: z.string().max(4000).optional(),
  scraperName: z.string().max(200).optional(),
});

const TEST_MARKDOWN_MAX = 15_000;
const CIVIC_BASELINE_MAX_TRACKED = 20;

interface BaselineableScout {
  id: string;
  user_id: string;
  // transport scouts never take a creation-time baseline (first scheduled
  // run establishes a silent positional baseline instead).
  type: "web" | "beat" | "social" | "civic" | "transport";
  url?: string | null;
  provider?: string | null;
  platform?: z.infer<typeof SocialPlatform> | null;
  profile_handle?: string | null;
  tracked_urls?: unknown;
  baseline_established_at?: string | null;
}

const TEST_EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    matches: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["matches", "summary"],
};

interface TestExtraction {
  matches: boolean;
  summary: string;
}

async function testScout(
  req: Request,
  user: AuthedUser,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = TestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  const { url, criteria } = parsed.data;

  // Canonical hash mode owns baselines locally; no Firecrawl changeTracking
  // probe is needed for new Page Scouts.
  const tag = `${user.id}#preview-${crypto.randomUUID().slice(0, 8)}`.slice(
    0,
    128,
  );
  const canonicalHashMode = webCanonicalHashEnabled();
  const probePromise = canonicalHashMode
    ? Promise.resolve<"firecrawl" | "firecrawl_plain">("firecrawl_plain")
    : doubleProbe(url, tag).catch(
      (): "firecrawl" | "firecrawl_plain" => "firecrawl_plain",
    );

  let scraped;
  try {
    scraped = await firecrawlScrape(
      url,
      canonicalHashMode ? WEB_SCOUT_FRESH_SCRAPE_OPTIONS : {},
    );
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "scouts",
      event: "test_scrape_failed",
      user_id: user.id,
      url,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonOk({
      summary: "",
      scraper_status: false,
      criteria_status: false,
      provider: canonicalHashMode ? "firecrawl_plain" : "firecrawl",
    });
  }
  const provider = await probePromise;

  const rawMarkdown = (scraped.markdown ?? "").slice(0, TEST_MARKDOWN_MAX);
  const { text: markdown } = compressContext(rawMarkdown);

  if (!markdown.trim()) {
    return jsonOk({
      summary: "No readable content at that URL.",
      scraper_status: false,
      criteria_status: false,
      provider,
    });
  }

  const prompt = criteria
    ? `You are checking whether a web page matches a monitoring criteria.\n\n` +
      `Criteria: ${criteria}\n\n---\n\n${markdown}\n\n---\n\n` +
      `Return { matches: boolean, summary: string }. The summary must be a 1-2 sentence ` +
      `plain-text (no markdown, no navigation chrome) description of the page relative to the criteria.`
    : `Summarize what this web page is about in 1-2 plain-text sentences. ` +
      `Do NOT return raw markdown, navigation, or boilerplate like "Skip to Main Content". ` +
      `Focus on the actual content of the page. Return { matches: true, summary: string }.\n\n` +
      `---\n\n${markdown}`;

  let extraction: TestExtraction;
  try {
    extraction = await geminiExtract<TestExtraction>(
      prompt,
      TEST_EXTRACTION_SCHEMA,
    );
  } catch (_e) {
    return jsonOk({
      summary: "Page scraped successfully (summary unavailable).",
      scraper_status: true,
      criteria_status: false,
      provider,
    });
  }

  logEvent({
    level: "info",
    fn: "scouts",
    event: "test_preview",
    user_id: user.id,
    url,
    matched: extraction.matches,
  });

  return jsonOk({
    summary: extraction.summary ?? "",
    scraper_status: true,
    // When no criteria, `matches` is meaningless — the LLM returns `true` per
    // the prompt contract; we always set criteria_status=false in that case so
    // the UI doesn't falsely celebrate a match.
    criteria_status: criteria ? !!extraction.matches : false,
    provider,
  });
}
