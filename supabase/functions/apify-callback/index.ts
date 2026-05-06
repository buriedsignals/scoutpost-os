/**
 * apify-callback Edge Function — receives Apify webhook on run completion.
 *
 * Fetches the run's dataset, diffs against the scout's post_snapshots baseline,
 * and extracts information_units from new posts (summarize or criteria-driven).
 * Idempotent: if the queue row is already terminal, returns early.
 *
 * Route:
 *   POST /apify-callback
 *     body (from Apify webhook): {
 *       eventType: "ACTOR.RUN.SUCCEEDED" | "ACTOR.RUN.FAILED" | ...,
 *       resource: { id, defaultDatasetId, status, ... }
 *     }
 *     -> 200 {
 *       status: "processed" | "already_processed" | "failed_recorded",
 *       new_posts_count?, units_extracted?
 *     }
 *
 * Auth: shared service auth. Apify webhook registrations are configured with
 *       X-Service-Key when INTERNAL_SERVICE_KEY is available.
 */

import { handleCors } from "../_shared/cors.ts";
import { getServiceClient, SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import {
  AuthError,
  NotFoundError,
  ValidationError,
} from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import {
  EMBEDDING_MODEL_TAG,
  geminiEmbed,
  geminiExtract,
} from "../_shared/gemini.ts";
import type { CanonicalUnitType } from "../_shared/unit_dedup.ts";
import {
  RemovedPostSummary,
  sendSocialAlert,
  SocialPostSummary,
} from "../_shared/notifications.ts";
import {
  getSocialMonitoringCost,
  refundCredits,
  SOCIAL_MONITORING_KEYS,
} from "../_shared/credits.ts";
import { sha256Hex, upsertCanonicalUnit } from "../_shared/unit_dedup.ts";
import {
  formatSocialBaselinePosts,
  normalizeSocialDatasetPosts,
} from "../_shared/social_baseline.ts";

const MAX_NEW_POSTS = 20;
const DATASET_LIMIT = 50;
const POST_TEXT_MIN = 10;
const STATEMENT_MAX_CHARS = 500;

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "timeout"]);

const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string" },
          type: { type: "string", enum: ["fact", "event", "entity_update"] },
          context_excerpt: { type: "string" },
          criteria_match: {
            type: "boolean",
            description:
              "True only if this unit satisfies every explicit criterion.",
          },
        },
        required: ["statement", "type", "criteria_match"],
      },
    },
  },
  required: ["units"],
};

interface ExtractedUnit {
  statement: string;
  type: "fact" | "event" | "entity_update";
  context_excerpt?: string;
  criteria_match?: boolean | null;
}

interface ApifyPost {
  id?: string;
  post_id?: string;
  url?: string;
  caption?: string;
  text?: string;
  fullText?: string;
  [k: string]: unknown;
}

