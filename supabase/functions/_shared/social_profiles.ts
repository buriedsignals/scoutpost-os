export type SocialPlatform =
  | "instagram"
  | "x"
  | "facebook"
  | "tiktok"
  | "linkedin";

export type ProfileProbeResult = "exists" | "missing" | "uncertain";
export type SocialAdapterStatus =
  | "resolved"
  | "profile_missing"
  | "probe_uncertain"
  | "fallback_original";

export interface SocialProfileProbeAttempt {
  handle: string;
  url: string;
  result: ProfileProbeResult;
}

export interface SocialProfileResolution {
  input_handle: string;
  resolved_handle: string;
  resolved_profile_url: string;
  adapter_status: SocialAdapterStatus;
  attempts: SocialProfileProbeAttempt[];
}

const LINKEDIN_PERSONAL_PROFILE_RE =
  /^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([^/?#]+)\/?(?:[?#].*)?$/i;
const URL_LIKE_INPUT_RE =
  /^(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)/i;

export function normalizeSocialHandle(
  platform: SocialPlatform,
  input: string,
): string {
  const raw = sanitizeBareHandle(input);
  if (!raw) return "";

  const extracted = extractHandleFromUrl(platform, raw);
  return sanitizeBareHandle(extracted ?? raw);
}

export function buildSocialProfileUrl(
  platform: SocialPlatform,
  input: string,
): string {
  const handle = normalizeSocialHandle(platform, input);
  if (!handle) return "";

  switch (platform) {
    case "instagram":
      return `https://www.instagram.com/${handle}/`;
    case "x":
      return `https://x.com/${handle}`;
    case "facebook":
      return `https://www.facebook.com/${handle}`;
    case "tiktok":
      return `https://www.tiktok.com/@${handle}`;
    case "linkedin":
      // Personal profiles only; company pages are rejected upstream via
      // isLinkedInCompanyUrl. Trailing slash matches the harvestapi actor docs.
      return `https://www.linkedin.com/in/${handle}/`;
  }
}

/**
 * LinkedIn company pages are not supported — Social Scouts monitor personal
 * profiles (`/in/<slug>`) only. Callers must reject these inputs before
 * normalization, which would otherwise mangle them into a bare handle.
 */
export function isLinkedInCompanyUrl(input: string): boolean {
  return /linkedin\.com\/(?:company|school|showcase)\//i.test(input);
}

/**
 * Bare LinkedIn slugs remain supported for API/CLI callers. Inputs that look
 * like URLs must be canonical personal-profile URLs so they cannot be folded
 * into a malformed `/in/https://...` target by the bare-handle fallback.
 */
export function isInvalidLinkedInProfileUrl(input: string): boolean {
  const value = input.trim();
  const looksLikeUrl = URL_LIKE_INPUT_RE.test(value) ||
    value.toLowerCase().includes("linkedin.com/");
  return looksLikeUrl && !LINKEDIN_PERSONAL_PROFILE_RE.test(value);
}

export function socialProfileCandidates(
  platform: SocialPlatform,
  input: string,
): string[] {
  const normalized = normalizeSocialHandle(platform, input);
  if (!normalized) return [];
  // LinkedIn slugs have no official/.org variant convention, and every probe
  // hits the authwall (HTTP 999 from datacenter IPs) — extra candidates only
  // burn requests. Probe the normalized handle alone.
  if (platform === "linkedin") return [normalized];
  const suffixes = ["", "official", ".org"];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const suffix of suffixes) {
    const candidate = normalizeSocialHandle(platform, `${normalized}${suffix}`);
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export async function resolveSocialProfile(
  platform: SocialPlatform,
  input: string,
  opts: {
    probe?: (
      url: string,
      handle: string,
    ) => Promise<ProfileProbeResult>;
  } = {},
): Promise<SocialProfileResolution> {
  const candidates = socialProfileCandidates(platform, input);
  const fallback = candidates[0] ?? normalizeSocialHandle(platform, input);
  const attempts: SocialProfileProbeAttempt[] = [];
  const probe = opts.probe ?? probeProfileUrl;

  for (const handle of candidates) {
    const url = buildSocialProfileUrl(platform, handle);
    const result = await probe(url, handle);
    attempts.push({ handle, url, result });
    if (result === "exists") {
      return {
        input_handle: normalizeSocialHandle(platform, input),
        resolved_handle: handle,
        resolved_profile_url: url,
        adapter_status: "resolved",
        attempts,
      };
    }
    if (result === "uncertain") break;
  }

  const fallbackUrl = buildSocialProfileUrl(platform, fallback);
  const sawMissing = attempts.some((attempt) => attempt.result === "missing");
  return {
    input_handle: normalizeSocialHandle(platform, input),
    resolved_handle: fallback,
    resolved_profile_url: fallbackUrl,
    adapter_status: attempts.length === 0
      ? "fallback_original"
      : sawMissing && attempts.every((attempt) => attempt.result === "missing")
      ? "profile_missing"
      : "probe_uncertain",
    attempts,
  };
}

export function socialProfileResolutionMetadata(
  resolution: SocialProfileResolution,
): Record<string, unknown> {
  return {
    adapter_status: resolution.adapter_status,
    profile_handle_input: resolution.input_handle,
    resolved_profile_handle: resolution.resolved_handle,
    resolved_profile_url: resolution.resolved_profile_url,
    profile_resolution_attempts: resolution.attempts,
    adapter_checked_at: new Date().toISOString(),
  };
}

export function classifyProfileProbeStatus(status: number): ProfileProbeResult {
  if (status === 404 || status === 410) return "missing";
  if (status >= 200 && status < 400) return "exists";
  return "uncertain";
}

export function looksLikeMissingProfileError(message: string): boolean {
  return [
    /not found/i,
    /private profile/i,
    /profile.*private/i,
    /does(?:n't| not) exist/i,
    /user.*does(?:n't| not) exist/i,
    /username.*does(?:n't| not) exist/i,
    /profile.*unavailable/i,
    /no such user/i,
  ].some((pattern) => pattern.test(message));
}

function sanitizeBareHandle(input: string): string {
  return input
    .trim()
    .replace(/^@/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

async function probeProfileUrl(url: string): Promise<ProfileProbeResult> {
  if (!url) return "missing";
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Scoutpost/1.0 (+https://scoutpost.ai; editorial monitoring)",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(8_000),
    });
    return classifyProfileProbeStatus(res.status);
  } catch (e) {
    if (
      e instanceof Error &&
      looksLikeMissingProfileError(e.message)
    ) {
      return "missing";
    }
    return "uncertain";
  }
}

function extractHandleFromUrl(
  platform: SocialPlatform,
  input: string,
): string | null {
  const matchers: Record<SocialPlatform, RegExp> = {
    instagram: /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i,
    x: /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i,
    facebook: /^(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\/([^/?#]+)/i,
    tiktok: /^(?:https?:\/\/)?(?:www\.|m\.)?tiktok\.com\/@([^/?#]+)/i,
    linkedin: LINKEDIN_PERSONAL_PROFILE_RE,
  };

  return input.match(matchers[platform])?.[1] ?? null;
}
