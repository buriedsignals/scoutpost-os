/**
 * Scout notification emails via Resend. Shared helper called by every worker
 * on its success path.
 *
 * Legacy reference: backend/app/services/notification_service.py. The shared
 * renderer has been redesigned around the editorial design system in DESIGN.md
 * while preserving the same delivery semantics and sender entry points.
 *
 * Per-type entry points:
 *   - sendPageScoutAlert   (web  scout, dark blue)
 *   - sendBeatAlert        (beat scout, purple, formerly "Smart Scout")
 *   - sendCivicAlert       (civic scout, amber)
 *   - sendSocialAlert      (social scout, rose)
 *
 * Contract:
 *   - Never throws. All failures are logged and returned as `false`.
 *   - Fetches recipient email from `auth.users` at send-time (no public-schema
 *     email leak).
 *   - Marks `scout_runs.notification_sent = true` after Resend 200.
 *   - Retries 5xx with exponential backoff (1s, 2s) up to 3 attempts.
 *     Fast-fails 4xx.
 *   - Early-returns if `RESEND_API_KEY` is missing, if the user has no email,
 *     or if the payload is empty (zero new content).
 */

import type { SupabaseClient } from "./supabase.ts";
import { logEvent } from "./log.ts";
import { getString } from "./email_translations.ts";

const RESEND_URL = "https://api.resend.com/emails";
const FROM = "Scoutpost <alerts@scoutpost.ai>";
const REPLY_TO = "updates@scoutpost.ai";

/** Public workspace base URL the browser sees — configurable so OSS/self-host
 * deep links resolve to their own deployment instead of the hosted SaaS
 * (PAGE-ARCHIVE-PRD U5). Reuses the established PUBLIC_APP_URL app-origin env
 * (the auth functions already resolve it the same way) rather than a second
 * var, so a self-host that already set it — mandatory for MuckRock auth — gets
 * correct deep links for free. Hosted default: https://www.scoutpost.ai. */
