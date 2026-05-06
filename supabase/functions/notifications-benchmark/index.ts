/**
 * notifications-benchmark Edge Function — fires one sample email per scout
 * type (Page / Beat / Civic / Social) at a target address via Resend.
 *
 * Purpose: visually confirm the ported HTML templates render correctly across
 * Gmail / Apple Mail / Outlook before wiring real traffic through. Dev/QA
 * tool — NOT scheduled, NOT exposed to end users.
 *
 * Route:
 *   POST /notifications-benchmark
 *     body: { email?: string, language?: string, types?: string[] }
 *     -> 200 { sent: [{ type, ok, error? }, ...] }
 *
 * Defaults:
 *   - email:    tom@buriedsignals.com
 *   - language: "en"
 *   - types:    ["page", "beat", "civic", "social"]
 *
 * Auth: shared service auth. Invoke from the local/remote CLI:
 *   curl -X POST $SUPABASE_URL/functions/v1/notifications-benchmark \
 *     -H "X-Service-Key: $INTERNAL_SERVICE_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{"email":"tom@buriedsignals.com"}'
 */

import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { AuthError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { buildBaseHtml } from "../_shared/notifications.ts";
import { getString } from "../_shared/email_translations.ts";

const RESEND_URL = "https://api.resend.com/emails";
const FROM = "coJournalist <info@cojournalist.ai>";
const REPLY_TO = "info@cojournalist.ai";
const DEFAULT_TO = "tom@buriedsignals.com";
const DEFAULT_TYPES = ["page", "beat", "civic", "social"] as const;

type ScoutType = typeof DEFAULT_TYPES[number];

interface BenchResult {
  type: ScoutType;
  ok: boolean;
  status?: number;
  error?: string;
  subject: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  try {
    requireServiceKey(req);
  } catch (e) {
    return jsonFromError(e instanceof AuthError ? e : new AuthError());
  }

  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!resendKey) {
    return jsonError("RESEND_API_KEY not configured", 500);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    // empty body is fine.
  }

  const email = typeof body.email === "string" && body.email.trim()
    ? body.email.trim()
    : DEFAULT_TO;
  const language = typeof body.language === "string" && body.language.trim()
    ? body.language.trim()
    : "en";
  const typesInput = Array.isArray(body.types) && body.types.length > 0
    ? (body.types.filter(
      (t): t is ScoutType =>
        typeof t === "string" &&
        (DEFAULT_TYPES as readonly string[]).includes(t),
    ))
    : ([...DEFAULT_TYPES] as ScoutType[]);

  const results: BenchResult[] = [];
  for (const type of typesInput) {
    const { subject, html } = buildSample(type, language);
    try {
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM,
          to: [email],
          subject,
          html,
          reply_to: REPLY_TO,
        }),
      });
      const ok = res.ok;
      const detail = ok ? "" : (await res.text()).slice(0, 500);
      await res.body?.cancel();
      results.push({
        type,
        ok,
        status: res.status,
        subject,
        ...(ok ? {} : { error: detail }),
      });
    } catch (e) {
      results.push({
        type,
        ok: false,
        subject,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logEvent({
    level: "info",
    fn: "notifications-benchmark",
    event: "done",
    to: email,
    language,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });

  return jsonOk({ to: email, language, sent: results });
});

// ---------------------------------------------------------------------------
// Sample payloads per scout type — chosen to exercise each distinctive
// editorial section (metadata panels, findings block, secondary section,
// caution block).
// ---------------------------------------------------------------------------

function buildSample(
  type: ScoutType,
  language: string,
): { subject: string; html: string } {
  switch (type) {
    case "page":
      return buildPageSample(language);
    case "beat":
      return buildBeatSample(language);
    case "civic":
      return buildCivicSample(language);
    case "social":
      return buildSocialSample(language);
  }
}

function buildPageSample(language: string): { subject: string; html: string } {
  const scoutName = "[BENCHMARK] Oakland City Hall";
  const url = "https://www.oaklandca.gov/news";
  const html = buildBaseHtml({
    variant: "page",
    eyebrowLabel: getString("page_scout", language),
    contextLabel: getString("scout_alert", language),
    headerTitle: getString("scout_alert", language),
    headerSubtitle: scoutName,
    summary:
      "- Council approved a $12M transit fund for zero-emission buses.\n" +
      "- Commitment to reduce city-fleet emissions by 30% by 2028.\n" +
      "- Public comment period opens May 1.",
    articles: [{
      title: "Council approves $12M transit fund",
      url: "https://www.oaklandca.gov/news/press-release-042026",
      summary: "New language added to the public notice and funding memo.",
      source: "oaklandca.gov",
    }],
    articlesSectionTitle: getString("see_what_matched", language),
    metadataPanels: [
      {
        label: getString("monitoring_url", language),
        value: url,
        href: url,
      },
      {
        label: getString("criteria", language),
        value: "climate action, transit funding",
      },
    ],
    cueText: getString("page_scout_cue", language),
    language,
  });
  return {
    subject: `\uD83D\uDD0E Page Scout: ${scoutName}`,
    html,
  };
}

function buildBeatSample(language: string): { subject: string; html: string } {
  const scoutName = "[BENCHMARK] Zurich climate beat";
  const location = "Zurich, Switzerland";
  const html = buildBaseHtml({
    variant: "beat",
    eyebrowLabel: getString("beat_scout", language),
    contextLabel: location.toUpperCase(),
    headerTitle: getString("beat_scout", language),
    headerSubtitle: scoutName,
    summary: "- Canton opens bids for city-wide e-bus fleet.\n" +
      "- Protest outside parliament against cut to solar subsidies.\n" +
      "- Vote scheduled May 15 on road pricing proposal.",
    articles: [
      {
        title: "Canton opens bids for e-bus fleet",
        url: "https://nzz.example/article-1",
        summary: "Fleet replacement contract expected to run to 2030.",
        source: "nzz.example",
      },
      {
        title: "Solar subsidy cuts spark protest",
        url: "https://tagesanzeiger.example/article-2",
        summary: "Hundreds gathered at parliament Thursday evening.",
        source: "tagesanzeiger.example",
      },
      {
        title: "Road pricing vote scheduled",
        url: "https://srf.example/article-3",
        summary: "Outcome will set precedent for other Swiss cantons.",
        source: "srf.example",
      },
    ],
    articlesSectionTitle: getString("top_stories", language),
    cueText: getString("beat_scout_cue", language),
    secondarySection: {
      title: getString("government_municipal", language),
      summary:
        "- City transport committee published a revised cost estimate.\n" +
        "- Final vote now expected next Tuesday.",
      articles: [{
        title: "Transport committee memo",
        url: "https://stadt-zurich.example/memo",
        summary: "Updated procurement and scheduling details.",
        source: "stadt-zurich.example",
      }],
    },
    language,
  });
  return {
    subject: `\uD83D\uDCE1 Beat Scout: ${location} \u2014 ${scoutName}`,
    html,
  };
}

function buildCivicSample(language: string): { subject: string; html: string } {
  const scoutName = "[BENCHMARK] Oakland Council watch";
  const html = buildBaseHtml({
    variant: "civic",
    eyebrowLabel: getString("civic_scout", language),
    contextLabel: getString("key_findings", language),
    headerTitle: getString("civic_scout", language),
    headerSubtitle: scoutName,
    summary:
      "- **Commit to cutting fleet emissions 30% by 2028** ([April minutes](https://oakland.example/minutes-2026-04.pdf))\n" +
      "- **Approve $12M transit fund** ([Resolution 2026-042](https://oakland.example/res-2026-042.pdf))\n" +
      "- **Reopen public comment on zoning map** ([Agenda](https://oakland.example/agenda-2026-05.pdf))",
    articles: [],
    articlesSectionTitle: "",
    cueText: getString("civic_scout_cue", language),
    language,
  });
  return {
    subject: `\uD83C\uDFDB\uFE0F Civic Scout: ${scoutName}`,
    html,
  };
}

function buildSocialSample(
  language: string,
): { subject: string; html: string } {
  const scoutName = "[BENCHMARK] Mayor Khan watch";
  const handle = "SadiqKhan";
  const platform = "x";
  const profileUrl = `https://twitter.com/${handle}`;
  const html = buildBaseHtml({
    variant: "social",
    eyebrowLabel: getString("social_scout", language),
    contextLabel: `@${handle} on ${platform.toUpperCase()}`,
    headerTitle: getString("social_scout", language),
    headerSubtitle: scoutName,
    summary:
      "Three new posts in the past 24 hours: a transit zone update, a climate milestone, and a response to opposition.",
    articles: [
      {
        title: `@${handle}`,
        url: "https://twitter.com/SadiqKhan/status/1",
        summary: "ULEZ expansion has cut roadside NO2 by 46% in outer London.",
        source: platform,
      },
      {
        title: `@${handle}`,
        url: "https://twitter.com/SadiqKhan/status/2",
        summary: "London on track for the zero-emission bus fleet pledge.",
        source: platform,
      },
      {
        title: `@${handle}`,
        url: "https://twitter.com/SadiqKhan/status/3",
        summary: "Responding to tonight's debate on transit funding.",
        source: platform,
      },
    ],
    articlesSectionTitle: getString("new_posts", language),
    metadataPanels: [{
      label: getString("profile_label", language),
      value: profileUrl,
      href: profileUrl,
    }],
    cueText: getString("social_scout_cue", language),
    cautionSection: {
      title: getString("removed_posts", language),
      items: [
        `${
          getString("removed_label", language)
        } An older post about budget revisions has been deleted from the profile.`,
      ],
    },
    language,
  });
  return {
    subject: `\uD83D\uDCAC Social Scout: @${handle} \u2014 ${scoutName}`,
    html,
  };
}
