/**
 * Queued Social Scout run (A2-A4 of the social run-path plan).
 *
 * `social-execute` answers the dispatcher 202 and runs this under
 * EdgeRuntime.waitUntil. It does in one process what social-kickoff +
 * apify-callback do across a webhook: fetch posts (synchronous Apify actor
 * run), diff against the baseline, extract units, write the baseline, notify.
 *
 * Order, and what each crash leaves behind, is in the A2 design note of PR
 * "feat(social): queued social-execute worker". Short form:
 *   claim -> profile -> baseline check -> token -> charge -> fetch -> diff ->
 *   extract (deadline) -> write baseline -> mark success -> notify.
 * The baseline is written after extraction, so a crash before it re-extracts
 * the same posts next run instead of losing them.
 */

import { ValidationError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type { SupabaseClient } from "./supabase.ts";
import { EMBEDDING_MODEL_TAG, embedText } from "./embedding.ts";
import { openRouterExtract } from "./openrouter.ts";
import { sha256Hex, upsertCanonicalUnit } from "./unit_dedup.ts";
import type { CanonicalUnitType } from "./unit_dedup.ts";
import {
  type NotificationSendResult,
  type RemovedPostSummary,
  sendSocialAlert,
  type SocialPostSummary,
} from "./notifications.ts";
import {
  decrementOnceOrThrow,
  getSocialMonitoringCost,
  InsufficientCreditsError,
  refundCreditsOnce,
  SOCIAL_MONITORING_KEYS,
} from "./credits.ts";
import { repairMissingSocialBaseline } from "./baseline_repair.ts";
import {
  diffSocialPosts,
  fetchSocialPosts,
  type NormalizedSocialPost,
} from "./social_baseline.ts";
import {
  resolveSocialProfile,
  type SocialPlatform,
  type SocialProfileResolution,
  socialProfileResolutionMetadata,
} from "./social_profiles.ts";
import {
  classifyRunError,
  markNotificationAttempted,
  markNotificationResult,
  markRunError,
  markRunStage,
  markRunSuccess,
  type RunStage,
} from "./run_lifecycle.ts";
import { recordScoutRunFailure } from "./scout_failures.ts";
import {
  criteriaScoreFromUnit,
  socialCriteriaThreshold,
} from "./social_criteria.ts";

const MAX_NEW_POSTS = 20;
const POST_TEXT_MIN = 10;
const STATEMENT_MAX_CHARS = 500;
/**
 * Time budget, in ms since the worker started. The hosted wall clock is 400 s
 * and nothing after it runs, so the baseline write and `markRunSuccess` must
 * fit before it. Worst cases, all bounded by timeouts in the code below:
 *   - one criteria extraction: OpenRouter aborts at 95 s (openrouter.ts:97-98)
 *   - one embedding: 30 s (embedding.ts DEFAULT_TIMEOUT_MS); a post can yield
 *     several units, so unit inserts check the hard stop between units
 *   - one unit upsert (database): about 10 s allowed
 *   - baseline write + markRunSuccess: 30 s reserved
 * Hard stop 330 s: no embedding or unit insert starts after it, so the last
 * one ends by 330 + 30 + 10 = 370 s, leaving the 30 s reserve before 400 s.
 * Start cutoff 230 s: no post starts after it, so an extraction (<= 95 s)
 * started at 229 s ends before 330 s and its first unit still gets inserted.
 * A post cut by the hard stop mid-way is deferred like one never started.
 */
export const SOCIAL_RUN_DEADLINE_MS = 230_000;
export const SOCIAL_RUN_HARD_STOP_MS = 330_000;
const EXTRACTION_ABORT_MS = 95_000;
const EMBEDDING_ABORT_MS = 30_000;

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
          criteria_score: {
            type: "number",
            description:
              "0-1 confidence that this unit satisfies every explicit criterion.",
          },
          criteria_reason: {
            type: "string",
            description: "Brief reason for the criteria score.",
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
  criteria_score?: number | null;
  criteria_reason?: string | null;
}

interface ScoutRow {
  id: string;
  user_id: string;
  name: string | null;
  preferred_language: string | null;
  platform: string | null;
  profile_handle: string | null;
  baseline_established_at: string | null;
  monitor_mode: string | null;
  criteria: string | null;
  topic: string | null;
  track_removals: boolean | null;
  metadata: Record<string, unknown> | null;
}

export type SocialRunOutcome =
  | { status: "claimed_elsewhere" }
  | { status: "claim_failed"; message: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string }
  | {
    status: "success";
    newPosts: number;
    unitsExtracted: number;
    mergedExisting: number;
    deferredPosts: number;
  };

export async function processSocialRun(
  svc: SupabaseClient,
  input: { scoutId: string; runId: string },
  options: { deadlineMs?: number; hardStopMs?: number } = {},
): Promise<SocialRunOutcome> {
  const { scoutId, runId } = input;
  const startedAt = Date.now();
  const deadline = startedAt + (options.deadlineMs ?? SOCIAL_RUN_DEADLINE_MS);
  const hardStop = startedAt + (options.hardStopMs ?? SOCIAL_RUN_HARD_STOP_MS);

  // 1. Claim. The dispatcher can deliver one run twice (lease expiry after a
  //    lost response); only the worker that moves the run out of `queued`
  //    proceeds. The charge key below is a second guard.
  const { data: claimed, error: claimErr } = await svc
    .from("scout_runs")
    .update({ stage: "dispatch" })
    .eq("id", runId)
    .eq("scout_id", scoutId)
    .eq("status", "running")
    .eq("stage", "queued")
    .select("id");
  if (claimErr) {
    // Nothing was claimed, so this run is not ours to close: another worker
    // may own it. The caller leaves it for a retry or the reconciler.
    logEvent({
      level: "error",
      fn: "social-execute",
      event: "claim_failed",
      scout_id: scoutId,
      run_id: runId,
      msg: claimErr.message,
    });
    return { status: "claim_failed", message: claimErr.message };
  }
  if (!claimed || claimed.length === 0) {
    logEvent({
      level: "info",
      fn: "social-execute",
      event: "claimed_elsewhere",
      scout_id: scoutId,
      run_id: runId,
    });
    return { status: "claimed_elsewhere" };
  }
  await markRunStage(svc, runId, "dispatch");

  const { data: scoutData, error: scoutErr } = await svc
    .from("scouts")
    .select(
      "id, user_id, name, preferred_language, platform, profile_handle, baseline_established_at, monitor_mode, criteria, topic, track_removals, metadata",
    )
    .eq("id", scoutId)
    .maybeSingle();
  if (scoutErr) throw new Error(scoutErr.message);
  const scout = scoutData as ScoutRow | null;
  if (!scout) throw new Error("scout not found");

  const platform = scout.platform as SocialPlatform | null;
  const handle = scout.profile_handle;
  let stage: RunStage = "dispatch";
  let charged = false;
  const operation = SOCIAL_MONITORING_KEYS[platform ?? ""] ??
    "social_monitoring_instagram";
  const cost = getSocialMonitoringCost(platform ?? "");

  /**
   * Ends the run as an error. The refund goes first and cannot throw: if
   * marking the run then throws, the credits are already back (the caller
   * retries the marking; the reconciler refunds nothing twice, same key).
   * Only a failure after the charge counts toward the three-strike pause;
   * before it (database trouble, validation, missing profile, credit errors)
   * the old path did not count either (social-kickoff, execute-scout).
   */
  const fail = async (raw: unknown): Promise<SocialRunOutcome> => {
    const error = asError(raw);
    if (charged) {
      await refundCreditsOnce(svc, {
        idempotencyKey: `social:${runId}:refund`,
        userId: scout.user_id,
        cost,
        scoutId,
        scoutType: "social",
        operation,
      });
    }
    const classified = classifyRunError(error, stage);
    await markRunError(svc, runId, {
      stage: classified.stage,
      errorClass: classified.errorClass,
      message: classified.message,
    });
    if (charged) {
      await recordScoutRunFailure(svc, {
        scoutId,
        userId: scout.user_id,
        scoutName: scout.name ?? "Social Scout",
        scoutType: "social",
        language: scout.preferred_language,
        runId,
        errorClass: classified.errorClass,
        errorMessage: classified.message,
      });
    }
    logEvent({
      level: "error",
      fn: "social-execute",
      event: "failed",
      scout_id: scoutId,
      run_id: runId,
      stage: classified.stage,
      charged,
      msg: classified.message,
    });
    return { status: "error", message: classified.message };
  };

  try {
    if (!platform) throw new ValidationError("scout.platform is required");
    if (!handle) throw new ValidationError("scout.profile_handle is required");

    // 2. Profile resolution (renamed handles, missing profiles). No charge yet.
    const resolution = await resolveSocialProfile(platform, handle);
    await persistSocialAdapterMetadata(svc, {
      scoutId,
      runId,
      scoutMetadata: asObject(scout.metadata),
      resolution,
    });
    if (resolution.adapter_status === "profile_missing") {
      const detail =
        `social profile not found after ${resolution.attempts.length} profile probe(s): ${resolution.input_handle}`;
      await markRunError(svc, runId, {
        stage: "dispatch",
        errorClass: "validation",
        message: detail,
        status: "skipped",
      });
      return { status: "skipped", reason: "profile_missing" };
    }
    const resolvedHandle = resolution.resolved_handle || handle;

    // 3. A baseline must exist; Run Now never creates the first one.
    const { data: snapshot, error: snapshotErr } = await svc
      .from("post_snapshots")
      .select("id, post_count")
      .eq("scout_id", scoutId)
      .maybeSingle();
    if (snapshotErr) throw new Error(snapshotErr.message);
    if (!snapshot) {
      await markRunError(svc, runId, {
        stage: "dispatch",
        errorClass: "no_baseline",
        message:
          "social scout has no baseline snapshot; recreate or reschedule the scout so creation can establish one before Run Now",
      });
      return { status: "error", message: "no baseline" };
    }
    if (!scout.baseline_established_at) {
      const repair = await repairMissingSocialBaseline(svc, scoutId);
      if (repair.repaired) {
        logEvent({
          level: "info",
          fn: "social-execute",
          event: "baseline_backfilled_from_social_snapshot",
          scout_id: scoutId,
          repaired_at: repair.repairedAt,
        });
      }
    }

    // 4. Token before charge: a misconfiguration must not touch credits.
    const token = Deno.env.get("APIFY_API_TOKEN") ?? "";
    if (!token) throw new Error("APIFY_API_TOKEN not configured");

    // 5. Charge. The key makes a re-delivered run charge once.
    stage = "credits";
    await markRunStage(svc, runId, "credits");
    try {
      await decrementOnceOrThrow(svc, {
        idempotencyKey: `social:${runId}:charge`,
        userId: scout.user_id,
        cost,
        scoutId,
        scoutType: "social",
        operation,
      });
    } catch (e) {
      if (e instanceof InsufficientCreditsError) {
        await markRunError(svc, runId, {
          stage: "credits",
          errorClass: "quota",
          message: e.message,
          status: "skipped",
        });
        return { status: "skipped", reason: "insufficient_credits" };
      }
      // Lapsed access, RPC failure, ...: the run ends as an error, nothing is
      // charged, and (as in social-kickoff) it does not count as a failure.
      throw e;
    }
    charged = true;

    // 6. Fetch and diff.
    stage = "scrape";
    await markRunStage(svc, runId, "scrape");
    const { posts: normalizedPosts } = await fetchSocialPosts(
      platform,
      resolvedHandle,
      { token },
    );
    if (normalizedPosts.length === 0) {
      logEvent({
        level: "warn",
        fn: "social-execute",
        event: "no_real_posts",
        scout_id: scoutId,
        platform,
      });
    }

    stage = "diff";
    await markRunStage(svc, runId, "diff");
    const { data: previous, error: previousErr } = await svc
      .from("post_snapshots")
      .select("id, posts")
      .eq("scout_id", scoutId)
      .maybeSingle();
    if (previousErr) throw new Error(previousErr.message);
    const diff = diffSocialPosts(platform, previous?.posts, normalizedPosts);

    // 7. Extract units for new posts until the deadline.
    const capped = diff.newPosts.slice(0, MAX_NEW_POSTS);
    let unitsExtracted = 0;
    let mergedExistingCount = 0;
    const deferredIds = new Set<string>();
    if (capped.length > 0) {
      stage = "extract";
      await markRunStage(svc, runId, "extract");
    }
    for (const [index, post] of capped.entries()) {
      if (Date.now() >= deadline) {
        for (const rest of capped.slice(index)) deferredIds.add(rest.id);
        logEvent({
          level: "warn",
          fn: "social-execute",
          event: "extraction_deadline_reached",
          scout_id: scoutId,
          run_id: runId,
          deferred: deferredIds.size,
        });
        break;
      }
      const counts = await extractPost(
        svc,
        scout,
        runId,
        resolvedHandle,
        post,
        hardStop,
      );
      unitsExtracted += counts.created;
      mergedExistingCount += counts.merged;
      if (counts.deferred) deferredIds.add(post.id);
    }
    // Only posts handled in this run count for the alert and the run record;
    // deferred ones are counted when the next run handles them.
    const processedNew = diff.newPosts.filter((p) => !deferredIds.has(p.id));

    // 8. Write the baseline only for posts that were handled. Deferred posts
    //    stay out so the next run sees them as new. A broken actor result
    //    (P7) keeps the old baseline.
    stage = "insert_units";
    if (diff.shouldReplaceBaseline) {
      const baselinePosts = diff.baselinePosts.filter((entry) =>
        !deferredIds.has(entry.id)
      );
      const { error: upsertErr } = await svc.from("post_snapshots").upsert({
        scout_id: scout.id,
        user_id: scout.user_id,
        platform,
        handle: resolvedHandle,
        post_count: baselinePosts.length,
        posts: baselinePosts,
        updated_at: new Date().toISOString(),
      }, { onConflict: "scout_id" });
      if (upsertErr) throw new Error(upsertErr.message);
    } else {
      logEvent({
        level: "warn",
        fn: "social-execute",
        event: "snapshot_preserved_actor_failure",
        scout_id: scoutId,
        previous_count: diff.baseline.length,
        current_count: diff.currentPostCount,
      });
    }

    // 9. Success first, then notify, so a worker that dies during the email
    //    never turns a finished run into error + refund.
    const removed = diff.removedIds;
    const shouldNotify = unitsExtracted > 0 ||
      (Boolean(scout.track_removals) && removed.length > 0);
    if (deferredIds.size > 0) {
      await mergeRunMetadata(svc, runId, { deferred_posts: deferredIds.size })
        .catch((e) =>
          logEvent({
            level: "warn",
            fn: "social-execute",
            event: "run_metadata_update_failed",
            run_id: runId,
            msg: e instanceof Error ? e.message : String(e),
          })
        );
    }
    await markRunSuccess(svc, runId, {
      unitsCreated: unitsExtracted,
      unitsMerged: mergedExistingCount,
      criteriaStatus: processedNew.length > 0 || removed.length > 0,
      notificationStatus: shouldNotify ? "pending" : "skipped",
      sourcesScraped: 1,
      sourcesFailed: 0,
    });
    if (shouldNotify) {
      await notify(svc, scout, runId, resolvedHandle, processedNew, removed);
    }

    logEvent({
      level: "info",
      fn: "social-execute",
      event: "processed",
      scout_id: scoutId,
      run_id: runId,
      new_posts_count: processedNew.length,
      units_extracted: unitsExtracted,
      merged_existing_count: mergedExistingCount,
      deferred_posts: deferredIds.size,
      elapsed_ms: Date.now() - startedAt,
    });
    return {
      status: "success",
      newPosts: processedNew.length,
      unitsExtracted,
      mergedExisting: mergedExistingCount,
      deferredPosts: deferredIds.size,
    };
  } catch (e) {
    return await fail(e);
  }
}

async function extractPost(
  svc: SupabaseClient,
  scout: ScoutRow,
  runId: string,
  handle: string,
  post: NormalizedSocialPost,
  hardStop: number,
): Promise<{ created: number; merged: number; deferred: boolean }> {
  const text = post.text;
  if (text.length < POST_TEXT_MIN) {
    return { created: 0, merged: 0, deferred: false };
  }
  if (!isUsablePostUrl(post.url)) {
    logEvent({
      level: "warn",
      fn: "social-execute",
      event: "post_without_url_skipped",
      scout_id: scout.id,
      post_id: post.id,
    });
    return { created: 0, merged: 0, deferred: false };
  }

  let created = 0;
  let merged = 0;
  let deferred = false;
  const count = (r: {
    createdCanonical: boolean;
    mergedExisting: boolean;
    occurrenceCreated: boolean;
  }) => {
    if (r.createdCanonical) created += 1;
    else if (r.mergedExisting && r.occurrenceCreated) merged += 1;
  };
  /** False when the hard stop was reached; the post is then deferred. */
  const insert = async (unit: ExtractedUnit): Promise<boolean> => {
    if (Date.now() >= hardStop) {
      deferred = true;
      return false;
    }
    try {
      count(
        await insertUnit(svc, scout, runId, handle, unit, post, hardStop),
      );
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "social-execute",
        event: "unit_insert_failed",
        scout_id: scout.id,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  };

  if (!(scout.monitor_mode === "criteria" && scout.criteria)) {
    await insert({
      statement: text.slice(0, STATEMENT_MAX_CHARS),
      type: "entity_update",
    });
    return { created, merged, deferred };
  }

  const threshold = socialCriteriaThreshold(
    scout.platform ?? "",
    scout.metadata,
  );
  let extracted: ExtractedUnit[] = [];
  try {
    const prompt =
      "Extract factual statements from the social-media post below that match " +
      `the following criteria HARD FILTER: "${scout.criteria}". ` +
      "Only return units that satisfy EVERY explicit criterion; if a post or statement only partially matches, return no unit for it. " +
      `Set criteria_match=false for any unit with criteria_score below ${threshold}. ` +
      "For every unit, include criteria_score from 0 to 1 and a terse criteria_reason. " +
      "For each match, give a one-sentence `statement`, a `type` " +
      "(fact|event|entity_update), and a short `context_excerpt`. " +
      "If no statement matches, return an empty array.\n\nPOST:\n" + text;
    const result = await openRouterExtract<{ units: ExtractedUnit[] }>(
      prompt,
      EXTRACTION_SCHEMA,
      {
        abortAfterMs: Math.max(
          1_000,
          Math.min(EXTRACTION_ABORT_MS, hardStop - Date.now()),
        ),
        usage: {
          db: svc,
          userId: scout.user_id,
          scoutId: scout.id,
          runId,
          functionName: "social-execute",
          operation: "social_extract_post",
        },
      },
    );
    extracted = Array.isArray(result?.units) ? result.units : [];
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "social-execute",
      event: "openrouter_failed",
      scout_id: scout.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return { created, merged, deferred };
  }
  for (const u of extracted) {
    if (!u || typeof u.statement !== "string" || !u.statement.trim()) continue;
    const score = criteriaScoreFromUnit(u);
    if (u.criteria_match === false || score < threshold) continue;
    if (!["fact", "event", "entity_update"].includes(u.type)) continue;
    if (!(await insert(u))) break;
  }
  return { created, merged, deferred };
}

async function insertUnit(
  svc: SupabaseClient,
  scout: ScoutRow,
  runId: string,
  handle: string,
  unit: ExtractedUnit,
  post: NormalizedSocialPost,
  hardStop: number,
) {
  const platform = scout.platform ?? "";
  if (!isUsablePostUrl(post.url)) {
    throw new ValidationError("social post missing usable URL");
  }
  const content = post.text;

  // Embedding is best-effort; the unit is inserted without one if it fails.
  let embedding: number[] | null = null;
  try {
    embedding = await embedText(unit.statement, "RETRIEVAL_DOCUMENT", {
      title: `${platform} post ${post.id}`,
      abortAfterMs: Math.max(
        1_000,
        Math.min(EMBEDDING_ABORT_MS, hardStop - Date.now()),
      ),
    });
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "social-execute",
      event: "embed_failed",
      scout_id: scout.id,
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  return await upsertCanonicalUnit(svc, {
    userId: scout.user_id,
    statement: unit.statement.slice(0, STATEMENT_MAX_CHARS),
    unitType: unit.type as CanonicalUnitType,
    entities: [],
    embedding,
    embeddingModel: embedding ? EMBEDDING_MODEL_TAG : null,
    sourceUrl: post.url.trim(),
    sourceDomain: platform,
    sourceTitle: `${platform} post ${post.id}`,
    contextExcerpt: unit.context_excerpt ?? null,
    extractedAt: new Date().toISOString(),
    sourceType: "scout",
    contentSha256: content ? await sha256Hex(content) : null,
    scoutId: scout.id,
    scoutType: "social",
    scoutRunId: runId,
    metadata: {
      handle,
      platform,
      post_id: post.id,
      criteria_score: typeof unit.criteria_score === "number"
        ? criteriaScoreFromUnit(unit)
        : null,
      criteria_reason: typeof unit.criteria_reason === "string"
        ? unit.criteria_reason.slice(0, 500)
        : null,
    },
  });
}

/** Never throws: notification trouble must not fail a finished run. */
async function notify(
  svc: SupabaseClient,
  scout: ScoutRow,
  runId: string,
  handle: string,
  newPosts: NormalizedSocialPost[],
  removedIds: string[],
): Promise<void> {
  const logFailure = (e: unknown) =>
    logEvent({
      level: "warn",
      fn: "social-execute",
      event: "notification_status_failed",
      scout_id: scout.id,
      run_id: runId,
      msg: e instanceof Error ? e.message : String(e),
    });
  try {
    await markNotificationAttempted(svc, runId).catch(logFailure);
    const result = await sendAlert(
      svc,
      scout,
      runId,
      handle,
      newPosts,
      removedIds,
    );
    await markNotificationResult(
      svc,
      runId,
      result.ok
        ? "sent"
        : result.reason === "missing_email"
        ? "skipped"
        : "failed",
      result.ok ? { providerId: result.providerId ?? null } : {
        message: result.error ?? result.reason ?? "notification not sent",
        reason: result.reason ?? "unknown",
      },
    ).catch(logFailure);
  } catch (e) {
    await markNotificationResult(
      svc,
      runId,
      "failed",
      e instanceof Error ? e.message : String(e),
    ).catch(logFailure);
    logEvent({
      level: "warn",
      fn: "social-execute",
      event: "notify_failed",
      scout_id: scout.id,
      run_id: runId,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
}

function sendAlert(
  svc: SupabaseClient,
  scout: ScoutRow,
  runId: string,
  handle: string,
  newPosts: NormalizedSocialPost[],
  removedIds: string[],
): Promise<NotificationSendResult> {
  const summaryPosts = newPosts.slice(0, 5).map((post) =>
    `- ${post.text.slice(0, 150)}`
  );
  const removalCount = scout.track_removals ? removedIds.length : 0;
  const summary = newPosts.length > 0
    ? `${newPosts.length} new ${
      newPosts.length === 1 ? "post" : "posts"
    } from @${handle}:\n${summaryPosts.join("\n")}`
    : `${removalCount} ${
      removalCount === 1 ? "post was" : "posts were"
    } removed from @${handle}.`;
  const mapped: SocialPostSummary[] = newPosts.slice(0, 5).map((post) => ({
    author: handle,
    text: post.text,
    url: post.url ?? undefined,
  }));
  let removed: RemovedPostSummary[] | undefined;
  if (scout.track_removals && removedIds.length > 0) {
    removed = removedIds.slice(0, 5).map((identity) => ({ identity }));
  }
  return sendSocialAlert(svc, {
    userId: scout.user_id,
    scoutId: scout.id,
    runId,
    scoutName: scout.name ?? "Social Scout",
    platform: scout.platform ?? "",
    handle,
    summary,
    newPosts: mapped,
    removedPosts: removed,
    topic: scout.topic ?? null,
  });
}

/**
 * Supabase RPC errors arrive as plain objects, not Errors; String() of one is
 * "[object Object]". Keep the message (and code) readable.
 */
function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === "object") {
    const { message, code } = value as { message?: unknown; code?: unknown };
    if (typeof message === "string" && message) {
      return new Error(
        typeof code === "string" ? `${message} (${code})` : message,
      );
    }
    try {
      return new Error(JSON.stringify(value));
    } catch {
      // fall through
    }
  }
  return new Error(String(value));
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

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function mergeRunMetadata(
  svc: SupabaseClient,
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data: run } = await svc
    .from("scout_runs")
    .select("metadata")
    .eq("id", runId)
    .maybeSingle();
  const { error } = await svc
    .from("scout_runs")
    .update({
      metadata: {
        ...asObject((run as { metadata?: unknown } | null)?.metadata),
        ...patch,
      },
    })
    .eq("id", runId);
  if (error) throw new Error(error.message);
}

async function persistSocialAdapterMetadata(
  svc: SupabaseClient,
  opts: {
    scoutId: string;
    runId: string;
    scoutMetadata: Record<string, unknown>;
    resolution: SocialProfileResolution;
  },
): Promise<void> {
  const metadata = socialProfileResolutionMetadata(opts.resolution);
  const { error: scoutErr } = await svc
    .from("scouts")
    .update({ metadata: { ...opts.scoutMetadata, ...metadata } })
    .eq("id", opts.scoutId);
  if (scoutErr) throw new Error(scoutErr.message);
  await mergeRunMetadata(svc, opts.runId, metadata);
}