function appBaseUrl(): string {
  return (Deno.env.get("PUBLIC_APP_URL") ?? "https://www.scoutpost.ai").replace(
    /\/+$/,
    "",
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Article {
  title: string;
  summary?: string;
  url?: string;
  source?: string;
  originalTitle?: string;
}

export interface SocialPostSummary {
  /** Author handle or name shown as the card title. */
  author?: string;
  /** Post body / caption. Will be truncated to 150 chars. */
  text?: string;
  /** Permalink to the post. */
  url?: string;
}

export interface RemovedPostSummary {
  /** Caption of the now-missing post, already truncated upstream. */
  captionTruncated: string;
}

interface BaseAlertParams {
  userId: string;
  scoutId: string;
  runId: string;
  scoutName: string;
  /** ISO 639-1 code. Falls back to user preference, then English. */
  language?: string;
}

export interface PageScoutAlertParams extends BaseAlertParams {
  url: string;
  criteria?: string | null;
  summary: string;
  matchedUrl?: string | null;
  matchedTitle?: string | null;
  matchedSummary?: string | null;
  /** When true (the run was archive-gated), render an "archived evidence" deep
   * link (`/?scout=<id>`) that focuses the scout in the workspace
   * (PAGE-ARCHIVE-PRD U5). It points at the scout, not a snapshot id — the
   * capture is backgrounded AFTER this notification (R11), so no id exists yet.
   * Linking to the scout degrades gracefully (never a broken/404 link) even in
   * the rare total capture+storage failure that leaves no row. Snapshot
   * artifacts themselves are retrieved via the CLI (`scout snapshots`), MCP
   * (`list_snapshots`/`get_snapshot_url`), or REST — there is no in-app snapshot
   * browser; the frontend consumes the `?scout=` param in
   * routes/+page.svelte onMount to select the scout. */
  archiveEnabled?: boolean;
}

export interface BeatAlertParams extends BaseAlertParams {
  location?: string | null;
  topic?: string | null;
  summary: string;
  articles: Article[];
  govArticles?: Article[];
  govSummary?: string;
}

export interface CivicAlertParams extends BaseAlertParams {
  summary: string;
}

export interface SocialAlertParams extends BaseAlertParams {
  platform: string;
  handle: string;
  summary: string;
  newPosts: SocialPostSummary[];
  removedPosts?: RemovedPostSummary[];
  topic?: string | null;
}

/**
 * One entry in a promise-digest email. Rendered as a Markdown bullet with the
 * promise text, optional source link, and optional due-date badge.
 */
export interface PromiseDigestItem {
  promiseText: string;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  dueDate?: string | null;
}

export interface PromiseDigestParams {
  userId: string;
  items: PromiseDigestItem[];
  language?: string | null;
}

export interface ScoutDeactivatedParams {
  userId: string;
  scoutId: string;
  scoutName: string;
  scoutType: "web" | "beat" | "civic" | "social" | string;
  consecutiveFailures: number;
  language?: string | null;
}

interface UserContext {
  email: string | null;
  language: string;
  healthNotificationsEnabled: boolean;
}

export interface NotificationSendResult {
  ok: boolean;
  reason?: string;
  providerId?: string | null;
  error?: string | null;
  status?: number | null;
}

type NotificationVariant =
  | "page"
  | "beat"
  | "civic"
  | "social"
  | "transport"
  | "digest"
  | "health";

interface MetadataPanel {
  label: string;
  value: string;
  href?: string;
  valueColor?: string;
}

interface SecondarySection {
  title: string;
  summary?: string;
  articles?: Article[];
}

interface CautionSection {
  title: string;
  items: string[];
}

const COLORS = {
  bg: "#F6F1E8",
  surface: "#FFFFFF",
  surfaceAlt: "#FFFDF9",
  surfaceMuted: "#F7F3EC",
  primary: "#6B3FA0",
  primarySoft: "#FBF8FF",
  secondary: "#C77A1D",
  secondarySoft: "#FFF9F1",
  ink: "#1F1A17",
  inkMuted: "#4B433B",
  inkSubtle: "#5A5148",
  border: "#D5C7B6",
  borderStrong: "#AB9986",
  success: "#2F8F5F",
  error: "#B33E2E",
  info: "#3F5EA6",
} as const;

const FONT_DISPLAY = "Georgia, 'Times New Roman', serif";
const FONT_BODY = "Arial, Helvetica, sans-serif";
const FONT_MONO = "'Courier New', Courier, monospace";

export const VARIANT_THEME: Record<
  NotificationVariant,
  { accent: string; accentSoft: string; labelColor?: string }
> = {
  page: {
    accent: COLORS.info,
    accentSoft: "#F7FBFF",
  },
  beat: {
    accent: COLORS.primary,
    accentSoft: COLORS.primarySoft,
  },
  civic: {
    accent: COLORS.secondary,
    accentSoft: COLORS.secondarySoft,
  },
  transport: {
    accent: COLORS.primary,
    accentSoft: COLORS.primarySoft,
  },
  social: {
    accent: COLORS.error,
    accentSoft: "#FFF7F8",
  },
  digest: {
    accent: COLORS.secondary,
    accentSoft: COLORS.secondarySoft,
  },
  health: {
    accent: COLORS.error,
    accentSoft: "#FFF7F8",
  },
};

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function sendPageScoutAlert(
  svc: SupabaseClient,
  params: PageScoutAlertParams,
): Promise<NotificationSendResult> {
  return guarded(svc, "page", params.userId, params.runId, async (ctx) => {
    const language = params.language ?? ctx.language;
    const headerTitle = getString("scout_alert", language);
    const monitoringLabel = getString("monitoring_url", language);
    const criteriaLabel = getString("criteria", language);
    const cueText = getString("page_scout_cue", language);
    const seeWhatMatched = getString("see_what_matched", language);

    const articles = buildPageScoutMatchedArticles(params);
    const articlesSectionTitle = articles.length > 0 ? seeWhatMatched : "";

    const html = buildBaseHtml({
      variant: "page",
      eyebrowLabel: getString("page_scout", language),
      contextLabel: headerTitle,
      headerTitle,
      headerSubtitle: params.scoutName,
      summary: params.summary,
      articles,
      articlesSectionTitle,
      metadataPanels: [
        {
          label: monitoringLabel,
          value: params.url,
          href: params.url,
          valueColor: VARIANT_THEME.page.accent,
        },
        ...(params.criteria
          ? [{
            label: criteriaLabel,
            value: params.criteria,
          }]
          : []),
        ...(params.archiveEnabled
          ? [{
            label: getString("archived_evidence", language),
            value: getString("view_archived_snapshot", language),
            href: `${appBaseUrl()}/?scout=${encodeURIComponent(params.scoutId)}`,
            valueColor: VARIANT_THEME.page.accent,
          }]
          : []),
      ],
      cueText,
      language,
    });

    return {
      subject: `\uD83D\uDD0E Page Scout: ${params.scoutName}`,
      html,
    };
  });
}

export interface TransportAlertParams extends BaseAlertParams {
  /** Human name of the watched area, or "watch list" for geofence-less
   * watch-id scouts. */
  areaName: string;
  /** True for watch-id scouts with no geofence — switches the copy from
   * "entered <area>" to watch-list appearance phrasing. */
  isWatchlist?: boolean;
  /** One composed statement per entrant, already human-readable. */
  entrantStatements: string[];
  mode: string;
  /** Data-source attribution shown on each entrant card (e.g. "aisstream.io
   * (AIS)" for vessels, "adsb.lol (ODbL)" for aircraft). */
  sourceLabel: string;
}

/** Cards rendered per transport alert email. Matches MAX_WATCH_IDS in
 * _shared/transport_config.ts — entrants can't exceed the watch list, so this
 * is belt-and-braces for legacy rows; the overflow count still shows. */
export const MAX_TRANSPORT_EMAIL_CARDS = 20;

/** Cap the entrant list for email rendering. Pure + exported for tests. */
export function capTransportEntrants(
  statements: string[],
  max: number = MAX_TRANSPORT_EMAIL_CARDS,
): { shown: string[]; overflow: number } {
  if (statements.length <= max) return { shown: statements, overflow: 0 };
  return { shown: statements.slice(0, max), overflow: statements.length - max };
}

/** Enter-only transport alert: one email per run listing every object that
 * newly entered the watched area (or newly appeared, for watch-list scouts).
 * The state machine guarantees each object appears at most once per entry,
 * so there is no digesting/dedup here. */
export async function sendTransportScoutAlert(
  svc: SupabaseClient,
  params: TransportAlertParams,
): Promise<NotificationSendResult> {
  return guarded(svc, "transport", params.userId, params.runId, async (ctx) => {
    const language = params.language ?? ctx.language;
    const headerTitle = getString("scout_alert", language);
    const count = params.entrantStatements.length;
    const watchlist = params.isWatchlist === true;
    const noun = params.mode === "vessel"
      ? "vessels"
      : params.mode === "aircraft"
      ? "aircraft"
      : params.mode === "satellite"
      ? "satellites"
      : "objects";
    const summary = count === 1
      ? params.entrantStatements[0]
      : watchlist
      ? `${count} watched ${noun} spotted.`
      : `${count} new arrivals in ${params.areaName}.`;

    const { shown, overflow } = capTransportEntrants(params.entrantStatements);
    const articles: Article[] = shown.map((statement) => ({
      title: statement,
      url: "",
      summary: "",
      source: params.sourceLabel,
    }));
    const sectionBase = watchlist
      ? "Watch list appearances"
      : `Entered ${params.areaName}`;

    const html = buildBaseHtml({
      variant: "transport",
      eyebrowLabel: "Fleet Scout",
      contextLabel: headerTitle,
      headerTitle,
      headerSubtitle: params.scoutName,
      summary,
      articles,
      articlesSectionTitle: count === 0
        ? ""
        : overflow > 0
        ? `${sectionBase} (showing ${shown.length} of ${count})`
        : sectionBase,
      metadataPanels: [
        {
          label: watchlist ? "Scope" : "Watched area",
          value: params.areaName,
          valueColor: VARIANT_THEME.transport.accent,
        },
        { label: "Mode", value: params.mode },
      ],
      cueText: "",
      language,
    });

    return {
      subject: `\u{1F6F0} Fleet Scout: ${params.scoutName} — ${count} ${
        watchlist ? "watched aircraft spotted" : `new in ${params.areaName}`
      }`,
      html,
    };
  });
}

export function buildPageScoutMatchedArticles(
  params: Pick<
    PageScoutAlertParams,
    "matchedUrl" | "matchedTitle" | "matchedSummary"
  >,
): Article[] {
  const url = cleanOptionalText(params.matchedUrl);
  if (!url) return [];
  return [{
    title: cleanOptionalText(params.matchedTitle) ?? matchedTitleFromUrl(url),
    url,
    summary: cleanOptionalText(params.matchedSummary) ?? "",
    source: matchedSourceFromUrl(url),
  }];
}

function markdownLinkedUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const urls: string[] = [];
  const re = /\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) urls.push(m[1]);
  return urls;
}

