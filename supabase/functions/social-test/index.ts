/**
 * social-test Edge Function — synchronous profile validation + baseline scrape
 * for the Social Scout "Scan Profile" button.
 *
 * Route:
 *   POST /social-test
 *     body: { platform: "instagram"|"x"|"facebook"|"tiktok"|"linkedin", handle: string }
 *     -> 200 {
 *       valid: boolean,
 *       profile_url: string,
 *       error?: string,
 *       post_ids: string[],           // baseline IDs the scheduled run will diff against
 *       preview_posts: { id, text, timestamp }[],  // up to 20, truncated to 120 chars
 *       posts_data: { post_id, caption_truncated, image_url, timestamp }[]
 *     }
 *
 * Pipeline:
 *   1. HEAD (or GET for x/tiktok) the profile URL to check it exists.
 *   2. If valid, fire an Apify synchronous actor run (run-sync-get-dataset-items)
 *      with maxItems=20 and return normalized posts. Timeout 120s per platform.
 *   3. Partial-success path: HEAD ok but Apify failed → return valid:true with
 *      empty post arrays and a warning `error` field (prod parity).
 *
 * **Costs REAL money** — every call burns one Apify actor run against the
 * profile. Gate callers accordingly (rate-limit etc.). No credit decrement
 * happens here; the authoritative charge is in `social-kickoff` when the
 * scout is scheduled.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { AuthedUser, requireUserOrApiKey } from "../_shared/auth.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import {
  buildSocialProfileUrl,
  classifyProfileProbeStatus,
  isLinkedInCompanyUrl,
  looksLikeMissingProfileError,
  normalizeSocialHandle,
  type ProfileProbeResult,
  type SocialPlatform,
} from "../_shared/social_profiles.ts";
import {
  buildSocialActorInput,
  type NormalizedSocialPost,
  normalizeSocialDatasetPosts,
  SOCIAL_APIFY_ACTORS,
} from "../_shared/social_baseline.ts";

const InputSchema = z.object({
  platform: z.enum(["instagram", "x", "facebook", "tiktok", "linkedin"]),
  handle: z.string().min(1).max(200),
});

const APIFY_TIMEOUT_SECS = 120;
const PREVIEW_TEXT_MAX = 120;
const CAPTION_TRUNCATED_MAX = 200;

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  let user: AuthedUser;
  try {
    user = await requireUserOrApiKey(req);
  } catch (e) {
    return jsonFromError(e);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonFromError(new ValidationError("invalid JSON body"));
  }
  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonFromError(
      new ValidationError(
        parsed.error.issues.map((i) => i.message).join("; "),
      ),
    );
  }
  const { platform, handle } = parsed.data;

  // Guard: Facebook pages (not profiles) are unsupported.
  if (platform === "facebook" && isFacebookPageUrl(handle)) {
    return jsonOk({
      valid: false,
      profile_url: "",
      error:
        "Facebook Pages are not supported. Please enter a personal profile handle (e.g. 'username').",
      post_ids: [],
      preview_posts: [],
      posts_data: [],
    });
  }

  // Guard: LinkedIn company pages (not personal profiles) are unsupported.
  if (platform === "linkedin" && isLinkedInCompanyUrl(handle)) {
    return jsonOk({
      valid: false,
      profile_url: "",
      error:
        "LinkedIn company pages are not supported. Please enter a personal profile URL or handle (linkedin.com/in/...).",
      post_ids: [],
      preview_posts: [],
      posts_data: [],
    });
  }

  const normalizedHandle = normalizeSocialHandle(platform, handle);
  const profileUrl = buildSocialProfileUrl(platform, normalizedHandle);
  if (!profileUrl) {
    return jsonOk({
      valid: false,
      profile_url: "",
      error: "Unsupported platform",
      post_ids: [],
      preview_posts: [],
      posts_data: [],
    });
  }

  // Step 1: browser-like probe. Anti-bot responses are inconclusive, not missing.
  const probeResult = await validateProfileExists(platform, profileUrl);
  if (probeResult === "missing") {
    logEvent({
      level: "info",
      fn: "social-test",
      event: "profile_invalid",
      user_id: user.id,
      platform,
      handle: normalizedHandle,
    });
    return jsonOk({
      valid: false,
      profile_url: profileUrl,
      error: "Profile not found or private",
      post_ids: [],
      preview_posts: [],
      posts_data: [],
    });
  }

  // Step 2: Apify synchronous scrape
  const apifyToken = Deno.env.get("APIFY_API_TOKEN");
  if (!apifyToken) {
    logEvent({
      level: "warn",
      fn: "social-test",
      event: "no_apify_token",
      user_id: user.id,
      platform,
    });
    const error = probeResult === "exists"
      ? "APIFY_API_TOKEN not configured — baseline scan skipped"
      : "Profile could not be verified directly and APIFY_API_TOKEN is not configured — baseline scan skipped";
    return jsonOk({
      valid: true,
      profile_url: profileUrl,
      error,
      post_ids: [],
      preview_posts: [],
      posts_data: [],
    });
  }

  try {
    const posts = await runApifySync(platform, normalizedHandle, apifyToken);
    const postIds: string[] = [];
    const previewPosts: Array<{ id: string; text: string; timestamp: string }> =
      [];
    const postsData: Array<{
      id: string;
      post_id: string;
      caption_truncated: string;
      image_url: string | null;
      timestamp: string;
    }> = [];
    for (const p of posts) {
      if (!p.id) continue;
      postIds.push(p.id);
      previewPosts.push({
        id: p.id,
        text: (p.text ?? "").slice(0, PREVIEW_TEXT_MAX),
        timestamp: p.timestamp,
      });
      postsData.push({
        id: p.id,
        post_id: p.id,
        caption_truncated: (p.text ?? "").slice(0, CAPTION_TRUNCATED_MAX),
        image_url: p.imageUrl ?? null,
        timestamp: p.timestamp,
      });
    }

    logEvent({
      level: "info",
      fn: "social-test",
      event: "success",
      user_id: user.id,
      platform,
      handle,
      posts: postIds.length,
    });

    return jsonOk({
      valid: true,
      profile_url: profileUrl,
      post_ids: postIds,
      preview_posts: previewPosts,
      posts_data: postsData,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "warn",
      fn: "social-test",
      event: "scrape_failed",
      user_id: user.id,
      platform,
      handle: normalizedHandle,
      msg,
    });
    if (probeResult !== "exists" && looksLikeMissingProfileError(msg)) {
      return jsonOk({
        valid: false,
        profile_url: profileUrl,
        error: "Profile not found or private",
        post_ids: [],
        preview_posts: [],
        posts_data: [],
      });
    }
    // HEAD succeeded, so profile is valid — return partial success with empty baseline.
    return jsonOk({
      valid: true,
      profile_url: profileUrl,
      error: `Profile valid but baseline scan failed: ${msg.slice(0, 140)}`,
      post_ids: [],
      preview_posts: [],
      posts_data: [],
    });
  }
});

// ---------------------------------------------------------------------------

function isFacebookPageUrl(input: string): boolean {
  const s = input.toLowerCase();
  return s.includes("/pg/") || s.includes("/pages/") || /\/p\//.test(s);
}

async function validateProfileExists(
  platform: string,
  url: string,
): Promise<ProfileProbeResult> {
  // Social platforms often anti-bot HEAD probes; a browser-like GET is less brittle.
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      },
      // Keep it quick.
      signal: AbortSignal.timeout(10_000),
    });
    return classifyProfileProbeStatus(res.status);
  } catch {
    return "uncertain";
  }
}

async function runApifySync(
  platform: string,
  handle: string,
  token: string,
): Promise<NormalizedSocialPost[]> {
  const actor = SOCIAL_APIFY_ACTORS[platform as SocialPlatform];
  if (!actor) throw new Error(`Unsupported platform: ${platform}`);

  // `run-sync-get-dataset-items` blocks until the actor finishes + returns items.
  // Apify encodes `~` in slash-form actor IDs; our literal strings include the
  // `~` which Apify's router accepts directly on this endpoint.
  const endpoint =
    `https://api.apify.com/v2/acts/${actor.id}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${APIFY_TIMEOUT_SECS}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      buildSocialActorInput(platform as SocialPlatform, handle),
    ),
    signal: AbortSignal.timeout((APIFY_TIMEOUT_SECS + 15) * 1000),
  });
  if (!res.ok) {
    throw new Error(
      `Apify ${platform} actor failed: ${res.status} ${
        (await res.text()).slice(0, 200)
      }`,
    );
  }

  const items = await res.json().catch(() => []);
  return normalizeSocialDatasetPosts(platform, items);
}
