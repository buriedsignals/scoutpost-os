/**
 * TACO-style context compression for the scout dispatch pipeline.
 *
 * Adapts the TACO framework (arxiv 2604.19572) — originally designed for
 * terminal agent observation compression — to web-scraped article content.
 * Uses regex-based rules to strip noise (nav elements, cookie banners,
 * social sharing blocks, ad markers, boilerplate footers) while preserving
 * journalistically relevant content.
 *
 * Plug-and-play: callers pass raw markdown through compressContext() before
 * sending it to openRouterExtract. Each rule has keep/strip patterns and
 * boundary parameters mirroring TACO's rule structure.
 */

import { logEvent } from "./log.ts";

export interface CompressionRule {
  id: string;
  trigger: RegExp;
  stripPatterns: RegExp[];
  keepPatterns: RegExp[];
  keepFirstN: number;
  keepLastN: number;
  maxLines?: number;
}

export interface CompressionStats {
  originalChars: number;
  compressedChars: number;
  reductionPct: number;
  rulesApplied: string[];
}

const SEED_RULES: CompressionRule[] = [
  {
    id: "nav_menu",
    trigger: /[\s\S]*/,
    stripPatterns: [
      /^(?:\s*[-•|>»›]?\s*(?:\[.{1,60}\]\(.+?\)|(?:Home|About|Contact|Search|Menu|Login|Sign (?:in|up)|Subscribe|Newsletter|RSS|FAQ|Privacy|Terms|Imprint|Impressum|Kontakt|Datenschutz|Accueil|Inicio|Startseite)\b.{0,40})\s*\n){4,}/gim,
      /(?:^|\n)(?:\s*\|?\s*\[(?:Home|About|Contact|Search|Menu|Login|Sign (?:in|up)|Subscribe|Newsletter|RSS|FAQ|Privacy|Terms|Imprint|Impressum|Kontakt|Datenschutz|Accueil|Inicio|Startseite)\b[^\]]*\]\([^)]*\)\s*\|?\s*(?:\n|$)){2,}/gim,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
  {
    id: "cookie_consent",
    trigger: /cookie|consent|gdpr|datenschutz/i,
    stripPatterns: [
      /(?:^|\n)(?:.*(?:cookie|consent|gdpr|datenschutz|we use cookies|accept (?:all|cookies)|manage preferences|cookie policy|privacy settings|this (?:website|site) uses cookies).*(?:\n|$)){1,8}/gim,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
  {
    id: "social_sharing",
    trigger: /share|tweet|facebook|whatsapp|linkedin|telegram|email this/i,
    stripPatterns: [
      /(?:^|\n)\s*(?:share|tweet|teilen|partager|compartir)\s*(?:this|on|auf|sur)?\s*(?:\n|$)/gim,
      /(?:^|\n)(?:\s*\[?\s*(?:Share on |Teilen auf )?(?:Facebook|Twitter|X|LinkedIn|WhatsApp|Telegram|Reddit|Pinterest|Email|E-Mail|Tumblr|Pocket|Copy link|Link kopieren)\s*\]?(?:\([^)]*\))?\s*(?:\n|$)){2,}/gim,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
  {
    id: "footer_boilerplate",
    trigger: /©|copyright|all rights reserved|alle rechte vorbehalten|tous droits/i,
    stripPatterns: [
      /(?:^|\n)(?:.*(?:©|copyright|all rights reserved|alle rechte vorbehalten|tous droits réservés|todos los derechos).*(?:\n|$)){1,6}/gim,
      /(?:^|\n)(?:.*(?:terms (?:of (?:service|use))|privacy policy|impressum|datenschutzerklärung|cookie policy|sitemap|agb|nutzungsbedingungen).*(?:\n|$)){1,4}/gim,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
  {
    id: "ad_markers",
    trigger: /advertis|sponsor|anzeige|werbung|publicité/i,
    stripPatterns: [
      /(?:^|\n)\s*(?:advertisement|sponsored(?: content)?|anzeige|werbung|publicité|promoted|ad)\s*(?:\n|$)/gim,
      /(?:^|\n)(?:.*(?:subscribe (?:now|today|to)|sign up (?:for|to)|newsletter|jetzt abonnieren|abonnez-vous|suscríbete).*(?:\n|$)){1,5}/gim,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
  {
    id: "related_articles",
    trigger: /related|recommended|also read|mehr zum thema|à lire aussi|leer también/i,
    stripPatterns: [
      /(?:^|\n)\s*#{1,4}\s*(?:Related (?:Articles?|Stories|Posts)|Recommended|You (?:may|might) also (?:like|enjoy)|Also (?:read|see)|More (?:stories|from)|Mehr zum Thema|Weitere Artikel|À lire aussi|Leer también|Lees ook)\s*(?:\n|$)/gim,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
  {
    id: "comment_section",
    trigger: /comments?|kommentar|commentaire|comentario/i,
    stripPatterns: [
      /(?:^|\n)\s*#{1,4}\s*(?:\d+\s+)?(?:Comments?|Kommentare?|Commentaires?|Comentarios?|Reacties?|Leave a (?:comment|reply)|Kommentar hinterlassen)\s*(?:\n|$)/gim,
      /(?:^|\n)(?:.*(?:reply|antworten|répondre|responder)\s*(?:\n|$)){3,}/gim,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
  {
    id: "whitespace_normalize",
    trigger: /[\s\S]*/,
    stripPatterns: [
      /\n{4,}/g,
      /^[ \t]+$/gm,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
  {
    id: "markdown_artifacts",
    trigger: /[\s\S]*/,
    stripPatterns: [
      /(?:^|\n)(?:\s*[-*_]{3,}\s*(?:\n|$)){2,}/gm,
      /(?:^|\n)(?:\s*#{1,6}\s*(?:\n|$)){1,}/gm,
      /(?:^|\n)\s*!\[\s*\]\([^)]*\)\s*(?:\n|$)/gm,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
  {
    id: "paywall_prompts",
    trigger: /paywall|subscribe|premium|unlock|freischalt/i,
    stripPatterns: [
      /(?:^|\n)(?:.*(?:subscribe to (?:continue|read|unlock|access)|premium (?:content|article)|this (?:article|content) is (?:for|available to) (?:subscribers|members|premium)|already a subscriber|bereits abonnent|freischalten|jetzt lesen).*(?:\n|$)){1,6}/gim,
    ],
    keepPatterns: [],
    keepFirstN: 0,
    keepLastN: 0,
  },
];

function applyRule(text: string, rule: CompressionRule): string {
  if (!rule.trigger.test(text)) {
    rule.trigger.lastIndex = 0;
    return text;
  }
  rule.trigger.lastIndex = 0;

  let result = text;
  for (const strip of rule.stripPatterns) {
    const pattern = new RegExp(strip.source, strip.flags);
    result = result.replace(pattern, "\n");
  }
  return result;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+$/gm, "")
    .trim();
}

export function compressContext(text: string, rules?: CompressionRule[]): { text: string; stats: CompressionStats } {
  const originalChars = text.length;
  if (originalChars === 0) {
    return {
      text: "",
      stats: { originalChars: 0, compressedChars: 0, reductionPct: 0, rulesApplied: [] },
    };
  }

  const activeRules = rules ?? SEED_RULES;
  const applied: string[] = [];
  let result = text;

  for (const rule of activeRules) {
    const before = result.length;
    result = applyRule(result, rule);
    if (result.length < before) {
      applied.push(rule.id);
    }
  }

  result = normalizeWhitespace(result);
  const compressedChars = result.length;
  const reductionPct = originalChars > 0
    ? Math.round(((originalChars - compressedChars) / originalChars) * 100)
    : 0;

  return {
    text: result,
    stats: {
      originalChars,
      compressedChars,
      reductionPct,
      rulesApplied: applied,
    },
  };
}

export function compressArticleBlock(articles: string): { text: string; stats: CompressionStats } {
  return compressContext(articles);
}

export function logCompressionStats(
  fn: string,
  scoutId: string | undefined,
  stats: CompressionStats,
): void {
  if (stats.reductionPct > 0) {
    logEvent({
      level: "info",
      fn,
      event: "taco_compression",
      scout_id: scoutId,
      original_chars: stats.originalChars,
      compressed_chars: stats.compressedChars,
      reduction_pct: stats.reductionPct,
      rules_applied: stats.rulesApplied.join(","),
    });
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