function offCardSummaryUrls(
  summary: string | null | undefined,
  articles: Article[],
): string[] {
  const cardUrls = new Set(
    articles
      .map((article) => article.url)
      .filter((url): url is string =>
        typeof url === "string" && url.length > 0
      ),
  );
  return markdownLinkedUrls(summary).filter((url) => !cardUrls.has(url));
}

export async function sendBeatAlert(
  svc: SupabaseClient,
  params: BeatAlertParams,
): Promise<NotificationSendResult> {
  const offCardUrls = [
    ...offCardSummaryUrls(params.summary, params.articles),
    ...offCardSummaryUrls(params.govSummary, params.govArticles ?? []),
  ];
  if (offCardUrls.length > 0) {
    const unique = [...new Set(offCardUrls)];
    logEvent({
      level: "warn",
      fn: "notifications",
      event: "beat_summary_ungrounded",
      scout_type: "beat",
      user_id: params.userId,
      run_id: params.runId,
      msg: `summary links are absent from article cards: ${unique.join(", ")}`,
    });
    return {
      ok: false,
      reason: "summary_ungrounded",
      error: `summary links are absent from article cards: ${
        unique.join(", ")
      }`,
    };
  }

  return guarded(svc, "beat", params.userId, params.runId, async (ctx) => {
    const language = params.language ?? ctx.language;
    const headerTitle = getString("beat_scout", language);
    const sectionTitle = getString("top_stories", language);

    const contextSource = params.topic ?? params.location ?? "";
    const subjectContext = params.topic ?? params.location ?? params.scoutName;

    let secondarySection: SecondarySection | undefined;
    if (params.govArticles && params.govArticles.length > 0) {
      const govTitle = getString("government_municipal", language);
      secondarySection = {
        title: govTitle,
        summary: params.govSummary,
        articles: params.govArticles,
      };
    }

    const html = buildBaseHtml({
      variant: "beat",
      eyebrowLabel: headerTitle,
      contextLabel: (contextSource || params.scoutName).toUpperCase(),
      headerTitle,
      headerSubtitle: params.scoutName,
      summary: params.summary,
      articles: params.articles,
      articlesSectionTitle: sectionTitle,
      cueText: getString("beat_scout_cue", language),
      secondarySection,
      language,
    });

    const beatCtx = subjectContext
      ? `: ${subjectContext} \u2014 ${params.scoutName}`
      : `: ${params.scoutName}`;
    return {
      subject: `\uD83D\uDCE1 Beat Scout${beatCtx}`,
      html,
    };
  });
}

export async function sendCivicAlert(
  svc: SupabaseClient,
  params: CivicAlertParams,
): Promise<NotificationSendResult> {
  return guarded(svc, "civic", params.userId, params.runId, async (ctx) => {
    const language = params.language ?? ctx.language;
    const headerTitle = getString("civic_scout", language);

    const html = buildBaseHtml({
      variant: "civic",
      eyebrowLabel: headerTitle,
      contextLabel: getString("key_findings", language),
      headerTitle,
      headerSubtitle: params.scoutName,
      summary: params.summary,
      articles: [],
      articlesSectionTitle: "",
      cueText: getString("civic_scout_cue", language),
      language,
    });

    return {
      subject: `\uD83C\uDFDB\uFE0F Civic Scout: ${params.scoutName}`,
      html,
    };
  });
}

