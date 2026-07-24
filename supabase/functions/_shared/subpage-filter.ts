/**
 * Filter extracted links to the subpages considered safe to fetch during
 * Phase B of the web-scout listing-page follow. Host-lock + denylist are
 * already handled by `extractLinksFromHtml` (in scout-web-execute); this
 * layer adds the subpage-specific rules: strict path-prefix under the index
 * URL, path traversal block, static asset rejection, and a second-pass domain
 * validator. Article-shape heuristics may rank already in-scope URLs but never
 * widen scope.
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

export type DiscoveredSubpageLink = [url: string, anchorText: string];

const DENYLIST_EXTENSIONS = [
  ".css",
  ".js",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
];

export function extractSubpageLinksFromHtml(
  html: string,
  pageUrl: string,
): DiscoveredSubpageLink[] {
  const parsed = new URL(pageUrl);
  const pageAuthority = normalizeAuthority(parsed);
  const seenUrls = new Set<string>();
  const links: DiscoveredSubpageLink[] = [];
  const regex =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    let href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const anchorText = (match[4] ?? "").replace(/<[^>]+>/g, "").trim();
    if (
      href.startsWith("mailto:") || href.startsWith("javascript:") ||
      href.startsWith("#") ||
      DENYLIST_EXTENSIONS.some((ext) => href.toLowerCase().endsWith(ext))
    ) continue;
    try {
      const resolved = new URL(href, pageUrl);
      if (
        !["http:", "https:"].includes(resolved.protocol) ||
        normalizeAuthority(resolved) !== pageAuthority
      ) continue;
      href = resolved.toString();
    } catch {
      continue;
    }
    const clean = href.split("#")[0].replace(/\/+$/, "");
    const page = pageUrl.split("#")[0].replace(/\/+$/, "");
    if (clean !== page && !seenUrls.has(clean)) {
      seenUrls.add(clean);
      links.push([clean, anchorText]);
    }
  }
  return links;
}

export function extractSubpageLinksFromMarkdown(
  markdown: string,
  pageUrl: string,
): DiscoveredSubpageLink[] {
  const parsed = new URL(pageUrl);
  const pageAuthority = normalizeAuthority(parsed);
  const seenUrls = new Set<string>();
  const links: DiscoveredSubpageLink[] = [];
  const regex = /\[([^\]]{0,240})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const anchorText = (match[1] ?? "").trim();
    const href = (match[2] ?? "").trim();
    if (
      !href || href.startsWith("#") || href.startsWith("mailto:") ||
      href.startsWith("javascript:") ||
      DENYLIST_EXTENSIONS.some((ext) => href.toLowerCase().endsWith(ext))
    ) continue;
    try {
      const resolved = new URL(href, pageUrl);
      if (
        !["http:", "https:"].includes(resolved.protocol) ||
        normalizeAuthority(resolved) !== pageAuthority
      ) continue;
      resolved.hash = "";
      const clean = resolved.toString().replace(/\/+$/, "");
      const page = pageUrl.split("#")[0].replace(/\/+$/, "");
      if (clean !== page && !seenUrls.has(clean)) {
        seenUrls.add(clean);
        links.push([clean, anchorText]);
      }
    } catch {
      continue;
    }
  }
  return links;
}

/**
 * Keep the document region that can legitimately establish index membership.
 * Prefer explicit main/article landmarks; otherwise remove common site chrome.
 */
export function primaryContentHtml(html: string): string {
  const landmarks = [
    ...html.matchAll(/<(main|article)\b[^>]*>[\s\S]*?<\/\1>/gi),
  ].map((match) => match[0]);
  if (landmarks.length > 0) return landmarks.join("\n");
  return html
    .replace(
      /<(?:header|nav|footer|aside)\b[^>]*>[\s\S]*?<\/(?:header|nav|footer|aside)>/gi,
      "",
    );
}

/**
 * Merge links from rendered HTML and markdown instead of treating markdown as
 * an all-or-nothing fallback. Anti-bot providers can return a large rendered
 * shell in raw HTML while placing the useful listing links only in markdown.
 */
