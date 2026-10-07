import { ValidationError } from "./errors.ts";
import {
  buildSocialProfileUrl,
  isSingleLineSocialHandle,
  normalizeSocialHandle,
  type SocialPlatform,
} from "./social_profiles.ts";

const MAX_ITEMS = 20;
// Posts one actor run returns at most. The Instagram posts actor returns 12
// whatever maxItems says (live 2026-10-07: maxItems 3, 5 and 20 all gave 12).
const RESULT_CAP: Record<SocialPlatform, number> = {
  instagram: 12,
  x: MAX_ITEMS,
  facebook: MAX_ITEMS,
  tiktok: MAX_ITEMS,
  linkedin: MAX_ITEMS,
};
const APIFY_TIMEOUT_SECS = 120;
const SOCIAL_IDENTITY_FIELDS: Record<SocialPlatform, readonly string[]> = {
  instagram: ["shortcode", "shortCode", "id", "pk", "postId", "post_id", "url"],
  x: ["id", "conversationId", "url"],
  facebook: ["postId", "post_id", "id", "url"],
  linkedin: ["id", "entityId", "linkedinUrl"],
  tiktok: ["aweme_id", "id", "videoId", "url", "share_url", "webVideoUrl"],
};
const ALL_SOCIAL_IDENTITY_FIELDS = [
  "shortcode",
  "shortCode",
  "id",
  "pk",
  "postId",
  "post_id",
  "url",
  "conversationId",
  "entityId",
  "linkedinUrl",
  "aweme_id",
  "videoId",
  "share_url",
  "webVideoUrl",
] as const;
const WRAPPER_KEYS = [
  "posts",
  "items",
  "results",
  "data",
  "latestPosts",
  "latest_posts",
];

export interface ApifyActor {
  id: string;
}

export const SOCIAL_APIFY_ACTORS: Record<SocialPlatform, ApifyActor> = {
  instagram: {
    id: "pmQcv69sB1UwguQUY",
  },
  x: {
    id: "61RPP7dywgiy0JPD0",
  },
  facebook: {
    id: "cleansyntax~facebook-profile-posts-scraper",
  },
  tiktok: {
    id: "novi~tiktok-user-api",
  },
  // harvestapi "LinkedIn Profile Posts Scraper (No Cookies)", actor id
  // A3cAPGpwBEG8RJwse. Pay-per-event: $0.002/post + $0.00005 actor start
  // (BRONZE tier, verified live 2026-07-06). Personal profiles only in
  // Scoutpost, though the actor itself also accepts company URLs.
  linkedin: {
    id: "harvestapi~linkedin-profile-posts",
  },
};

export interface NormalizedSocialPost {
  id: string;
  text: string;
  timestamp: string;
  imageUrl: string | null;
  url: string | null;
  /** Pinned to the profile: shown first whatever its age. */
  pinned?: boolean;
}
export interface SocialBaselinePost {
  id: string;
  /** ISO time the post was published, when the actor reported one. */
  timestamp?: string;
}

export interface SocialPostDiff {
  newPosts: NormalizedSocialPost[];
  removedIds: string[];
  baseline: string[];
  /** What to persist: `baseline` with publish times. */
  baselinePosts: SocialBaselinePost[];
  currentPostCount: number;
  shouldReplaceBaseline: boolean;
}

export interface SocialBaselineScan {
  profileUrl: string;
  posts: NormalizedSocialPost[];
}

export async function scanSocialBaseline(
  platform: SocialPlatform,
  handle: string,
  token = Deno.env.get("APIFY_API_TOKEN") ?? "",
  fetchImpl: typeof fetch = fetch,
): Promise<SocialBaselineScan> {
  if (!token) {
    throw new ValidationError(
      "APIFY_API_TOKEN not configured; cannot establish social baseline",
    );
  }
  const normalizedHandle = normalizeSocialHandle(platform, handle);
  const profileUrl = buildSocialProfileUrl(platform, normalizedHandle);
  if (!profileUrl) throw new ValidationError("unsupported social profile");
  const actor = SOCIAL_APIFY_ACTORS[platform];
  if (!actor) throw new ValidationError(`unsupported platform: ${platform}`);

  const endpoint =
    `https://api.apify.com/v2/acts/${actor.id}/run-sync-get-dataset-items` +
    `?timeout=${APIFY_TIMEOUT_SECS}`;
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSocialActorInput(platform, normalizedHandle)),
    signal: AbortSignal.timeout((APIFY_TIMEOUT_SECS + 15) * 1000),
  });
  if (!res.ok) {
    throw new Error(
      `Apify ${platform} baseline failed: ${res.status} ${
        (await res.text()).slice(0, 200)
      }`,
    );
  }

  const items = await res.json().catch(() => []);
  const posts = normalizeSocialDatasetPosts(platform, items);
  return { profileUrl, posts };
}