export async function sendSocialAlert(
  svc: SupabaseClient,
  params: SocialAlertParams,
): Promise<NotificationSendResult> {
  return guarded(svc, "social", params.userId, params.runId, async (ctx) => {
    const language = params.language ?? ctx.language;
    const headerTitle = getString("social_scout", language);
    const newPostsLabel = getString("new_posts", language);
    const removedPostsLabel = getString("removed_posts", language);
    const removedLabel = getString("removed_label", language);
    const profileLabel = getString("profile_label", language);
    const cueText = getString("social_scout_cue", language);

    const profileUrl = buildProfileUrl(params.platform, params.handle);
    const articles: Article[] = params.newPosts.slice(0, 5).map((p) => ({
      title: p.author ? `@${p.author}` : "New Post",
      summary: (p.text ?? "").slice(0, 150),
      url: p.url ?? "#",
      source: params.platform,
    }));
    let cautionSection: CautionSection | undefined;
    if (params.removedPosts && params.removedPosts.length > 0) {
      cautionSection = {
        title: removedPostsLabel,
        items: params.removedPosts.slice(0, 5).map((rp) =>
          `${removedLabel} ${rp.captionTruncated}`
        ),
      };
    }

    const html = buildBaseHtml({
      variant: "social",
      eyebrowLabel: getString("social_scout", language),
      contextLabel: `@${
        params.handle.replace(/^@/, "")
      } on ${params.platform.toUpperCase()}`,
      headerTitle,
      headerSubtitle: params.scoutName,
      summary: params.summary,
      articles,
      articlesSectionTitle: newPostsLabel,
      metadataPanels: [{
        label: profileLabel,
        value: profileUrl,
        href: profileUrl,
        valueColor: VARIANT_THEME.social.accent,
      }],
      cueText,
      cautionSection,
      language,
    });

    const subject = params.topic
      ? `\uD83D\uDCAC Social Scout: ${params.topic} \u2014 @${params.handle} \u2014 ${params.scoutName}`
      : `\uD83D\uDCAC Social Scout: @${params.handle} \u2014 ${params.scoutName}`;

    return { subject, html };
  });
}

/**
 * Send the daily civic-promise digest to one user. Unlike the scout alerts
 * this is not bound to a single scout_run — the promise-digest Edge Function
 * groups promises due today across every civic scout the user owns. Returns
 * true if Resend accepted the email (so the caller can flip
 * promises.status='notified' for the included rows).
 */
