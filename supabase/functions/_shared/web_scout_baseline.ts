import type { SupabaseClient } from "./supabase.ts";
import type { ScrapeResult } from "./scrape_types.ts";
import { ValidationError } from "./errors.ts";
import { doubleProbe, firecrawlScrape } from "./scrape_firecrawl.ts";
import { scrape as portScrape } from "./scrape.ts";
import { logEvent } from "./log.ts";
import { deriveSourceDomain, sha256Hex } from "./unit_dedup.ts";
import { rawCaptureExpiresAt } from "./canonical_baseline.ts";
import {
  WEB_CANONICALIZER_VERSION,
  WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
  webCanonicalHash,
  webCanonicalHashEnabled,
} from "./web_content_canonical.ts";
import {
  type CaptureOutcome,
  performArchiveCapture,
  resolveArchiveGate,
} from "./snapshot_capture.ts";
import { applyTrustLayer, scoutWaybackEnabled } from "./trust.ts";

export interface WebBaselineScout {
  id: string;
  user_id: string;
  url?: string | null;
  provider?: string | null;
  baseline_established_at?: string | null;
  name?: string | null;
  /** Archive gate (KTD6). Present so baseline snapshot capture can be
   * gated without a second scout read. */
  archive_enabled?: boolean | null;
  /** Per-scout Wayback opt-out (KTD5), threaded to the baseline trust layer. */
  wayback_enabled?: boolean | null;
}

interface WebBaselineDeps {
  /** The provider-agnostic scrape port — the live canonical-hash baseline
   * routes through this (crawl4ai in prod, Firecrawl anti-bot fallback). */
  scrape: typeof portScrape;
  doubleProbe: typeof doubleProbe;
  firecrawlScrape: typeof firecrawlScrape;
  now: () => string;
}

const DEFAULT_DEPS: WebBaselineDeps = {
  scrape: portScrape,
  doubleProbe,
  firecrawlScrape,
  now: () => new Date().toISOString(),
};

async function stampBaseline(
  svc: SupabaseClient,
  scoutId: string,
  patch: Record<string, unknown>,
  deps: WebBaselineDeps,
): Promise<void> {
  const { error } = await svc
    .from("scouts")
    .update({
      baseline_established_at: deps.now(),
      ...patch,
    })
    .eq("id", scoutId);
  if (error) throw new Error(error.message);
}

export async function establishWebBaseline(
  svc: SupabaseClient,
  scout: WebBaselineScout,
  deps: WebBaselineDeps = DEFAULT_DEPS,
): Promise<"firecrawl" | "firecrawl_plain"> {
  if (!scout.url?.trim()) {
    throw new ValidationError("web scouts require a url before scheduling");
  }

  if (webCanonicalHashEnabled() || scout.provider === "firecrawl_plain") {
    // Route through the provider port (crawl4ai in prod; Firecrawl anti-bot
    // fallback for walled hosts). Plain scrape only — no snapshot: the
    // raw_capture this writes is the change-detection baseline, and a
    // full-page-scan capture markdown would systematically diverge from
    // future plain detection fetches and phantom-diff the first run
    // (Decision 10). Baseline snapshot capture is a separate, background step
    // (captureWebBaselineSnapshot).
    const scrape = await deps.scrape(
      scout.url,
      WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
    );
    const markdown = scrape.markdown?.trim() ?? "";
    if (!markdown) {
      throw new ValidationError(
        "unable to establish page baseline from empty content",
      );
    }
    const contentMd = scrape.markdown;
    const { error } = await svc.from("raw_captures").insert({
      user_id: scout.user_id,
      scout_id: scout.id,
      source_url: scout.url,
      source_domain: deriveSourceDomain(scout.url),
      content_md: contentMd,
      content_sha256: await sha256Hex(contentMd),
      canonical_content_sha256: await webCanonicalHash(contentMd),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
      token_count: Math.ceil(contentMd.length / 4),
      captured_at: deps.now(),
      expires_at: rawCaptureExpiresAt(deps.now()),
    });
    if (error) throw new Error(error.message);
    await stampBaseline(svc, scout.id, { provider: "firecrawl_plain" }, deps);
    return "firecrawl_plain";
  }

  const provider = await deps.doubleProbe(
    scout.url,
    `scout-${scout.id}`.slice(0, 128),
  );
  if (provider === "firecrawl") {
    await stampBaseline(svc, scout.id, { provider }, deps);
    return provider;
  }

  const scrape = await deps.firecrawlScrape(scout.url);
  const markdown = scrape.markdown?.trim() ?? "";
  if (!markdown) {
    throw new ValidationError(
      "unable to establish page baseline from empty content",
    );
  }
  const { error } = await svc.from("raw_captures").insert({
    user_id: scout.user_id,
    scout_id: scout.id,
    source_url: scout.url,
    source_domain: deriveSourceDomain(scout.url),
    content_md: scrape.markdown,
    content_sha256: await sha256Hex(scrape.markdown),
    canonical_content_sha256: await webCanonicalHash(scrape.markdown),
    canonicalizer_version: WEB_CANONICALIZER_VERSION,
    token_count: Math.ceil(scrape.markdown.length / 4),
    captured_at: deps.now(),
    expires_at: rawCaptureExpiresAt(deps.now()),
  });
  if (error) throw new Error(error.message);
  await stampBaseline(svc, scout.id, { provider }, deps);
  return provider;
}

