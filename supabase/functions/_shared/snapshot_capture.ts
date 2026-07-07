/**
 * Page Archive capture orchestration (PAGE-ARCHIVE-PRD U3, KTD2/KTD6/KTD9).
 *
 * Owns everything between "a scrape result that carried capture intent" and
 * "a page_snapshots row exists": the per-scout archive gate (first per-feature
 * tier gate, KTD6), inline-payload decoding with size caps, the third-party
 * artifact download with KTD9's URL/size guards, and the universal degrade
 * ladder — any capture failure on a gated changed/new run still stores a
 * `markdown_only` record of the alert-firing content, because a notified
 * change must never end with zero archival record.
 *
 * Persistence itself (hash verification, content-addressed upload, row
 * insert) lives in snapshot_store.ts (U2); this module never weakens those
 * checks — it only decides WHAT to store and degrades honestly when the
 * evidence tier it wanted is unreachable.
 */

import type { SupabaseClient } from "./supabase.ts";
import type { ScrapeResult } from "./scrape_types.ts";
import { scrape } from "./scrape.ts";
import { WEB_SCOUT_FRESH_SCRAPE_OPTIONS } from "./web_content_canonical.ts";
import { creditsEnabled } from "./credits.ts";
import { logEvent } from "./log.ts";
import {
  type SnapshotArtifact,
  type SnapshotCaptureKind,
  type SnapshotFidelity,
  SnapshotIntegrityError,
  snapshotDiagnostics,
  SnapshotStorageError,
  storeSnapshot,
} from "./snapshot_store.ts";

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SCREENSHOT_DOWNLOAD_ABORT_MS = 20_000;

/** Hosts a Firecrawl screenshot CDN URL may resolve to (KTD9 guard). A
 * leading dot means "any subdomain of"; overridable for provider changes
 * without a deploy. */
const DEFAULT_SCREENSHOT_HOST_SUFFIXES = [
  ".firecrawl.dev",
  ".amazonaws.com",
  ".googleapis.com",
  ".cloudflarestorage.com",
];

export interface ArchiveGateScout {
  user_id: string;
  archive_enabled?: boolean | null;
}

/**
 * KTD6: archive only when the per-scout toggle is on AND (credits are
 * disabled — OSS/self-host — OR the mirrored tier is pro/team). Reads the
 * existing entitlements mirror (user_preferences.tier); no new machinery.
 * Fails closed on read errors: a gating hiccup must not start billing-adjacent
 * captures for free users.
 */
