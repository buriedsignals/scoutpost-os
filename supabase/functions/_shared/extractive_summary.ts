/**
 * Deterministic extractive digest renderer for Beat / Page emails.
 *
 * Replaces the generative `generateBeatSummary` in beat_pipeline.ts so email
 * summaries cite only sources that survived into the displayed card list and
 * cannot coerce one location into another.
 *
 * No LLM is called from this module. Every output character is sourced from
 * a `DigestArticle` field that came from the per-article extraction pipeline
 * (atomic_extract.ts) or a retrieval-port highlight. The renderer cannot
 * introduce a place name or claim that is not already in the input.
 *
 * Verification helper `verifyPlaceNamesGrounded` is used by the run lifecycle
 * to fail-closed when an upstream change accidentally re-introduces a
 * generative step.
 */

import { emailLinkedUrls, escapeDigestText } from "./email_markdown.ts";

import { Lexer, type Token, type Tokens } from "npm:marked@17.0.5";

/** Render source excerpts as text before digest truncation and grounding. */
export function digestExcerptText(markdown: string): string {
  const text = (tokens: Token[]): string =>
    tokens.map((token): string => {
      switch (token.type) {
        case "space":
        case "br":
        case "hr":
        case "html":
          return " ";
        case "def":
          return "";
        case "list":
          return token.items.map((item: Token) => text([item])).join(" ");
        case "table":
          return [token.header, ...token.rows].map((row: Tokens.TableCell[]) =>
            row.map((cell) => text(cell.tokens)).join(" ")
          ).join(" ");
        default: {
          const content = "tokens" in token && token.tokens
            ? text(token.tokens)
            : "text" in token
            ? token.text
            : "";
          return content +
            (["paragraph", "heading", "blockquote", "list_item", "code"]
                .includes(token.type)
              ? " "
              : "");
        }
      }
    }).join("");
  // A clipped excerpt can start inside a link label, leaving a destination
  // that the Markdown lexer correctly treats as literal text. Remove only a
  // complete HTTP(S) link tail, never arbitrary parenthesized prose/URLs.
  const plain = text(Lexer.lex(markdown));
  const withoutOrphanTails = plain.replace(/\]\(https?:\/\/[^\s]*/g, (tail) => {
    let depth = 1;
    for (let i = 2; i < tail.length && i < 2048; i++) {
      if (tail[i] === "(") depth++;
      if (tail[i] === ")" && --depth === 0) return tail.slice(i + 1);
    }
    return tail;
  });
  return withoutOrphanTails.replace(/\s+/g, " ").trim();
}

export interface DigestArticle {
  /** Article title — never an LLM summary. */
  title: string;
  /** Canonical URL of the article. Must be present in the displayed cards. */
  url: string;
  /** First-sentence excerpt, atomic-extract context_excerpt, or retrieval highlight. */
  excerpt: string;
  /** Bare hostname for display. */
  domain: string;
  /** ISO 8601 publishedDate; optional. */
  publishedDate?: string | null;
  /** Optional category tag used to pick an emoji. */
  category?: "news" | "government" | "analysis" | null;
}

export interface FormatDigestOpts {
  /** ISO language code, for date formatting only — no translation. */
  language?: string;
  /** Max bullets to render. Default 5. */
  maxBullets?: number;
}

/** Pick one emoji per category, with a deterministic default. */
function emojiFor(article: DigestArticle): string {
  switch (article.category) {
    case "government":
      return "🏛️";
    case "analysis":
      return "🔍";
    case "news":
    default:
      return "📰";
  }
}

/** Truncate excerpt at sentence-boundary if possible, then char-cap. */
function trimExcerpt(raw: string, maxChars = 220): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  const truncated = cleaned.slice(0, maxChars);
  // Try to break at last sentence end inside the cap.
  const lastPeriod = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
  );
  if (lastPeriod > maxChars * 0.6) return truncated.slice(0, lastPeriod + 1);
  // Otherwise cut at last space and add ellipsis.
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

function formatDate(raw: string | null | undefined, language: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleDateString(language || "en", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return raw.slice(0, 10);
  }
}