export function selectPrimarySubpageLinks(
  htmlLinks: DiscoveredSubpageLink[],
  markdownLinks: DiscoveredSubpageLink[],
  _options: { hasRenderedHtml?: boolean } = {},
): DiscoveredSubpageLink[] {
  const merged = new Map<string, string>();
  // Preserve the repaired anti-bot path from e2ba332b: a provider can return a
  // rendered shell with one incidental link while its useful listing links
  // exist only in markdown. Scope filtering happens after this merge, so
  // markdown chrome cannot widen the configured subtree.
  // Markdown supplements rendered HTML because anti-bot shells can omit the
  // real listing from raw HTML. The configured subtree filter is the authority
  // for scope; article-shape classification later prevents non-content pages
  // from producing units or baselines.
  const safeMarkdownLinks = markdownLinks;
  for (
    const [url, anchorText] of [...htmlLinks, ...safeMarkdownLinks]
  ) {
    const existing = merged.get(url);
    if (existing === undefined || (!existing.trim() && anchorText.trim())) {
      merged.set(url, anchorText);
    }
  }
  return [...merged.entries()];
}

export function primaryContentText(html: string): string {
  return primaryContentHtml(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderIndexClassificationContent(
  primaryText: string,
  candidates: DiscoveredSubpageLink[],
): string {
  if (candidates.length === 0) return primaryText;
  const candidateLines = candidates.map(([url, label]) =>
    `- ${label.trim() || "(unlabelled link)"}: ${url}`
  );
  return `${primaryText}\n\nPrimary-content child candidates:\n${
    candidateLines.join("\n")
  }`;
}

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
  if (/^\d{4,5}\.\d{4,6}(v\d+)?$/i.test(last)) return true;
  if (/^\d{5,}$/.test(last)) return true;
  if (/[a-z][a-z0-9-]*-\d{5,}$/i.test(last)) return true;
  if (hasLongArticleSlug(last)) return true;
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
    if (normalizeAuthority(parsed) !== normalizeAuthority(index)) {
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

export function isConfiguredPageUrl(
  url: string,
  configuredUrl: string,
): boolean {
  try {
    const actual = new URL(url);
    const configured = new URL(configuredUrl);
    return normalizeAuthority(actual) === normalizeAuthority(configured) &&
      actual.pathname.replace(/\/+$/, "") ===
        configured.pathname.replace(/\/+$/, "") &&
      actual.search === configured.search;
  } catch {
    return false;
  }
}

export function pageScoutMetadataForUrlChange(
  currentUrl: string,
  nextUrl: string,
  metadata: Record<string, unknown> | null | undefined,
): { changed: boolean; metadata: Record<string, unknown> } {
  const nextMetadata = { ...(metadata ?? {}) };
  const changed = !isConfiguredPageUrl(nextUrl, currentUrl);
  if (changed) {
    delete nextMetadata.page_scout_initial_candidates;
    delete nextMetadata.page_scout_active_candidates;
  }
  return { changed, metadata: nextMetadata };
}

/**
 * Keep only links that:
 *   1. Parse as a valid URL.
 *   2. Stay on the same normalized host as `indexUrl` (`www.` is ignored).
 *   3. Have a path strictly under `indexUrl`'s path.
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
  const indexAuthority = normalizeAuthority(index);
  const indexPath = index.pathname.replace(/\/+$/, "");

  const filtered = links.filter((url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (normalizeAuthority(parsed) !== indexAuthority) return false;
    if (!validateDomain(parsed.hostname).valid) return false;
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    if (
      hasTraversal(cleanPath) || hasStaticAsset(cleanPath) ||
      isUtilityPath(cleanPath)
    ) return false;
    // For a configured root index, every non-root path is a strict descendant.
    // Article shape may rank candidates but must not redefine the boundary.
    if (!indexPath) return cleanPath !== "";
    return isStrictChildUrl(url, indexUrl);
  });

  return filtered.sort((a, b) =>
    Number(isLikelyArticleUrl(b)) - Number(isLikelyArticleUrl(a))
  );
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function normalizeAuthority(url: URL): string {
  return `${normalizeHost(url.hostname)}:${url.port}`;
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

function hasLongArticleSlug(segment: string): boolean {
  if (segment.length < 12) return false;
  const words = segment.split("-").filter(Boolean);
  if (words.length < 3) return false;
  return words.some((word) => /[a-z]/i.test(word)) &&
    words.every((word) => /^[a-z0-9]+$/i.test(word));
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