export async function sendCivicPromiseDigest(
  svc: SupabaseClient,
  params: PromiseDigestParams,
): Promise<boolean> {
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!resendKey) {
    logEvent({
      level: "warn",
      fn: "notifications",
      event: "resend_key_missing",
      scout_type: "civic_digest",
      user_id: params.userId,
    });
    return false;
  }
  const ctx = await resolveUserContext(svc, params.userId);
  if (!ctx.email) {
    logEvent({
      level: "info",
      fn: "notifications",
      event: "skipped_no_email",
      scout_type: "civic_digest",
      user_id: params.userId,
    });
    return false;
  }
  const language = params.language ?? ctx.language;
  const summary = params.items
    .slice(0, 20)
    .map((item) => {
      const escapedText = escapeMarkdown(item.promiseText);
      const due = item.dueDate
        ? ` _(${getString("due_label", language)} ${item.dueDate})_`
        : "";
      if (!item.sourceUrl) return `- **${escapedText}**${due}`;
      let label = item.sourceTitle?.trim() || "";
      if (!label) {
        try {
          label = new URL(item.sourceUrl).hostname;
        } catch {
          label = item.sourceUrl;
        }
      }
      const escapedLabel = escapeMarkdown(label).replace(/\]/g, "\\]");
      return `- **${escapedText}**${due} ([${escapedLabel}](${item.sourceUrl}))`;
    })
    .join("\n");

  const n = params.items.length;
  const digestSubtitle = getPromiseDueLabel(language, n);
  const html = buildBaseHtml({
    variant: "digest",
    eyebrowLabel: getString("civic_digest", language),
    contextLabel: getString("civic_scout", language),
    headerTitle: getString("civic_digest", language),
    headerSubtitle: digestSubtitle,
    summary,
    articles: [],
    articlesSectionTitle: "",
    language,
  });
  const subject = `📅 ${
    getString("civic_digest", language)
  }: ${digestSubtitle}`;

  try {
    return (await sendWithRetry(resendKey, ctx.email, subject, html)).ok;
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "notifications",
      event: "send_failed",
      scout_type: "civic_digest",
      user_id: params.userId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

function escapeMarkdown(s: string): string {
  return s.replace(/[\[\]()*_]/g, (c) => `\\${c}`);
}

function getPromiseDueLabel(language: string, count: number): string {
  return count === 1
    ? getString("promise_due_today_singular", language, { count })
    : getString("promise_due_today_plural", language, { count });
}

function getScoutTypeLabel(
  scoutType: ScoutDeactivatedParams["scoutType"],
  language: string,
): string {
  switch ((scoutType || "").toLowerCase()) {
    case "web":
      return getString("page_scout", language);
    case "beat":
      return getString("beat_scout", language);
    case "civic":
      return getString("civic_scout", language);
    case "social":
      return getString("social_scout", language);
    default:
      return scoutType || "Scout";
  }
}

/**
 * Email a user when one of their scouts has been auto-deactivated after the
 * consecutive-failure threshold (see increment_scout_failures). Legacy
 * scraper-lambda fired the same notification via FastAPI /scouts/failure-notification.
 */
export async function sendScoutDeactivated(
  svc: SupabaseClient,
  params: ScoutDeactivatedParams,
): Promise<boolean> {
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!resendKey) {
    logEvent({
      level: "warn",
      fn: "notifications",
      event: "resend_key_missing",
      scout_type: "deactivated",
      user_id: params.userId,
      scout_id: params.scoutId,
    });
    return false;
  }
  const ctx = await resolveUserContext(svc, params.userId);
  if (!ctx.email) return false;
  if (!ctx.healthNotificationsEnabled) {
    logEvent({
      level: "info",
      fn: "notifications",
      event: "skipped_health_opt_out",
      scout_type: "deactivated",
      user_id: params.userId,
      scout_id: params.scoutId,
    });
    return false;
  }

  const language = params.language ?? ctx.language;
  const scoutTypeLabel = getScoutTypeLabel(params.scoutType, language);
  const summary = getString("scout_paused_summary", language, {
    name: escapeMarkdown(params.scoutName),
    count: params.consecutiveFailures,
  });
  const html = buildBaseHtml({
    variant: "health",
    eyebrowLabel: getString("scout_health", language),
    contextLabel: scoutTypeLabel.toUpperCase(),
    headerTitle: getString("scout_paused", language),
    headerSubtitle: params.scoutName,
    summary,
    articles: [],
    articlesSectionTitle: "",
    metadataPanels: [
      {
        label: getString("scout_type", language),
        value: scoutTypeLabel,
      },
      {
        label: getString("consecutive_failures", language),
        value: String(params.consecutiveFailures),
      },
    ],
    language,
  });
  const subject = `⚠️ ${
    getString("scout_paused", language)
  }: ${params.scoutName}`;

  try {
    return (await sendWithRetry(resendKey, ctx.email, subject, html)).ok;
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "notifications",
      event: "send_failed",
      scout_type: "deactivated",
      user_id: params.userId,
      scout_id: params.scoutId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared pipeline — all four public entry points route through this.
// ---------------------------------------------------------------------------

async function guarded(
  svc: SupabaseClient,
  scoutType: "page" | "beat" | "civic" | "social" | "transport",
  userId: string,
  runId: string,
  render: (ctx: UserContext) => Promise<{ subject: string; html: string }>,
): Promise<NotificationSendResult> {
  try {
    const { data: run, error: runErr } = await svc
      .from("scout_runs")
      .select(
        "notification_sent, notification_status, notification_provider_id",
      )
      .eq("id", runId)
      .maybeSingle();
    if (runErr) throw new Error(runErr.message);
    const sentRun = run as {
      notification_sent?: boolean | null;
      notification_status?: string | null;
      notification_provider_id?: string | null;
    } | null;
    if (
      sentRun?.notification_sent === true ||
      sentRun?.notification_status === "sent"
    ) {
      logEvent({
        level: "info",
        fn: "notifications",
        event: "already_sent",
        scout_type: scoutType,
        user_id: userId,
        run_id: runId,
      });
      return {
        ok: true,
        reason: "already_sent",
        providerId: sentRun.notification_provider_id ?? null,
      };
    }

    const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
    if (!resendKey) {
      logEvent({
        level: "warn",
        fn: "notifications",
        event: "resend_key_missing",
        scout_type: scoutType,
        user_id: userId,
        run_id: runId,
      });
      return { ok: false, reason: "resend_key_missing" };
    }

    const ctx = await resolveUserContext(svc, userId);
    if (!ctx.email) {
      logEvent({
        level: "info",
        fn: "notifications",
        event: "skipped_no_email",
        scout_type: scoutType,
        user_id: userId,
        run_id: runId,
      });
      return { ok: false, reason: "missing_email" };
    }

    const { subject, html } = await render(ctx);

    const sent = await sendWithRetry(resendKey, ctx.email, subject, html);
    if (!sent.ok) return sent;

    const { error: updateErr } = await svc
      .from("scout_runs")
      .update({ notification_sent: true })
      .eq("id", runId);
    if (updateErr) {
      // Send succeeded but flag didn't flip — log so reconciliation can see
      // the inconsistency, but still report success upstream.
      logEvent({
        level: "warn",
        fn: "notifications",
        event: "notification_sent_flag_update_failed",
        scout_type: scoutType,
        user_id: userId,
        run_id: runId,
        msg: updateErr.message,
      });
    }

    logEvent({
      level: "info",
      fn: "notifications",
      event: "sent",
      scout_type: scoutType,
      user_id: userId,
      run_id: runId,
      provider_id: sent.providerId ?? null,
    });
    return sent;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "warn",
      fn: "notifications",
      event: "send_failed",
      scout_type: scoutType,
      user_id: userId,
      run_id: runId,
      msg,
    });
    return { ok: false, reason: "send_failed", error: msg };
  }
}

// ---------------------------------------------------------------------------
// User context lookup — email comes from auth.users, language from
// user_preferences. Never stored in public.*.
// ---------------------------------------------------------------------------