/**
 * Compose one bullet per article. Pure string concatenation; no model calls.
 * Format:
 *   <emoji> <title> ([source](url)) — <excerpt> · <date?>
 */
export function digestLine(
  article: DigestArticle,
  language = "en",
): string {
  const emoji = emojiFor(article);
  const title = escapeDigestText(digestExcerptText(article.title));
  const excerpt = escapeDigestText(
    trimExcerpt(digestExcerptText(article.excerpt)),
  );
  const date = formatDate(article.publishedDate, language);
  const dateSuffix = date ? ` · ${date}` : "";
  return `${emoji} ${title} ([${
    escapeDigestText(article.domain)
  }](${article.url}))` +
    (excerpt ? ` — ${excerpt}` : "") +
    dateSuffix;
}

export function formatBeatDigest(
  articles: DigestArticle[],
  opts: FormatDigestOpts = {},
): string {
  if (!articles || articles.length === 0) return "";
  const max = Math.max(1, Math.min(opts.maxBullets ?? 5, 10));
  const language = (opts.language ?? "en").toLowerCase();
  return articles
    .slice(0, max)
    .map((article) => `- ${digestLine(article, language)}`)
    .join("\n");
}

/**
 * Editorial-safety check (BUG-023). Every URL referenced in `digestText` MUST
 * appear in `articles[].url`. When `requiredCity` is supplied, every
 * capitalized place-name-like token in the digest MUST appear in at least one
 * article's title or excerpt — otherwise the digest is asserting geography
 * that no source supports.
 *
 * The place-name extractor is intentionally simple: capitalized word runs of
 * 1-3 tokens that are not at the start of a sentence and not in a small
 * stoplist. This catches "Goffstown, NH" / "Goffstown, CT" — both forms
 * register as the candidate token "Goffstown".
 */
export function verifyPlaceNamesGrounded(
  digestText: string,
  articles: DigestArticle[],
  requiredCity?: string | null,
): { ok: boolean; offendingTokens: string[]; offendingUrls: string[] } {
  const offendingUrls: string[] = [];
  const offendingTokens: string[] = [];
  const cardUrls = new Set(articles.map((a) => a.url));
  // Audit the same active links that the actual email renderer interprets.
  for (const url of emailLinkedUrls(digestText)) {
    if (!cardUrls.has(url)) offendingUrls.push(url);
  }

  // Place-name audit (only when a required city anchors the scout).
  // Strip markdown link metadata + date suffixes — those introduce tokens
  // (domains, month names) that aren't claims about the world.
  if (requiredCity && requiredCity.trim()) {
    const scanText = digestExcerptText(
      digestText
        .replace(/\[[^\]]+\]\([^)]+\)/g, " ") // remove [text](url)
        .replace(/ · [^\n]+(?=\n|$)/g, " "),
    ); // remove trailing date suffix per line
    const corpus = articles
      .map((a) =>
        `${digestExcerptText(a.title)} ${digestExcerptText(a.excerpt)}`
      )
      .join(" ")
      .toLowerCase();
    const STOP = new Set([
      "the",
      "and",
      "but",
      "for",
      "with",
      "from",
      "into",
      "this",
      "that",
      "they",
      "them",
      "his",
      "her",
      "its",
      "you",
      "your",
      "our",
      "their",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ]);
    const placeRegex =
      /\b([A-Z][a-zA-Zà-ÿÀ-Ÿ-￿]+(?:[\s-][A-Z][a-zA-Zà-ÿÀ-Ÿ-￿]+){0,2})\b/g;
    let pm: RegExpExecArray | null;
    while ((pm = placeRegex.exec(scanText)) !== null) {
      const token = pm[1];
      const lower = token.toLowerCase();
      if (STOP.has(lower)) continue;
      if (token.length < 3) continue;
      if (lower === requiredCity.toLowerCase()) continue;
      if (!corpus.includes(lower)) {
        // Token appears in digest but in no article — geo coercion candidate.
        offendingTokens.push(token);
      }
    }
  }

  return {
    ok: offendingUrls.length === 0 && offendingTokens.length === 0,
    offendingTokens: [...new Set(offendingTokens)],
    offendingUrls: [...new Set(offendingUrls)],
  };
}
