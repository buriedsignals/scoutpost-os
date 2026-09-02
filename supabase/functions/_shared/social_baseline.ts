import { ValidationError } from "./errors.ts";
import {
  buildSocialProfileUrl,
  isSingleLineSocialHandle,
  normalizeSocialHandle,
  type SocialPlatform,
} from "./social_profiles.ts";

const MAX_ITEMS = 20;
const FACEBOOK_LOOKBACK_DAYS = 35;
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
}
export interface SocialBaselinePost {
  id: string;
}

export interface SocialPostDiff {
  newPosts: NormalizedSocialPost[];
  removedIds: string[];
  baseline: string[];
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
  now = new Date(),
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
        // The current actor paginates every available result and charges per
        // item. Date bounds cap that documented path while still covering the
        // longest supported Scoutpost schedule (monthly) plus delivery drift.
        start_date: dateOnlyUtc(
          new Date(now.getTime() - FACEBOOK_LOOKBACK_DAYS * 86_400_000),
        ),
        end_date: dateOnlyUtc(now),
        // Retain the legacy cap for actor builds that still honor it.
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
      identities.push({ id: identity });
    }
  }
  return identities;
}

export function diffSocialPosts(
  platform: SocialPlatform | string,
  previousPosts: unknown,
  currentPosts: readonly NormalizedSocialPost[],
): SocialPostDiff {
  const previous = formatSocialBaselinePosts(previousPosts, platform)
    .map((post) => post.id);
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

  return {
    newPosts,
    removedIds: actorLikelyOk
      ? previous.filter((identity) => !currentSet.has(identity))
      : [],
    baseline: actorLikelyOk ? currentIds : previous,
    currentPostCount: currentIds.length,
    shouldReplaceBaseline: actorLikelyOk,
  };
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
    const media = r.media as Array<{ url?: string }> | undefined;
    imageUrl = media?.[0]?.url ?? null;
    url = str(r.url);
  } else if (platform === "facebook") {
    text = str(r.text) || str(r.message) || str(r.caption);
    timestamp = normalizeTimestamp(r.timestamp ?? r.publishedTime ?? r.time);
    imageUrl = str(r.image) || str(r.imageUrl) || firstImage(r.images);
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
  return { id, text, timestamp, imageUrl, url };
}

function dateOnlyUtc(value: Date): string {
  return value.toISOString().slice(0, 10);
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