export function buildSocialActorInput(
  platform: SocialPlatform,
  handle: string,
): Record<string, unknown> {
  if (!isSingleLineSocialHandle(handle)) {
    throw new ValidationError("social profile handle must be a single line");
  }
  const h = normalizeSocialHandle(platform, handle);
  switch (platform) {
    case "instagram":
      return { instagramUsernames: [h], maxItems: MAX_ITEMS };
    case "x": {
      const url = buildSocialProfileUrl("x", h);
      return { startUrls: [url], maxItems: MAX_ITEMS, twitterHandles: [h] };
    }
    case "facebook":
      return {
        endpoint: "profile_posts_by_url",
        // The actor's current build schema accepts profile URLs through the
        // textarea-shaped `urls_text` field. Its README still documents the
        // internal `profile_url` request parameter, which the actor input
        // silently ignores.
        urls_text: buildSocialProfileUrl("facebook", h),
        // No date bounds: max_posts caps the run (build 0.0.26: 20 posts +
        // the profile row, $0.078 for zuck, verified 2026-10-07). A 35-day
        // window left every quiet profile with an empty baseline, so its
        // removals could never be detected.
        max_posts: MAX_ITEMS,
      };
    case "tiktok":
      return { urls: [buildSocialProfileUrl("tiktok", h)], limit: MAX_ITEMS };
    case "linkedin":
      // Reactions/comments scraping stays off — each is a separately billed
      // $0.002 event the diff pipeline never consumes.
      return {
        targetUrls: [buildSocialProfileUrl("linkedin", h)],
        maxPosts: MAX_ITEMS,
      };
  }
}

export function socialPostIdentity(
  platform: SocialPlatform | string,
  row: unknown,
): string | null {
  const minimalIdentity = identityString(row);
  if (minimalIdentity) return minimalIdentity;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;

  const fields = SOCIAL_IDENTITY_FIELDS[platform as SocialPlatform] ??
    ALL_SOCIAL_IDENTITY_FIELDS;
  const post = row as Record<string, unknown>;
  for (const field of fields) {
    const identity = identityString(post[field]);
    if (identity) return identity;
  }
  return null;
}

export function formatSocialBaselinePosts(
  posts: unknown,
  platform: SocialPlatform | string = "",
): SocialBaselinePost[] {
  if (!Array.isArray(posts)) return [];
  const identities: SocialBaselinePost[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    const identity = socialPostIdentity(platform, post);
    if (identity && !seen.has(identity)) {
      seen.add(identity);
      const timestamp = baselineTimestamp(post);
      identities.push(
        timestamp ? { id: identity, timestamp } : { id: identity },
      );
    }
  }
  return identities;
}

function baselineTimestamp(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const value = (row as Record<string, unknown>).timestamp;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export function diffSocialPosts(
  platform: SocialPlatform | string,
  previousPosts: unknown,
  currentPosts: readonly NormalizedSocialPost[],
): SocialPostDiff {
  const previousEntries = formatSocialBaselinePosts(previousPosts, platform);
  const previous = previousEntries.map((post) => post.id);
  const previousSet = new Set(previous);
  const current: NormalizedSocialPost[] = [];
  const currentIds: string[] = [];
  const currentSet = new Set<string>();

  for (const post of currentPosts) {
    const identity = identityString(post.id);
    if (!identity || currentSet.has(identity)) continue;
    currentSet.add(identity);
    currentIds.push(identity);
    current.push(identity === post.id ? post : { ...post, id: identity });
  }

  const newPosts = current.filter((post) => !previousSet.has(post.id));
  const actorLikelyOk = previous.length === 0 ||
    currentIds.length * 5 >= previous.length;
  const isRemoved = removalTest(platform, current);

  return {
    newPosts,
    removedIds: actorLikelyOk
      ? previousEntries.filter((post) =>
        !currentSet.has(post.id) && isRemoved(post)
      )
        .map((post) => post.id)
      : [],
    baseline: actorLikelyOk ? currentIds : previous,
    baselinePosts: actorLikelyOk
      ? formatSocialBaselinePosts(current, platform)
      : previousEntries,
    currentPostCount: currentIds.length,
    shouldReplaceBaseline: actorLikelyOk,
  };
}

/**
 * Decides whether a post missing from the current run was deleted. Below the
 * result cap the run holds the whole profile, so every missing post was
 * deleted. At the cap, a new post pushes the oldest one out of the result;
 * that post was not deleted. Only a post published no earlier than the
 * oldest unpinned current post should still be there, and only a baseline
 * entry with a publish time can prove that, so legacy id-only entries are
 * never reported at the cap.
 */
function removalTest(
  platform: SocialPlatform | string,
  current: readonly NormalizedSocialPost[],
): (post: SocialBaselinePost) => boolean {
  const unpinned = current.filter((post) => !post.pinned);
  const cap = RESULT_CAP[platform as SocialPlatform] ?? MAX_ITEMS;
  if (unpinned.length < cap) return () => true;
  const times = unpinned.map((post) => Date.parse(post.timestamp))
    .filter((ms) => !Number.isNaN(ms));
  if (times.length === 0) return () => false;
  const oldest = Math.min(...times);
  return (post) =>
    post.timestamp !== undefined && Date.parse(post.timestamp) >= oldest;
}

export function normalizeSocialDatasetPosts(
  platform: SocialPlatform | string,
  raw: unknown,
): NormalizedSocialPost[] {
  return flattenSocialRows(raw)
    .map((row) => normalizePost(platform, row))
    .filter((post) => post.id);
}

function flattenSocialRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.flatMap(flattenSocialRows);
  if (!raw || typeof raw !== "object") return [];
  const row = raw as Record<string, unknown>;
  const wrapped: Array<Record<string, unknown>> = [];
  for (const key of WRAPPER_KEYS) {
    if (Array.isArray(row[key])) wrapped.push(...flattenSocialRows(row[key]));
  }
  if (wrapped.length > 0 && !socialPostIdentity("", row)) return wrapped;
  return [row];
}

