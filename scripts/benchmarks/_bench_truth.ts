const CHALLENGE_MARKERS = [
  "just a moment",
  "enable javascript and cookies",
  "verify you are human",
  "challenge-platform",
  "cf-chl-",
  "attention required! | cloudflare",
];

const NON_ARTICLE_SEGMENTS = new Set([
  "archive",
  "category",
  "data",
  "datasets",
  "events",
  "hotels",
  "projects",
  "search",
  "tag",
  "travel",
]);

const NON_ARTICLE_LEAVES = new Set([
  "analysis",
  "latest",
  "local",
  "news",
  "politics",
  "press-releases",
]);

export function captureContentIssue(
  content: string | null | undefined,
  minChars: number,
): string | null {
  const normalized = content?.trim() ?? "";
  if (!normalized) return "capture is missing or empty";
  const lower = normalized.toLowerCase();
  if (CHALLENGE_MARKERS.some((marker) => lower.includes(marker))) {
    return "capture is a recognized challenge/error page";
  }
  if (normalized.length < minChars) {
    return `capture has ${normalized.length} chars, expected at least ${minChars}`;
  }
  return null;
}

export function recentSourceLinkedIssue(
  result: {
    sourceUrl: string | null | undefined;
    occurredAt: string | null | undefined;
  },
  now = new Date(),
  maxAgeDays = 14,
): string | null {
  let url: URL;
  try {
    url = new URL(result.sourceUrl ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    return "source URL is missing or invalid";
  }

  const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  const leaf = segments.at(-1) ?? "";
  if (
    segments.length === 0 ||
    segments.some((segment) => NON_ARTICLE_SEGMENTS.has(segment)) ||
    NON_ARTICLE_LEAVES.has(leaf)
  ) {
    return "source URL is not article-shaped";
  }

  const occurredAt = new Date(result.occurredAt ?? "");
  if (Number.isNaN(occurredAt.getTime())) {
    return "result date is missing or invalid";
  }
  const ageMs = now.getTime() - occurredAt.getTime();
  if (ageMs < -86_400_000) return "result date is unexpectedly in the future";
  if (ageMs > maxAgeDays * 86_400_000) {
    return `result date is older than ${maxAgeDays} days`;
  }
  return null;
}