function postIdentity(
  post: ApifyPost | Record<string, unknown>,
): string | null {
  const p = post as Record<string, unknown>;
  for (
    const key of [
      "id",
      "post_id",
      "shortcode",
      "shortCode",
      "pk",
      "postId",
      "url",
    ]
  ) {
    const value = p[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
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
    if (e instanceof AuthError) {
      return jsonFromError(new AuthError("service key required"));
    }
    return jsonFromError(e);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonFromError(new ValidationError("invalid JSON body"));
  }

  const { eventType, apifyRunId, datasetId } = parseWebhook(body);
  if (!apifyRunId) {
    return jsonFromError(new ValidationError("resource.id missing"));
  }

  const svc = getServiceClient();

  // Look up queue row by apify_run_id.
  const { data: queueRow, error: queueErr } = await svc
    .from("apify_run_queue")
    .select("id, user_id, scout_id, scout_run_id, status, platform, handle")
    .eq("apify_run_id", apifyRunId)
    .maybeSingle();
  if (queueErr) return jsonFromError(new Error(queueErr.message));
  if (!queueRow) return jsonFromError(new NotFoundError("apify_run_queue"));

  // Idempotency: already-terminal row → return immediately.
  if (TERMINAL_STATUSES.has(queueRow.status as string)) {
    logEvent({
      level: "info",
      fn: "apify-callback",
      event: "already_processed",
      apify_run_id: apifyRunId,
      queue_status: queueRow.status,
    });
    return jsonOk({ status: "already_processed" });
  }

  // Failed-event path: record failure + return + refund the pre-charge.
  if (eventType !== "ACTOR.RUN.SUCCEEDED") {
    await svc
      .from("apify_run_queue")
      .update({
        status: "failed",
        last_error: eventType ?? "unknown_event",
        completed_at: new Date().toISOString(),
      })
      .eq("id", queueRow.id);

    if (queueRow.scout_run_id) {
      await svc
        .from("scout_runs")
        .update({
          status: "error",
          error_message: (eventType ?? "unknown_event").slice(0, 2000),
          completed_at: new Date().toISOString(),
        })
        .eq("id", queueRow.scout_run_id);
    }

    if (queueRow.user_id && queueRow.platform) {
      const op = SOCIAL_MONITORING_KEYS[queueRow.platform] ??
        "social_monitoring_instagram";
      await refundCredits(svc, {
        userId: queueRow.user_id,
        cost: getSocialMonitoringCost(queueRow.platform),
        scoutId: queueRow.scout_id ?? null,
        scoutType: "social",
        operation: op,
      });
    }

    logEvent({
      level: "warn",
      fn: "apify-callback",
      event: "failed_recorded",
      apify_run_id: apifyRunId,
      event_type: eventType,
    });
    return jsonOk({ status: "failed_recorded" });
  }

  // Happy path: fetch dataset, diff, extract, insert.
  try {
    const result = await processSucceededRun(svc, queueRow, datasetId);

    await svc
      .from("apify_run_queue")
      .update({
        status: "succeeded",
        completed_at: new Date().toISOString(),
      })
      .eq("id", queueRow.id);

    // Mark the linked scout_run success (linkage was set at kickoff time).
    if (queueRow.scout_run_id) {
      await svc
        .from("scout_runs")
        .update({
          status: "success",
          scraper_status: true,
          articles_count: result.units_extracted,
          merged_existing_count: result.merged_existing_count,
          completed_at: new Date().toISOString(),
        })
        .eq("id", queueRow.scout_run_id);
    }

    // Notify on new posts. Never throws.
    if (
      (result.units_extracted > 0 ||
        (result.scout_row?.track_removals &&
          (result.removed_posts?.length ?? 0) > 0)) &&
      queueRow.scout_run_id &&
      result.scout_row
    ) {
      try {
        await notifySocial(
          svc,
          queueRow,
          result.scout_row,
          result.new_posts ?? [],
          result.removed_posts ?? [],
        );
      } catch (e) {
        logEvent({
          level: "warn",
          fn: "apify-callback",
          event: "notify_failed",
          scout_id: queueRow.scout_id,
          run_id: queueRow.scout_run_id,
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logEvent({
      level: "info",
      fn: "apify-callback",
      event: "processed",
      apify_run_id: apifyRunId,
      scout_id: queueRow.scout_id,
      new_posts_count: result.new_posts_count,
      units_extracted: result.units_extracted,
      merged_existing_count: result.merged_existing_count,
    });

    return jsonOk({
      status: "processed",
      new_posts_count: result.new_posts_count,
      units_extracted: result.units_extracted,
      merged_existing_count: result.merged_existing_count,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await svc
      .from("apify_run_queue")
      .update({
        status: "failed",
        last_error: msg.slice(0, 2000),
        completed_at: new Date().toISOString(),
      })
      .eq("id", queueRow.id);

    if (queueRow.scout_run_id) {
      await svc
        .from("scout_runs")
        .update({
          status: "error",
          error_message: msg.slice(0, 2000),
          completed_at: new Date().toISOString(),
        })
        .eq("id", queueRow.scout_run_id);
    }
    if (queueRow.user_id && queueRow.platform) {
      const op = SOCIAL_MONITORING_KEYS[queueRow.platform] ??
        "social_monitoring_instagram";
      await refundCredits(svc, {
        userId: queueRow.user_id,
        cost: getSocialMonitoringCost(queueRow.platform),
        scoutId: queueRow.scout_id ?? null,
        scoutType: "social",
        operation: op,
      });
    }

    logEvent({
      level: "error",
      fn: "apify-callback",
      event: "unhandled",
      apify_run_id: apifyRunId,
      msg,
    });
    return jsonFromError(e);
  }
});

async function notifySocial(
  svc: SupabaseClient,
  queueRow: QueueRow,
  scout: ScoutRow,
  newPosts: ApifyPost[],
  removedPosts: ApifyPost[],
): Promise<void> {
  if (!queueRow.scout_run_id) return;
  const platform = scout.platform ?? queueRow.platform;
  const handle = scout.profile_handle ?? queueRow.handle;
  const userId = (scout.user_id ?? queueRow.user_id) as string;

  const summaryPosts = newPosts.slice(0, 5).map((p) => {
    const text = String(p.caption ?? p.text ?? p.fullText ?? "").slice(0, 150);
    return `- ${text}`;
  });
  const removalCount = scout.track_removals ? removedPosts.length : 0;
  const summary = newPosts.length > 0
    ? `${newPosts.length} new ${
      newPosts.length === 1 ? "post" : "posts"
    } from @${handle}:\n${summaryPosts.join("\n")}`
    : `${removalCount} ${
      removalCount === 1 ? "post was" : "posts were"
    } removed from @${handle}.`;

  const mapped: SocialPostSummary[] = newPosts.slice(0, 5).map((p) => ({
    author: handle,
    text: String(p.caption ?? p.text ?? p.fullText ?? ""),
    url: typeof p.url === "string" ? p.url : undefined,
  }));
  let removed: RemovedPostSummary[] | undefined;
  if (scout.track_removals && removedPosts.length > 0) {
    removed = removedPosts.slice(0, 5).map((p) => ({
      captionTruncated: String(p.caption ?? p.text ?? p.fullText ?? "").slice(
        0,
        140,
      ),
    }));
  }

  await sendSocialAlert(svc, {
    userId,
    scoutId: queueRow.scout_id,
    runId: queueRow.scout_run_id,
    scoutName: scout.name ?? "Social Scout",
    platform,
    handle,
    summary,
    newPosts: mapped,
    removedPosts: removed,
    topic: scout.topic ?? null,
  });
}

// ---------------------------------------------------------------------------

function parseWebhook(body: unknown): {
  eventType: string | null;
  apifyRunId: string | null;
  datasetId: string | null;
} {
  if (!body || typeof body !== "object") {
    return { eventType: null, apifyRunId: null, datasetId: null };
  }
  const b = body as Record<string, unknown>;
  const eventType = typeof b.eventType === "string" ? b.eventType : null;
  const resource = (b.resource && typeof b.resource === "object")
    ? b.resource as Record<string, unknown>
    : {};
  const apifyRunId = typeof resource.id === "string" ? resource.id : null;
  const datasetId = typeof resource.defaultDatasetId === "string"
    ? resource.defaultDatasetId
    : null;
  return { eventType, apifyRunId, datasetId };
}

interface QueueRow {
  id: string;
  user_id: string;
  scout_id: string;
  scout_run_id: string | null;
  status: string;
  platform: string;
  handle: string;
}

interface ProcessResult {
  new_posts_count: number;
  units_extracted: number;
  merged_existing_count: number;
  new_posts?: ApifyPost[];
  removed_posts?: ApifyPost[];
  scout_row?: ScoutRow;
}

async function processSucceededRun(
  svc: SupabaseClient,
  queueRow: QueueRow,
  datasetId: string | null,
): Promise<ProcessResult> {
  if (!datasetId) {
    throw new ValidationError("resource.defaultDatasetId missing");
  }

  const apifyToken = Deno.env.get("APIFY_API_TOKEN");
  if (!apifyToken) {
    throw new Error("APIFY_API_TOKEN not configured");
  }

  // 1. Fetch dataset items.
  const datasetUrl =
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&format=json&limit=${DATASET_LIMIT}`;
  const res = await fetch(datasetUrl);
  if (!res.ok) {
    throw new Error(
      `apify dataset fetch failed: ${res.status} ${await res.text()}`,
    );
  }
  const raw = await res.json();
  const normalizedPosts = normalizeSocialDatasetPosts(queueRow.platform, raw);
  const currentPosts = formatSocialBaselinePosts(
    normalizedPosts,
  ) as ApifyPost[];
  if (currentPosts.length === 0) {
    const rawItems = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const first = rawItems[0] && typeof rawItems[0] === "object"
      ? Object.keys(rawItems[0] as Record<string, unknown>)
      : [];
    logEvent({
      level: "warn",
      fn: "apify-callback",
      event: "no_real_posts",
      scout_id: queueRow.scout_id,
      raw_item_count: rawItems.length,
      flattened_count: normalizedPosts.length,
      first_row_keys: first.slice(0, 30),
    });
  }

  // 2. Load scout.
  const { data: scout, error: scoutErr } = await svc
    .from("scouts")
    .select(
      "id, user_id, name, platform, profile_handle, monitor_mode, criteria, topic, track_removals",
    )
    .eq("id", queueRow.scout_id)
    .maybeSingle();
  if (scoutErr) throw new Error(scoutErr.message);
  if (!scout) throw new NotFoundError("scout");

  // 3. Load previous snapshot (if any).
  const { data: snapshot, error: snapErr } = await svc
    .from("post_snapshots")
    .select("id, posts")
    .eq("scout_id", scout.id)
    .maybeSingle();
  if (snapErr) throw new Error(snapErr.message);

  const previousIds = new Set<string>();
  const previousPosts: ApifyPost[] = [];
  if (snapshot && Array.isArray(snapshot.posts)) {
    for (const p of snapshot.posts as ApifyPost[]) {
      const id = p ? postIdentity(p) : null;
      if (id) previousIds.add(id);
      if (p && typeof p === "object") previousPosts.push(p);
    }
  }

  // 4. Compute diff. Filter out Apify placeholder items without a real `id`
  //    (e.g. the X actor returns `{noResults: true}` entries when a profile
  //    has no matching posts). Without the filter they land in the baseline
  //    as ghost rows and every real post on the next run flags "new".
  const realCurrentPosts = currentPosts.filter((p) => postIdentity(p));
  const newPosts = realCurrentPosts.filter((p) =>
    !previousIds.has(postIdentity(p) as string)
  );
  const currentIds = new Set<string>(
    realCurrentPosts.map((p) => postIdentity(p) as string),
  );

  // Actor-failure guard: if the run returned <20% of the previous baseline,
  // treat it as a transient actor failure and skip removal detection. Source
  // applied the same heuristic (routers/social.py:205-213) to avoid
  // flagging 18+ ghost removals on a single flaky Apify run.
  const actorLikelyOk = previousPosts.length === 0 ||
    realCurrentPosts.length >=
      Math.max(1, Math.floor(previousPosts.length * 0.2));
  const removedPosts = actorLikelyOk
    ? previousPosts.filter(
      (p) => {
        const id = postIdentity(p);
        return Boolean(id && !currentIds.has(id));
      },
    )
    : [];

  // 5. Upsert snapshot. Persist the cleaned post list so the next run diffs
  //    against real baselines instead of placeholder ghosts.
  const snapshotPayload = {
    scout_id: scout.id,
    user_id: scout.user_id ?? queueRow.user_id,
    platform: scout.platform ?? queueRow.platform,
    handle: scout.profile_handle ?? queueRow.handle,
    post_count: realCurrentPosts.length,
    posts: realCurrentPosts,
    updated_at: new Date().toISOString(),
  };
  const { error: upsertErr } = await svc
    .from("post_snapshots")
    .upsert(snapshotPayload, { onConflict: "scout_id" });
  if (upsertErr) throw new Error(upsertErr.message);

  // 6. Extract units for each new post (cap MAX_NEW_POSTS).
  const capped = newPosts.slice(0, MAX_NEW_POSTS);
  let unitsExtracted = 0;
  let mergedExistingCount = 0;

  for (const post of capped) {
    const text = String(post.caption ?? post.text ?? post.fullText ?? "");
    if (text.length < POST_TEXT_MIN) continue;
    if (!isUsablePostUrl(post.url)) {
      logEvent({
        level: "warn",
        fn: "apify-callback",
        event: "post_without_url_skipped",
        scout_id: scout.id,
        post_id: typeof post.id === "string" ? post.id : null,
      });
      continue;
    }

    const useCriteria = scout.monitor_mode === "criteria" && scout.criteria;

    if (!useCriteria) {
      // Summarize path: insert a single unit with the post text.
      const statement = text.slice(0, STATEMENT_MAX_CHARS);
      try {
        const inserted = await insertUnit(svc, scout, queueRow, {
          statement,
          type: "entity_update",
          context_excerpt: undefined,
        }, post);
        if (inserted.createdCanonical) unitsExtracted += 1;
        else if (inserted.mergedExisting && inserted.occurrenceCreated) {
          mergedExistingCount += 1;
        }
      } catch (e) {
        logEvent({
          level: "warn",
          fn: "apify-callback",
          event: "unit_insert_failed",
          scout_id: scout.id,
          msg: e instanceof Error ? e.message : String(e),
        });
      }
      continue;
    }

    // Criteria path: Gemini structured extraction.
    let extracted: ExtractedUnit[] = [];
    try {
      const prompt =
        "Extract factual statements from the social-media post below that match " +
        `the following criteria HARD FILTER: "${scout.criteria}". ` +
        "Only return units that satisfy EVERY explicit criterion; if a post or statement only partially matches, return no unit for it. " +
        "Set criteria_match=false for any unit that fails or only partially satisfies the criteria. " +
        "For each match, give a one-sentence `statement`, a `type` " +
        "(fact|event|entity_update), and a short `context_excerpt`. " +
        "If no statement matches, return an empty array.\n\nPOST:\n" + text;
      const result = await geminiExtract<{ units: ExtractedUnit[] }>(
        prompt,
        EXTRACTION_SCHEMA,
      );
      extracted = Array.isArray(result?.units) ? result.units : [];
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "apify-callback",
        event: "gemini_failed",
        scout_id: scout.id,
        msg: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    for (const u of extracted) {
      if (!u || typeof u.statement !== "string" || !u.statement.trim()) {
        continue;
      }
      if (u.criteria_match === false) continue;
      if (!["fact", "event", "entity_update"].includes(u.type)) continue;
      try {
        const inserted = await insertUnit(svc, scout, queueRow, u, post);
        if (inserted.createdCanonical) unitsExtracted += 1;
        else if (inserted.mergedExisting && inserted.occurrenceCreated) {
          mergedExistingCount += 1;
        }
      } catch (e) {
        logEvent({
          level: "warn",
          fn: "apify-callback",
          event: "unit_insert_failed",
          scout_id: scout.id,
          msg: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return {
    new_posts_count: newPosts.length,
    units_extracted: unitsExtracted,
    merged_existing_count: mergedExistingCount,
    new_posts: newPosts,
    removed_posts: removedPosts,
    scout_row: scout as ScoutRow,
  };
}

interface ScoutRow {
  id: string;
  user_id: string | null;
  name: string | null;
  platform: string | null;
  profile_handle: string | null;
  monitor_mode: string | null;
  criteria: string | null;
  topic: string | null;
  track_removals: boolean | null;
}

async function insertUnit(
  svc: SupabaseClient,
  scout: ScoutRow,
  queueRow: QueueRow,
  unit: ExtractedUnit,
  post: ApifyPost,
): Promise<{
  createdCanonical: boolean;
  mergedExisting: boolean;
  occurrenceCreated: boolean;
}> {
  const userId = scout.user_id ?? queueRow.user_id;
  const platform = scout.platform ?? queueRow.platform;
  if (!isUsablePostUrl(post.url)) {
    throw new ValidationError("social post missing usable URL");
  }
  const sourceUrl = post.url.trim();
  const content = String(post.caption ?? post.text ?? post.fullText ?? "");
  const extractedAt = new Date().toISOString();

  // Embedding is best-effort; if it fails we still insert the unit without one.
  let embedding: number[] | null = null;
  try {
    embedding = await geminiEmbed(unit.statement, "RETRIEVAL_DOCUMENT", {
      title: typeof post.id === "string"
        ? `${platform} post ${post.id}`
        : `${platform} post`,
    });
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "apify-callback",
      event: "embed_failed",
      scout_id: scout.id,
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  const unitType = unit.type as CanonicalUnitType;
  return await upsertCanonicalUnit(svc, {
    userId,
    statement: unit.statement.slice(0, STATEMENT_MAX_CHARS),
    unitType,
    entities: [],
    embedding,
    embeddingModel: embedding ? EMBEDDING_MODEL_TAG : null,
    sourceUrl,
    sourceDomain: platform,
    sourceTitle: typeof post.id === "string"
      ? `${platform} post ${post.id}`
      : `${platform} post`,
    contextExcerpt: unit.context_excerpt ?? null,
    extractedAt,
    sourceType: "scout",
    contentSha256: content ? await sha256Hex(content) : null,
    scoutId: scout.id,
    scoutType: "social",
    scoutRunId: queueRow.scout_run_id,
    metadata: {
      handle: scout.profile_handle ?? queueRow.handle,
      platform,
      post_id: typeof post.id === "string" ? post.id : null,
    },
  });
}

function isUsablePostUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