export async function ensureWebBaseline(
  svc: SupabaseClient,
  scout: WebBaselineScout,
  deps: WebBaselineDeps = DEFAULT_DEPS,
): Promise<boolean> {
  if (scout.baseline_established_at) return false;
  await establishWebBaseline(svc, scout, deps);
  return true;
}

/**
 * Baseline snapshot capture (PAGE-ARCHIVE-PRD R4, capture_kind='baseline').
 *
 * Deliberately SEPARATE from establishWebBaseline and meant to run in the
 * background (EdgeRuntime.waitUntil) off the scout-creation critical path: a
 * capture fetch can take tens of seconds and web baselines are established
 * synchronously inside the create request (unlike beat, which already
 * backgrounds baseline work to dodge the same gateway-timeout budget).
 *
 * Best-effort and gated (KTD6): a no-op when the scout is not archive-enabled
 * or the tier check fails. Never throws — captures are evidence enrichment,
 * never a reason a scout fails to come up. Uses its OWN detection scrape (with
 * the KTD9 fallback hint) so a fallback-served host lands a rendered_thirdparty
 * baseline row from that fetch's same-fetch artifacts; a crawl4ai-served host
 * triggers one provider-pinned capture fetch inside performArchiveCapture.
 */
export async function captureWebBaselineSnapshot(
  svc: SupabaseClient,
  scout: WebBaselineScout,
  deps: WebBaselineDeps = DEFAULT_DEPS,
): Promise<CaptureOutcome | null> {
  if (!scout.url?.trim()) return null;
  let gateOn: boolean;
  try {
    gateOn = await resolveArchiveGate(svc, scout);
  } catch {
    return null;
  }
  if (!gateOn) return null;

  let detection: ScrapeResult;
  try {
    detection = await deps.scrape(scout.url, {
      ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
      snapshot: "on_fallback",
    });
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "web-scout-baseline",
      event: "baseline_capture_detection_failed",
      scout_id: scout.id,
      user_id: scout.user_id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  const markdown = detection.markdown?.trim() ?? "";
  if (!markdown) return null;

  const outcome = await performArchiveCapture(svc, {
    scoutId: scout.id,
    userId: scout.user_id,
    scoutRunId: null,
    rawCaptureId: null,
    captureKind: "baseline",
    requestedUrl: scout.url,
    fallbackMarkdown: detection.markdown,
    contentSha256: await sha256Hex(detection.markdown),
    canonicalContentSha256: await webCanonicalHash(detection.markdown),
  }, detection);

  // Trust layer (U4) — applied after the row is stored, non-fatal. Baseline
  // rows have no scout_run, so there is nothing to sequence before it here.
  if (outcome.stored) {
    try {
      await applyTrustLayer(
        svc,
        outcome.stored,
        scoutWaybackEnabled(scout.wayback_enabled),
      );
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "web-scout-baseline",
        event: "baseline_trust_failed",
        scout_id: scout.id,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logEvent({
    level: "info",
    fn: "web-scout-baseline",
    event: "baseline_capture_done",
    scout_id: scout.id,
    user_id: scout.user_id,
    msg: outcome.status,
  });
  return outcome;
}

export interface MissingBaselineRunResult {
  change_status: "same";
  articles_count: 0;
  merged_existing_count: 0;
  criteria_ran: false;
  baseline_initialized: true;
}

export async function maybeInitializeMissingWebBaselineRun(
  svc: SupabaseClient,
  scout: WebBaselineScout,
  runId: string,
  deps: WebBaselineDeps = DEFAULT_DEPS,
): Promise<MissingBaselineRunResult | null> {
  if (scout.baseline_established_at) return null;

  await establishWebBaseline(svc, scout, deps);

  const { error: runErr } = await svc
    .from("scout_runs")
    .update({
      status: "success",
      articles_count: 0,
      merged_existing_count: 0,
      completed_at: deps.now(),
      scraper_status: true,
      criteria_status: false,
    })
    .eq("id", runId);
  if (runErr) throw new Error(runErr.message);

  const { error: failureErr } = await svc.rpc("reset_scout_failures", {
    p_scout_id: scout.id,
  });
  if (failureErr) throw new Error(failureErr.message);

  logEvent({
    level: "info",
    fn: "web-scout-baseline",
    event: "initialized_on_run",
    scout_id: scout.id,
    run_id: runId,
    user_id: scout.user_id,
    msg: scout.name ?? "Page Scout",
  });

  return {
    change_status: "same",
    articles_count: 0,
    merged_existing_count: 0,
    criteria_ran: false,
    baseline_initialized: true,
  };
}