export async function resolveUserContext(
  svc: SupabaseClient,
  userId: string,
): Promise<UserContext> {
  let email: string | null = null;
  try {
    const { data, error } = await svc.auth.admin.getUserById(userId);
    if (error) throw new Error(error.message);
    email = data.user?.email ?? null;
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "notifications",
      event: "auth_lookup_failed",
      user_id: userId,
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  let language = "en";
  let healthNotificationsEnabled = true;
  try {
    const { data } = await svc
      .from("user_preferences")
      .select("preferred_language, health_notifications_enabled")
      .eq("user_id", userId)
      .maybeSingle();
    if (data) {
      if (
        typeof data.preferred_language === "string" && data.preferred_language
      ) {
        language = data.preferred_language;
      }
      if (typeof data.health_notifications_enabled === "boolean") {
        healthNotificationsEnabled = data.health_notifications_enabled;
      }
    }
  } catch {
    // Missing column (pre-migration) or row — defaults stand.
  }

  return { email, language, healthNotificationsEnabled };
}

// ---------------------------------------------------------------------------
// Resend transport
// ---------------------------------------------------------------------------

async function sendWithRetry(
  resendKey: string,
  toEmail: string,
  subject: string,
  html: string,
  maxRetries = 3,
): Promise<NotificationSendResult> {
  const body = JSON.stringify({
    from: FROM,
    to: [toEmail],
    subject,
    html,
    reply_to: REPLY_TO,
  });

  let lastError: string | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      if (res.ok) {
        const payload = await safeJson(res);
        return {
          ok: true,
          providerId: typeof payload?.id === "string" ? payload.id : null,
        };
      }

      const detail = await safeText(res);
      if (res.status < 500) {
        // Client error — don't retry.
        logEvent({
          level: "error",
          fn: "notifications",
          event: "resend_client_error",
          status: res.status,
          msg: detail.slice(0, 500),
        });
        return {
          ok: false,
          reason: "resend_client_error",
          status: res.status,
          error: detail.slice(0, 500),
        };
      }
      lastError = `HTTP ${res.status}: ${detail.slice(0, 500)}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }

    if (attempt < maxRetries - 1) {
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  logEvent({
    level: "error",
    fn: "notifications",
    event: "resend_exhausted",
    attempts: maxRetries,
    msg: lastError ?? "unknown",
  });
  return {
    ok: false,
    reason: "resend_exhausted",
    error: lastError ?? "unknown",
  };
}

async function safeJson(
  res: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const value = await res.json();
    return value && typeof value === "object"
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Template primitives
// ---------------------------------------------------------------------------

interface BaseHtmlParams {
  variant: NotificationVariant;
  eyebrowLabel: string;
  contextLabel?: string;
  headerTitle: string;
  headerSubtitle: string;
  summary: string;
  articles: Article[];
  articlesSectionTitle: string;
  metadataPanels?: MetadataPanel[];
  cueText?: string;
  secondarySection?: SecondarySection;
  cautionSection?: CautionSection;
  ctaText?: string;
  language: string;
}

export function buildBaseHtml(p: BaseHtmlParams): string {
  const theme = VARIANT_THEME[p.variant];
  const accentColor = theme.accent;
  const accentSoft = theme.accentSoft;

  const articlesHtml = renderArticleCards(p.articles, accentColor);
  const summaryHtml = markdownToHtml(p.summary, accentColor);
  const metadataHtml = p.metadataPanels?.length
    ? renderMetadataPanels(p.metadataPanels, accentColor)
    : "";
  const cueHtml = p.cueText ? renderCueBlock(p.cueText, accentSoft) : "";
  const articlesSection = p.articles.length > 0 && p.articlesSectionTitle
    ? renderSection({
      title: p.articlesSectionTitle,
      content: articlesHtml,
    })
    : "";
  const secondarySection = p.secondarySection
    ? renderSection({
      title: p.secondarySection.title,
      summary: p.secondarySection.summary,
      articles: p.secondarySection.articles ?? [],
      accentColor,
    })
    : "";
  const cautionSection = p.cautionSection
    ? renderCautionSection(p.cautionSection, accentColor)
    : "";

  const ctaSection = p.ctaText
    ? `
      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid ${COLORS.border}; text-align: center;">
        <a href="https://www.scoutpost.ai" style="color: ${accentColor}; text-decoration: none; font-size: 14px; font-family: ${FONT_BODY};">
          ${escapeHtml(p.ctaText)}
        </a>
      </div>`
    : "";

  const disclaimer = getString("email_disclaimer", p.language);

  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
</head>
<body bgcolor="${COLORS.bg}" style="margin: 0; padding: 0; background: ${COLORS.bg}; color: ${COLORS.ink}; font-family: ${FONT_BODY}; line-height: 1.6;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${COLORS.bg}" style="width: 100%; background: ${COLORS.bg};">
      <tr>
        <td align="center" bgcolor="${COLORS.bg}" style="padding: 24px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${COLORS.surfaceAlt}" style="width: 100%; max-width: 640px; border: 1px solid ${COLORS.borderStrong}; background: ${COLORS.surfaceAlt};">
            <tr>
              <td bgcolor="${COLORS.surfaceAlt}" style="padding: 24px 24px 8px 24px; background: ${COLORS.surfaceAlt};">
                <a href="https://www.scoutpost.ai" style="text-decoration: none; border: 0;">
                  <img src="https://www.scoutpost.ai/logo-scoutpost-email@2x.png" alt="scoutpost" width="180" height="45" style="display: block; border: 0; outline: none; text-decoration: none; max-width: 100%; height: auto;" />
                </a>
              </td>
            </tr>
            <tr>
              <td bgcolor="${COLORS.surfaceAlt}" style="padding: 16px 24px 20px 24px; border-bottom: 1px solid ${COLORS.border}; background: ${COLORS.surfaceAlt};">
            <div style="margin-bottom: 14px; font-family: ${FONT_MONO}; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: ${accentColor};">
                ${escapeHtml(p.eyebrowLabel)}${
    p.contextLabel
      ? `<span style="color: ${COLORS.inkSubtle};"> / ${
        escapeHtml(p.contextLabel)
      }</span>`
      : ""
  }
            </div>
            <h1 style="margin: 0; font-family: ${FONT_DISPLAY}; font-size: 34px; line-height: 1.1; font-weight: 700; color: ${COLORS.ink};">
                ${escapeHtml(p.headerTitle)}
            </h1>
            <p style="margin: 10px 0 0 0; font-family: ${FONT_BODY}; font-size: 16px; color: ${COLORS.inkMuted};">
                ${escapeHtml(p.headerSubtitle)}
            </p>
              </td>
            </tr>
            <tr>
              <td bgcolor="${COLORS.surfaceAlt}" style="padding: 24px; background: ${COLORS.surfaceAlt};">
            ${metadataHtml}
            ${cueHtml}
            <div bgcolor="${accentSoft}" style="margin-bottom: 20px; padding: 18px 18px 16px 18px; background: ${accentSoft}; border: 1px solid ${COLORS.border}; border-left: 3px solid ${accentColor}; color: ${COLORS.ink};">
                <div style="margin: 0 0 8px 0; font-family: ${FONT_MONO}; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: ${accentColor};">
                    ${escapeHtml(getString("key_findings", p.language))}
                </div>
                ${summaryHtml}
            </div>
            ${articlesSection}
            ${secondarySection}
            ${cautionSection}
            ${ctaSection}
            <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid ${COLORS.border}; text-align: center; font-size: 11px; color: ${COLORS.inkSubtle}; line-height: 1.5; font-family: ${FONT_BODY};">
                ${disclaimer}
            </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
</body>
</html>
`;
}

function renderMetadataPanels(
  panels: MetadataPanel[],
  accentColor: string,
): string {
  return `
    <div style="margin-bottom: 20px;">
      ${
    panels.map((panel) => {
      const value = panel.href
        ? `<a href="${escapeHtml(panel.href)}" style="color: ${
          panel.valueColor ?? accentColor
        }; text-decoration: none; word-break: break-word;">${
          escapeHtml(panel.value)
        }</a>`
        : escapeHtml(panel.value);
      return `
          <div style="margin-bottom: 10px; padding: 12px 14px; background: ${COLORS.surface}; border: 1px solid ${COLORS.border}; color: ${COLORS.ink};">
            <div style="margin: 0 0 6px 0; font-family: ${FONT_MONO}; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: ${COLORS.inkSubtle};">
              ${escapeHtml(panel.label)}
            </div>
            <div style="font-family: ${FONT_BODY}; font-size: 14px; color: ${COLORS.ink};">
              ${value}
            </div>
          </div>
        `;
    }).join("")
  }
    </div>
  `;
}