function normalizePost(
  platform: SocialPlatform | string,
  raw: Record<string, unknown>,
): NormalizedSocialPost {
  const r = raw as Record<string, unknown>;
  const id = socialPostIdentity(platform, r) ?? "";
  let text = "";
  let timestamp = "";
  let imageUrl: string | null = null;
  let url: string | null = null;

  if (platform === "instagram") {
    const shortcode = identityString(r.shortcode) ||
      identityString(r.shortCode);
    text = str(r.caption) || str(r.text) || str(r.accessibility_caption);
    timestamp = normalizeTimestamp(
      r.taken_at ?? r.takenAt ?? r.timestamp ?? r.postedAt ?? r.createdAt ??
        r.crawled_at,
    );
    imageUrl = str(r.image) || str(r.imageUrl) || str(r.displayUrl) ||
      firstImage(r.images) ||
      firstImage(r.imagesUrls);
    url = str(r.url) ||
      (shortcode ? `https://www.instagram.com/p/${shortcode}/` : null);
  } else if (platform === "x") {
    text = str(r.text) || str(r.fullText);
    timestamp = normalizeTimestamp(r.createdAt ?? r.date ?? r.timestamp);
    // apidojo/tweet-scraper sends `media` as a list of image URL strings
    // (verified live 2026-10-07); older rows carried `{ url }` objects.
    imageUrl = firstImage(r.media) || null;
    url = str(r.url);
  } else if (platform === "facebook") {
    text = str(r.text) || str(r.message) || str(r.caption);
    timestamp = normalizeTimestamp(r.timestamp ?? r.publishedTime ?? r.time);
    // cleansyntax build 0.0.26 (verified live 2026-10-07): `image` is
    // `{ uri }`, reels carry `video_thumbnail`, albums `album_preview[]`.
    const image = r.image as Record<string, unknown> | undefined;
    const album = Array.isArray(r.album_preview)
      ? r.album_preview[0] as Record<string, unknown> | undefined
      : undefined;
    imageUrl = str(r.image) || str(image?.uri) || str(r.video_thumbnail) ||
      str(album?.image_file_uri) || str(r.imageUrl) || firstImage(r.images);
    url = str(r.url);
  } else if (platform === "linkedin") {
    // harvestapi/linkedin-profile-posts dataset item shape (verified live
    // 2026-07-06): id, content, postedAt: {date}, postImages: [{url}],
    // postVideo: {thumbnailUrl}, linkedinUrl.
    text = str(r.content) || str(r.text);
    const postedAt = r.postedAt as Record<string, unknown> | undefined;
    timestamp = normalizeTimestamp(
      postedAt?.date ?? postedAt?.timestamp ?? r.timestamp,
    );
    const postVideo = r.postVideo as Record<string, unknown> | undefined;
    imageUrl = firstImage(r.postImages) || str(postVideo?.thumbnailUrl) ||
      null;
    url = str(r.linkedinUrl) || str(r.shareLinkedinUrl);
  } else if (platform === "tiktok") {
    text = str(r.desc) || str(r.caption) || str(r.text);
    timestamp = normalizeTimestamp(
      r.create_time ?? r.createTime ?? r.timestamp,
    );
    const video = r.video as Record<string, unknown> | undefined;
    imageUrl = str(r.cover) || str(r.thumbnail) ||
      firstImageLike(video?.cover) ||
      firstImageLike(video?.origin_cover) ||
      firstImageLike(video?.dynamic_cover);
    url = str(r.url) || str(r.share_url) || str(r.webVideoUrl);
  }
  return { id, text, timestamp, imageUrl, url, pinned: isPinned(r) };
}

// Pinned markers verified on live rows 2026-10-07. Facebook and LinkedIn rows
// carry none.
function isPinned(r: Record<string, unknown>): boolean {
  const instagramPins = r.timeline_pinned_user_ids;
  return r.isPinned === true || r.is_top === 1 || r.is_top === true ||
    (Array.isArray(instagramPins) && instagramPins.length > 0);
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function identityString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

function normalizeTimestamp(v: unknown): string {
  if (typeof v === "number") {
    const ms = v > 10_000_000_000 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
  }
  if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

function firstImage(v: unknown): string {
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      const o = first as Record<string, unknown>;
      return str(o.url) || str(o.src) || "";
    }
  }
  return "";
}

function firstImageLike(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return firstImage(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.url) || str(o.src) || firstImage(o.url_list) ||
      firstImage(o.urlList);
  }
  return "";
}
