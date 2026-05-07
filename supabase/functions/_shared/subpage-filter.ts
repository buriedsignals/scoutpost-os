/**
 * Filter extracted links to the subpages considered safe to fetch during
 * Phase B of the web-scout listing-page follow. Host-lock + denylist are
 * already handled by `extractLinksFromHtml` (in scout-web-execute); this
 * layer adds the subpage-specific rules: path-prefix under the index URL,
 * safe same-host article routes, path traversal block, static asset rejection,
 * and a second-pass domain validator.
 *
 * Pure function — no network, no I/O.
 */

/** Reject IPs, localhost, reserved hostnames. */
export function validateDomain(
  domain: string,
): { valid: boolean; error?: string } {
  const cleaned = domain.trim().toLowerCase();
  if (!cleaned) return { valid: false, error: "Empty domain" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(cleaned)) {
    return { valid: false, error: "IP not allowed" };
  }
  if (cleaned.includes(":") || cleaned.startsWith("[")) {
    return { valid: false, error: "IPv6 not allowed" };
  }
  const reserved = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "metadata.google.internal",
    "169.254.169.254",
  ]);
  if (reserved.has(cleaned.split("/")[0].split(":")[0])) {
    return { valid: false, error: "Reserved hostname" };
  }
  if (!cleaned.includes(".")) return { valid: false, error: "No TLD" };
  return { valid: true };
}

const MIN_DETERMINISTIC_ARTICLE_CANDIDATES = 3;

export function isLikelyArticleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  if (
    hasTraversal(cleanPath) || hasStaticAsset(cleanPath) ||
    isUtilityPath(cleanPath)
  ) return false;

  const segments = cleanPath.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1] ?? "";

  if (segments.some((segment) => /^\d{4}-\d{2}-\d{2}$/.test(segment))) {
    return true;
  }
  if (hasSplitDatePath(segments)) return true;
  if (segments.some((segment) => /^ld\.\d+$/i.test(segment))) return true;
  if (/(^|-)ld\.\d+$/i.test(last)) return true;
  if (/\.(html?|php|aspx)$/i.test(last)) return true;
  if (/^\d{5,}$/.test(last)) return true;
  if (/[a-z][a-z0-9-]*-\d{5,}$/i.test(last)) return true;
  return false;
}

export function hasDeterministicListingSignal(
  indexUrl: string,
  candidateUrls: string[],
): boolean {
  if (isLikelyArticleUrl(indexUrl)) return false;
  const articleCandidates = candidateUrls.filter(isLikelyArticleUrl).length;
  return articleCandidates >= MIN_DETERMINISTIC_ARTICLE_CANDIDATES;
}

export function isStrictChildUrl(url: string, indexUrl: string): boolean {
  try {
    const parsed = new URL(url);
    const index = new URL(indexUrl);
    if (normalizeHost(parsed.hostname) !== normalizeHost(index.hostname)) {
      return false;
    }
    const indexPath = index.pathname.replace(/\/+$/, "");
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    if (!indexPath) return cleanPath !== "";
    return cleanPath.startsWith(indexPath + "/");
  } catch {
    return false;
  }
}

/**
 * Keep only links that:
 *   1. Parse as a valid URL.
 *   2. Stay on the same normalized host as `indexUrl` (`www.` is ignored).
 *   3. Have a path under `indexUrl`'s path OR clearly look like same-host article URLs.
 *   4. Contain no `..` or percent-encoded traversal in the path.
 *   5. Are not static assets.
 *   6. Pass `validateDomain` (reject IPs / localhost / reserved names).
 */
export function filterSubpageUrls(links: string[], indexUrl: string): string[] {
  let index: URL;
  try {
    index = new URL(indexUrl);
  } catch {
    return [];
  }
  const indexHost = normalizeHost(index.hostname);
  const indexPath = index.pathname.replace(/\/+$/, "");

  const filtered = links.filter((url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (normalizeHost(parsed.hostname) !== indexHost) return false;
    if (!validateDomain(parsed.hostname).valid) return false;
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    if (
      hasTraversal(cleanPath) || hasStaticAsset(cleanPath) ||
      isUtilityPath(cleanPath)
    ) return false;
    if (!indexPath && !isLikelyArticleUrl(url)) return false;
    if (cleanPath.startsWith(indexPath + "/")) return true;
    if (isLikelyArticleUrl(url)) return true;
    return false;
  });

  const strictChildren = filtered.filter((url) =>
    isStrictChildUrl(url, indexUrl)
  );
  const eligible = strictChildren.length > 0 ? strictChildren : filtered;

  return eligible.sort((a, b) =>
    Number(isLikelyArticleUrl(b)) - Number(isLikelyArticleUrl(a))
  );
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function hasTraversal(path: string): boolean {
  return path.includes("..") || path.toLowerCase().includes("%2e%2e");
}

function hasStaticAsset(path: string): boolean {
  return /\.(css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map|xml|json)$/i
    .test(path);
}

function isUtilityPath(path: string): boolean {
  return /\/(?:ical|rss)\.php$/i.test(path);
}

function hasSplitDatePath(segments: string[]): boolean {
  for (let i = 0; i <= segments.length - 4; i += 1) {
    const year = Number(segments[i]);
    const month = Number(segments[i + 1]);
    const day = Number(segments[i + 2]);
    if (
      /^\d{4}$/.test(segments[i] ?? "") &&
      /^(0[1-9]|1[0-2])$/.test(segments[i + 1] ?? "") &&
      /^(0[1-9]|[12]\d|3[01])$/.test(segments[i + 2] ?? "") &&
      year >= 1990 &&
      year <= 2100 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      return true;
    }
  }
  return false;
}
