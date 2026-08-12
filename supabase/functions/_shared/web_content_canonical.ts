export const WEB_CANONICALIZER_VERSION = "web-md-v2";
export const WEB_SCOUT_FRESH_SCRAPE_OPTIONS = {
  maxAgeMs: 0,
  storeInCache: false,
};

export interface WebComparisonContent {
  markdown: string;
  strategy: "main" | "role_main" | "article" | "provider_main" | "full";
  ratio?: number;
}

export function webComparisonContent(scrape: {
  markdown: string;
  comparison_markdown?: string | null;
  comparison_strategy?: WebComparisonContent["strategy"];
  comparison_ratio?: number;
}): WebComparisonContent {
  const focused = scrape.comparison_markdown?.trim();
  return focused
    ? {
      markdown: focused,
      strategy: scrape.comparison_strategy === "full"
        ? "main"
        : scrape.comparison_strategy ?? "main",
      ...(typeof scrape.comparison_ratio === "number"
        ? { ratio: scrape.comparison_ratio }
        : {}),
    }
    : { markdown: scrape.markdown, strategy: "full", ratio: 1 };
}

const RELATIVE_TIME_RE =
  /\b(?:updated\s+)?\d+\s+(?:sec(?:ond)?s?|mins?|minutes?|hours?|hrs?|days?)\s+ago\b/gi;
const TRACKING_PARAMS = new Set([
  "visit_id",
  "gclid",
  "dclid",
  "fbclid",
  "msclkid",
  "openaicom-did",
  "openaicom_referred",
]);

export function canonicalizeWebMarkdown(markdown: string): string {
  const normalized = markdown
    .normalize("NFC")
    .replace(/[\u200B\u2060\uFEFF]/g, "")
    .replaceAll("\u00a0", " ")
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
    .replace(
      /\]\((https?:\/\/[^)\s]+)\)/g,
      (_match, href: string) => `](${canonicalPageLink(href)})`,
    );

  let fenced = false;
  return normalized
    .split("\n")
    .map((line) => {
      const trimmedEnd = line.replace(/[ \t]+$/g, "").trimEnd();
      if (/^\s*(?:```|~~~)/.test(trimmedEnd)) {
        fenced = !fenced;
        return trimmedEnd;
      }
      if (fenced) return trimmedEnd;
      const listNormalized = trimmedEnd.replace(/^(\s*)[*+]\s+/, "$1- ");
      return isStandaloneVolatileId(listNormalized.trim())
        ? "<VOLATILE_RENDER_ID>"
        : listNormalized;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function canonicalPageLink(href: string): string {
  try {
    const parsed = new URL(href);
    for (const key of [...parsed.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (normalized.startsWith("utm_") || TRACKING_PARAMS.has(normalized)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return href;
  }
}

function isStandaloneVolatileId(value: string): boolean {
  return /^\d{16,}$/.test(value) ||
    /^[0-9a-f]{32,}$/i.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
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