export async function resolveArchiveGate(
  svc: SupabaseClient,
  scout: ArchiveGateScout,
): Promise<boolean> {
  if (!scout.archive_enabled) return false;
  if (!creditsEnabled()) return true;
  try {
    const { data, error } = await svc
      .from("user_preferences")
      .select("tier")
      .eq("user_id", scout.user_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const tier = (data as { tier?: string } | null)?.tier;
    return tier === "pro" || tier === "team";
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "snapshot-capture",
      event: "archive_gate_tier_read_failed",
      user_id: scout.user_id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

export interface CaptureStoreContext {
  scoutId: string;
  userId: string;
  scoutRunId?: string | null;
  rawCaptureId?: string | null;
  captureKind: SnapshotCaptureKind;
  requestedUrl: string;
  /** The alert-firing (detection/baseline) markdown — the universal
   * markdown_only degrade record and the KTD4 trigger binding. */
  fallbackMarkdown: string;
  /** Detection-markdown hashes binding the row to the exact baseline that
   * fired (KTD4). */
  contentSha256?: string | null;
  canonicalContentSha256?: string | null;
}

export interface CaptureOutcome {
  status: string;
  snapshotId?: string;
  fidelity?: SnapshotFidelity;
}

export interface CaptureStoreDeps {
  fetchImpl?: typeof fetch;
  /** Override the capture-fetch scrape (test seam). */
  scrapeImpl?: typeof scrape;
  /** Per-artifact byte ceiling. Defaults to MAX_ARTIFACT_BYTES; overridable so
   * the size-cap degrade paths are exercisable without multi-MB fixtures. */
  maxArtifactBytes?: number;
}

/** Capture fetch timeout sent to the service (KTD1: "inside the existing 25 s
 * primary-scrape budget"). The provider computes its own longer service fuse
 * from this; the abort ceiling below caps the EF's real exposure so a hung
 * capture can never blow the run's wall-clock. */
const CAPTURE_FETCH_TIMEOUT_MS = 25_000;
const CAPTURE_FETCH_ABORT_MS = 40_000;

/** base64 → bytes with a decoded-size ceiling enforced BEFORE decoding. The
 * whitespace-stripped length gives a tight upper bound on the decoded size
 * (decoded == 3/4 of the cleaned length minus padding), so the pre-check
 * alone bounds allocation — no multi-MB buffer is ever materialized over cap. */
export function decodeBase64Capped(
  b64: string,
  maxBytes: number,
  label: string,
): Uint8Array {
  const cleaned = b64.replace(/\s+/g, "");
  const estimated = Math.floor((cleaned.length * 3) / 4);
  if (estimated > maxBytes) {
    throw new SnapshotIntegrityError(
      `artifact_too_large:${label}:${estimated}`,
    );
  }
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    throw new SnapshotIntegrityError(`artifact_decode_failed:${label}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

function screenshotHostSuffixes(): string[] {
  const env = Deno.env.get("SNAPSHOT_SCREENSHOT_HOST_SUFFIXES");
  if (!env?.trim()) return DEFAULT_SCREENSHOT_HOST_SUFFIXES;
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

/** KTD9 URL guard: https only, hostname on the expected CDN allowlist. */
export function isAllowedScreenshotUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return screenshotHostSuffixes().some((suffix) => {
    const s = suffix.toLowerCase();
    return s.startsWith(".")
      ? host === s.slice(1) || host.endsWith(s)
      : host === s;
  });
}

/** Download the Firecrawl-delivered screenshot with KTD9's guards: allowlisted
 * https host, no redirects (an off-host redirect must not be followable),
 * Content-Length precheck, and a streamed byte ceiling. Bytes are stored
 * verbatim — the hash covers exactly what was delivered (R2). */
export async function downloadScreenshot(
  url: string,
  fetchImpl: typeof fetch = fetch,
  maxBytes: number = MAX_ARTIFACT_BYTES,
): Promise<Uint8Array> {
  if (!isAllowedScreenshotUrl(url)) {
    throw new SnapshotIntegrityError("screenshot_url_rejected");
  }
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), SCREENSHOT_DOWNLOAD_ABORT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "error", signal: ac.signal });
  } catch (e) {
    clearTimeout(fuse);
    const aborted = (e as { name?: string }).name === "AbortError";
    throw new SnapshotStorageError(
      aborted ? "screenshot_download_timeout" : "screenshot_download_failed",
    );
  }
  clearTimeout(fuse);
  if (!res.ok) {
    await res.body?.cancel();
    throw new SnapshotStorageError(`screenshot_download_http_${res.status}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new SnapshotIntegrityError(
      `artifact_too_large:screenshot:${declared}`,
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new SnapshotStorageError("screenshot_download_no_body");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SnapshotIntegrityError(
        `artifact_too_large:screenshot:${total}`,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!isPng(bytes)) {
    // Same rule as U1's service-side guard: never seal a non-PNG "screenshot"
    // (error cards, block pages) as evidence.
    throw new SnapshotIntegrityError("screenshot_not_png");
  }
  return bytes;
}

/** Classify a capture failure into the `degraded:<class>` diagnostic. */
export function degradeClass(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/anti-bot|captcha|challenge/i.test(msg)) return "antibot";
  if (/artifact_too_large|payload_too_large/.test(msg)) return "oversize";
  if (/screenshot_url_rejected/.test(msg)) return "bad_cdn_url";
  if (/screenshot_not_png/.test(msg)) return "screenshot_format";
  if (/screenshot_download/.test(msg)) return "artifact_download";
  if (/decode_failed/.test(msg)) return "artifact_decode";
  if (/aborted|timeout|timed out/i.test(msg)) return "capture_timeout";
  if (e instanceof SnapshotIntegrityError) return "integrity";
  if (e instanceof SnapshotStorageError) return "storage";
  return "capture_fetch";
}

/** Build the capture-invariant page_snapshots columns from the run context
 * plus whichever scrape result carries the row's provenance metadata
 * (served_by, timestamps, headers). */
function rowCommon(ctx: CaptureStoreContext, meta: ScrapeResult) {
  return {
    scoutId: ctx.scoutId,
    userId: ctx.userId,
    scoutRunId: ctx.scoutRunId ?? null,
    rawCaptureId: ctx.rawCaptureId ?? null,
    captureKind: ctx.captureKind,
    servedBy: meta.served_by ?? null,
    capturedAt: meta.fetched_at,
    requestedUrl: ctx.requestedUrl,
    finalUrl: meta.source_url ?? null,
    httpStatus: meta.status_code ?? null,
    responseHeaders: meta.response_headers ?? null,
    contentSha256: ctx.contentSha256 ?? null,
    canonicalContentSha256: ctx.canonicalContentSha256 ?? null,
  };
}

/** Universal degrade (KTD2/KTD9): store the alert-firing markdown as a
 * markdown_only record so a notified change never ends with zero archival
 * record. Never throws — a total failure returns `failed:<class>` for the run
 * diagnostics and the run proceeds (R11). */
export async function storeDegraded(
  svc: SupabaseClient,
  ctx: CaptureStoreContext,
  meta: ScrapeResult,
  cls: string,
): Promise<CaptureOutcome> {
  try {
    const stored = await storeSnapshot(svc, {
      ...rowCommon(ctx, meta),
      fidelity: "markdown_only",
      markdown: ctx.fallbackMarkdown,
      artifacts: [],
    });
    return {
      status: `degraded:${cls}`,
      snapshotId: stored.id,
      fidelity: "markdown_only",
    };
  } catch (e) {
    logEvent({
      level: "error",
      fn: "snapshot-capture",
      event: "markdown_only_degrade_failed",
      scout_id: ctx.scoutId,
      run_id: ctx.scoutRunId ?? null,
      msg: e instanceof Error ? e.message : String(e),
    });
    return { status: `failed:${degradeClass(e)}` };
  }
}

/**
 * Store the evidence a single scrape result carries, at the highest fidelity
 * it supports, degrading per KTD2/KTD9:
 *
 *   inline payload (crawl4ai capture fetch)        → fidelity 'full'
 *   screenshot_url + rawHtml (Firecrawl same-fetch) → 'rendered_thirdparty'
 *   anything else / any failure                     → 'markdown_only'
 *
 * Never throws (R11).
 */
export async function storeCaptureResult(
  svc: SupabaseClient,
  ctx: CaptureStoreContext,
  capture: ScrapeResult,
  deps: CaptureStoreDeps = {},
): Promise<CaptureOutcome> {
  const common = rowCommon(ctx, capture);
  const cap = deps.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
  const degrade = (cls: string) => storeDegraded(svc, ctx, capture, cls);

  try {
    if (capture.snapshot) {
      const artifacts: SnapshotArtifact[] = [
        {
          kind: "mhtml",
          bytes: decodeBase64Capped(
            capture.snapshot.mhtml_b64,
            cap,
            "mhtml",
          ),
          claimedSha256: capture.snapshot.mhtml_sha256,
        },
        {
          kind: "screenshot",
          bytes: decodeBase64Capped(
            capture.snapshot.screenshot_b64,
            cap,
            "screenshot",
          ),
          claimedSha256: capture.snapshot.screenshot_sha256,
        },
      ];
      // The capture fetch's own markdown is the row's content record —
      // internally consistent with the artifacts (KTD2); the detection
      // markdown stays baseline/extraction input (Decision 10). An empty
      // capture markdown means the render did not produce a usable record —
      // degrade rather than mixing fetches on a 'full' row (R1).
      if (!capture.markdown?.trim()) {
        return await degrade("empty_capture_markdown");
      }
      const stored = await storeSnapshot(svc, {
        ...common,
        fidelity: "full",
        markdown: capture.markdown,
        artifacts,
      });
      return { status: "stored", snapshotId: stored.id, fidelity: "full" };
    }

    if (capture.screenshot_url && capture.rawHtml?.trim()) {
      const rawHtmlBytes = new TextEncoder().encode(capture.rawHtml);
      if (rawHtmlBytes.byteLength > cap) {
        return await degrade("oversize");
      }
      const screenshotBytes = await downloadScreenshot(
        capture.screenshot_url,
        deps.fetchImpl ?? fetch,
        cap,
      );
      const stored = await storeSnapshot(svc, {
        ...common,
        fidelity: "rendered_thirdparty",
        // Same-fetch provenance (KTD9): this markdown came from the identical
        // fetch that delivered the artifacts.
        markdown: capture.markdown?.trim()
          ? capture.markdown
          : ctx.fallbackMarkdown,
        artifacts: [
          { kind: "screenshot", bytes: screenshotBytes },
          { kind: "rawhtml", bytes: rawHtmlBytes },
        ],
      });
      return {
        status: "stored",
        snapshotId: stored.id,
        fidelity: "rendered_thirdparty",
      };
    }

    return await degrade(
      capture.snapshot_error
        ? `service:${capture.snapshot_error.split(":")[0]}`
        : "capture_unavailable",
    );
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "snapshot-capture",
      event: "capture_store_degraded",
      scout_id: ctx.scoutId,
      run_id: ctx.scoutRunId ?? null,
      msg: e instanceof Error ? e.message : String(e),
    });
    return await degrade(degradeClass(e));
  }
}

/**
 * The single archive-capture orchestration shared by baseline establishment
 * and change events (KTD2/KTD9). Given the detection/baseline scrape result
 * (which already carries same-fetch Firecrawl artifacts when the anti-bot
 * fallback fired), decide the capture path:
 *
 *   detection served by firecrawl  → store its same-fetch artifacts
 *                                     (rendered_thirdparty), no second fetch.
 *   detection served by crawl4ai   → issue ONE provider-pinned capture fetch
 *                                     (snapshot:true, no anti-bot fallback) →
 *                                     fidelity 'full'. A Firecrawl-served
 *                                     capture must never masquerade as a local
 *                                     render, so the pin holds and any capture
 *                                     failure degrades to markdown_only.
 *
 * `capture_kind` is the only difference between baseline and change callers.
 * Never throws (R11): the worst outcome is a `failed:<class>` diagnostic.
 */
export async function performArchiveCapture(
  svc: SupabaseClient,
  ctx: CaptureStoreContext,
  detection: ScrapeResult,
  deps: CaptureStoreDeps = {},
): Promise<CaptureOutcome> {
  // Fallback-served host (KTD9): the detection fetch itself carried the
  // same-fetch rawHtml + screenshot. Store them verbatim (or degrade if the
  // hint didn't produce artifacts).
  if (detection.served_by === "firecrawl") {
    return await storeCaptureResult(svc, ctx, detection, deps);
  }

  // crawl4ai-served → dedicated provider-pinned capture fetch (KTD2).
  const scrapeImpl = deps.scrapeImpl ?? scrape;
  let capture: ScrapeResult;
  try {
    capture = await scrapeImpl(ctx.requestedUrl, {
      ...WEB_SCOUT_FRESH_SCRAPE_OPTIONS,
      snapshot: true,
      noAntibotFallback: true,
      timeoutMs: CAPTURE_FETCH_TIMEOUT_MS,
      abortAfterMs: CAPTURE_FETCH_ABORT_MS,
    });
  } catch (e) {
    // Capture-fetch failure or anti-bot block on the pin → never flip
    // provider; degrade to a markdown_only record of the detection content.
    return await storeDegraded(svc, ctx, detection, degradeClass(e));
  }
  return await storeCaptureResult(svc, ctx, capture, deps);
}

// EdgeRuntime is a Supabase Edge Functions global (same local typing as
// scouts/index.ts). Absent under deno test / self-host without the wrapper.
declare const EdgeRuntime:
  | { waitUntil(promise: Promise<unknown>): void }
  | undefined;

/**
 * Fire snapshot work off the run's critical path (R11: capture never delays or
 * fails the run or its notification). On Supabase, `waitUntil` keeps the
 * isolate alive until the capture finishes; elsewhere the promise runs
 * fire-and-forget with its rejection swallowed. The work itself never throws
 * (performArchiveCapture is total), but the guard is belt-and-braces against
 * a diagnostics write failing.
 */
export function runSnapshotInBackground(work: Promise<unknown>): void {
  const guarded = Promise.resolve(work).catch((e) => {
    logEvent({
      level: "warn",
      fn: "snapshot-capture",
      event: "background_capture_failed",
      msg: e instanceof Error ? e.message : String(e),
    });
  });
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(guarded);
  }
}

export { snapshotDiagnostics };
