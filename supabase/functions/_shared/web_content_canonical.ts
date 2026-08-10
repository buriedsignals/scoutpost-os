export const WEB_CANONICALIZER_VERSION = "web-md-v1";
export const WEB_SCOUT_FRESH_SCRAPE_OPTIONS = {
  maxAgeMs: 0,
  storeInCache: false,
};

const RELATIVE_TIME_RE =
  /\b(?:updated\s+)?\d+\s+(?:sec(?:ond)?s?|mins?|minutes?|hours?|hrs?|days?)\s+ago\b/gi;

export function canonicalizeWebMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(
      /\[!\[([^\]]*)\]\(([^)]*)\)\]\(([^)]*)\)/g,
      (_match, alt: string, _imageUrl: string, href: string) =>
        canonicalLinkedImage(alt, href),
    )
    .replace(
      /!\[([^\]]*)\]\(([^)]*)\)/g,
      (_match, alt: string) => cleanAltText(alt),
    )
    .replace(RELATIVE_TIME_RE, "<RELATIVE_TIME>")
    .replace(/https:\/\/ichef\.bbci\.co\.uk\/[^\s)\\]+/g, "<IMAGE_ASSET>")
    .replace(
      /https:\/\/static\.files\.bbci\.co\.uk\/[^\s)\\]+/g,
      "<STATIC_ASSET>",
    )
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function webCanonicalHash(markdown: string): Promise<string> {
  const canonical = canonicalizeWebMarkdown(markdown);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalLinkedImage(alt: string, href: string): string {
  const cleanAlt = cleanAltText(alt);
  const cleanHref = href.trim();
  if (!cleanHref) return cleanAlt;
  if (isAssetUrl(cleanHref)) return cleanAlt;
  return `[${cleanAlt || "image"}](${cleanHref})`;
}

function cleanAltText(alt: string): string {
  return alt.replace(/\s+/g, " ").trim();
}

function isAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\.(?:avif|gif|jpe?g|png|svg|webp)(?:$|\?)/i.test(parsed.pathname);
  } catch {
    return /\.(?:avif|gif|jpe?g|png|svg|webp)(?:$|\?)/i.test(url);
  }
}