function renderCueBlock(cueText: string, background: string): string {
  return `
    <div style="margin-bottom: 20px; padding: 12px 14px; background: ${background}; border: 1px solid ${COLORS.border}; font-family: ${FONT_BODY}; font-size: 13px; color: ${COLORS.inkMuted}; font-style: italic;">
      ${escapeHtml(cueText)}
    </div>
  `;
}

function renderSection(
  section: {
    title: string;
    summary?: string;
    articles?: Article[];
    content?: string;
    accentColor?: string;
  },
): string {
  const accentColor = section.accentColor ?? COLORS.primary;
  const summaryHtml = section.summary
    ? `<div style="margin-bottom: 14px; padding: 14px; background: ${COLORS.surface}; border: 1px solid ${COLORS.border}; border-left: 3px solid ${accentColor}; color: ${COLORS.ink};">${
      markdownToHtml(section.summary, accentColor)
    }</div>`
    : "";
  const articlesHtml = section.articles?.length
    ? renderArticleCards(section.articles, accentColor)
    : "";

  return `
    <div style="margin-top: 24px;">
      <div style="margin: 0 0 12px 0; font-family: ${FONT_MONO}; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: ${accentColor};">
        ${escapeHtml(section.title)}
      </div>
      ${section.content ?? ""}
      ${summaryHtml}
      ${articlesHtml}
    </div>
  `;
}

function renderCautionSection(
  section: CautionSection,
  accentColor: string,
): string {
  return `
    <div style="margin-top: 24px; padding: 16px; background: ${COLORS.surfaceMuted}; border: 1px solid ${COLORS.border}; border-left: 3px solid ${accentColor}; color: ${COLORS.ink};">
      <div style="margin: 0 0 10px 0; font-family: ${FONT_MONO}; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: ${accentColor};">
        ${escapeHtml(section.title)}
      </div>
      ${
    section.items.map((item) =>
      `<div style="margin-top: 8px; font-family: ${FONT_BODY}; font-size: 14px; color: ${COLORS.inkMuted};">${
        escapeHtml(item)
      }</div>`
    ).join("")
  }
    </div>
  `;
}

export function renderArticleCards(
  articles: Article[],
  accentColor: string,
  limit = 5,
): string {
  let out = "";
  for (const article of articles.slice(0, limit)) {
    const url = escapeHtml(article.url ?? "#");
    const title = escapeHtml(article.title ?? "Untitled");
    let summary = article.summary ?? "";
    summary = escapeHtml(summary);
    if (summary.includes("\n")) {
      const lines = summary.split("\n");
      summary = lines.slice(0, 5).join("<br>");
      if (lines.length > 5) summary += "<br>...";
    } else if (summary.length > 150) {
      summary = summary.slice(0, 150) + "...";
    }
    const source = escapeHtml(article.source ?? "");
    const sourceHtml = source
      ? `<div style="margin-top: 10px; font-family: ${FONT_MONO}; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: ${COLORS.inkSubtle};">${source}</div>`
      : "";
    const originalTitle = escapeHtml(article.originalTitle ?? "");
    const originalHtml = originalTitle
      ? `<div style="font-size: 11px; color: ${COLORS.inkSubtle}; margin-top: 6px; font-family: ${FONT_BODY};">Original: ${originalTitle}</div>`
      : "";

    out += `
      <div style="margin-bottom: 12px; padding: 14px 16px; background: ${COLORS.surface}; border: 1px solid ${COLORS.border}; border-left: 3px solid ${accentColor}; color: ${COLORS.ink};">
        <a href="${url}" style="color: ${COLORS.ink}; text-decoration: none; font-family: ${FONT_DISPLAY}; font-size: 22px; line-height: 1.2; font-weight: 700;">
          ${title}
        </a>
        ${originalHtml}
        <p style="margin: 10px 0 0 0; color: ${COLORS.inkMuted}; font-size: 14px; font-family: ${FONT_BODY};">
          ${summary}
        </p>
        ${sourceHtml}
      </div>
      `;
  }
  return out;
}

/** Port of `group_facts_by_source` in notification_service.py. */
export interface Fact {
  source_url?: string | null;
  source_title?: string | null;
  source_domain?: string | null;
  statement?: string | null;
}

export function groupFactsBySource(
  facts: Fact[],
  sourceLimit = 5,
): Article[] {
  interface Bucket {
    title: string;
    url: string;
    source: string;
    statements: string[];
  }
  const grouped = new Map<string, Bucket>();
  const order: string[] = [];

  facts.forEach((fact, idx) => {
    const key = fact.source_url || `__no_url_${idx}__`;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = {
        title: fact.source_title ?? "Untitled",
        url: fact.source_url ?? "",
        source: fact.source_domain ?? "",
        statements: [],
      };
      grouped.set(key, bucket);
      order.push(key);
    }
    bucket.statements.push(fact.statement ?? "");
  });

  const result: Article[] = [];
  for (const key of order.slice(0, sourceLimit)) {
    const b = grouped.get(key);
    if (!b) continue;
    const summary = b.statements.length === 1
      ? b.statements[0]
      : b.statements.map((s) => `\u2022 ${s}`).join("\n");
    result.push({
      title: b.title,
      summary,
      url: b.url,
      source: b.source,
    });
  }
  return result;
}

/**
 * Port of `markdown_to_html` in notification_service.py. Supports headers (##,
 * ###), bold (**), bullet lists (- * \u2022), links [text](url). HTML in the
 * source is escaped before markdown constructs are restored as safe HTML.
 */
export function markdownToHtml(text: string, accentColor = "#7c6fc7"): string {
  if (!text) return "";

  const lines = text.split("\n");
  const out: string[] = [];
  let inList = false;

  for (const raw of lines) {
    const stripped = raw.trim();

    if (stripped.startsWith("### ")) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(
        `<h3 style="margin: 16px 0 8px 0; font-size: 18px; line-height: 1.3; color: ${COLORS.ink}; font-family: ${FONT_DISPLAY};">${
          escapeHtml(stripped.slice(4))
        }</h3>`,
      );
      continue;
    }
    if (stripped.startsWith("## ")) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(
        `<h2 style="margin: 20px 0 12px 0; font-size: 24px; line-height: 1.2; color: ${COLORS.ink}; font-family: ${FONT_DISPLAY};">${
          escapeHtml(stripped.slice(3))
        }</h2>`,
      );
      continue;
    }

    const listMatch = /^[-*\u2022]\s+(.+)$/.exec(stripped);
    if (listMatch) {
      if (!inList) {
        out.push(
          `<ul style="margin: 8px 0; padding-left: 20px; color: ${COLORS.inkMuted};">`,
        );
        inList = true;
      }
      const item = processInlineMarkdown(listMatch[1], accentColor);
      out.push(
        `<li style="margin: 4px 0; color: ${COLORS.inkMuted}; font-family: ${FONT_BODY};">${item}</li>`,
      );
      continue;
    }

    if (inList && stripped) {
      out.push("</ul>");
      inList = false;
    }

    if (!stripped) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push("<br>");
      continue;
    }

    const processed = processInlineMarkdown(stripped, accentColor);
    out.push(
      `<p style="margin: 8px 0; color: ${COLORS.inkMuted}; line-height: 1.6; font-family: ${FONT_BODY};">${processed}</p>`,
    );
  }

  if (inList) out.push("</ul>");
  return out.join("\n");
}

function processInlineMarkdown(text: string, accentColor: string): string {
  // Same placeholder-swap strategy as the Python version: extract markdown
  // constructs, escape the remaining text, then re-insert them as safe HTML.
  const boldParts: string[] = [];
  const linkParts: Array<[string, string]> = [];

  let t = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, a: string, b: string) => {
      const idx = linkParts.length;
      linkParts.push([a, b]);
      return `\x00LINK${idx}\x00`;
    },
  );
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => {
    const idx = boldParts.length;
    boldParts.push(inner);
    return `\x00BOLD${idx}\x00`;
  });

  t = escapeHtml(t);

  boldParts.forEach((content, idx) => {
    t = t.replace(
      `\x00BOLD${idx}\x00`,
      `<strong>${escapeHtml(content)}</strong>`,
    );
  });
  linkParts.forEach(([linkText, linkUrl], idx) => {
    t = t.replace(
      `\x00LINK${idx}\x00`,
      `<a href="${
        escapeHtml(linkUrl)
      }" style="color: ${accentColor}; text-decoration: none;">${
        escapeHtml(linkText)
      }</a>`,
    );
  });
  return t;
}

export function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function matchedTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname)
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (path) return path.slice(0, 120);
    return parsed.hostname;
  } catch {
    return "Matched page";
  }
}

function matchedSourceFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function buildProfileUrl(platform: string, handle: string): string {
  const h = handle.replace(/^@/, "");
  switch (platform.toLowerCase()) {
    case "instagram":
      return `https://instagram.com/${h}`;
    case "x":
    case "twitter":
      return `https://twitter.com/${h}`;
    case "facebook":
      return `https://facebook.com/${h}`;
    case "tiktok":
      return `https://tiktok.com/@${h}`;
    case "linkedin":
      return `https://www.linkedin.com/in/${h}`;
    default:
      return `https://${platform}.com/${h}`;
  }
}
