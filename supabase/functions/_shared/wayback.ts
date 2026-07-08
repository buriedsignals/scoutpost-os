/**
 * Trust layer part 2 — Wayback Machine corroboration (PAGE-ARCHIVE-PRD U4, KTD5).
 *
 * Independent third-party copy of the monitored URL at change time via the
 * authenticated Save Page Now v2 (SPN2) API. Corroboration cannot be added
 * retroactively — once the page changes again the moment is gone — so it fires
 * per change event. Fire-and-forget and non-fatal: a snapshot is a snapshot
 * whether or not Wayback answers; the outcome is only a status on the row.
 *
 * Third-party etiquette (loop ground rule): at most ONE save request and ONE
 * status check per snapshot, single attempt, no retry loops. `if_not_archived_
 * within` dedupes against a recent capture server-side.
 *
 * Stale-corroboration guard (KTD5): the dedupe window means SPN2 can hand back
 * an EXISTING capture that predates this run. A pre-change capture presented as
 * corroboration would contradict the snapshot it decorates, so when the
 * returned capture predates `captured_at` we record `stale` (URL retained but
 * excluded from corroboration labeling) rather than `success`.
 */

const SPN2_SAVE_URL = "https://web.archive.org/save";
const SPN2_STATUS_URL = "https://web.archive.org/save/status";
// 45 minutes, in seconds (KTD5). SPN2 accepts a seconds integer.
const IF_NOT_ARCHIVED_WITHIN = "2700";
const WAYBACK_ABORT_MS = 20_000;
// A returned capture within this skew of captured_at is treated as "this run's"
// capture, not a stale pre-change one (clock skew + save latency).
const STALE_SKEW_MS = 5 * 60 * 1000;

export type WaybackStatus =
  | "success"
  | "stale"
  | "submitted"
  | "disabled"
  | string; // "failed:<class>"

export interface WaybackResult {
  status: WaybackStatus;
  waybackUrl?: string;
}

export interface WaybackDeps {
  fetchImpl?: typeof fetch;
  accessKey?: string;
  secretKey?: string;
}

/** Operator kill switch: any falsy-ish SNAPSHOT_WAYBACK_ENABLED disables all
 * SPN2. Matched loosely on purpose — this guard exists to STOP monitored URLs
 * reaching the public Internet Archive, so `0`/`no`/`off`/`False`/`disabled`
 * must all engage it, not just the exact string `false`. Unset → default on. */
export function waybackKillSwitchOn(): boolean {
  const v = Deno.env.get("SNAPSHOT_WAYBACK_ENABLED");
  if (v === undefined) return false;
  return /^(false|0|no|off|disabled?)$/i.test(v.trim());
}

function keys(deps: WaybackDeps): { access: string; secret: string } | null {
  const access = deps.accessKey ?? Deno.env.get("SPN_ACCESS_KEY") ?? "";
  const secret = deps.secretKey ?? Deno.env.get("SPN_SECRET_KEY") ?? "";
  if (!access || !secret) return null;
  return { access, secret };
}

/** Parse an SPN2 14-digit timestamp (YYYYMMDDhhmmss, UTC) to epoch ms. */
export function parseWaybackTimestamp(ts: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}

/**
 * Submit `url` to SPN2 and resolve a corroboration status.
 *
 *   disabled            — per-scout wayback off, kill switch on, or no keys
 *   success + url       — archived at/after captured_at
 *   stale + url         — an existing capture predating captured_at (dedupe)
 *   submitted           — job accepted, archived URL not yet resolvable
 *   failed:<class>      — save/status error (never throws)
 */
export async function submitToWayback(
  url: string,
  capturedAt: string,
  waybackEnabled: boolean,
  deps: WaybackDeps = {},
): Promise<WaybackResult> {
  if (!waybackEnabled || waybackKillSwitchOn()) return { status: "disabled" };
  const k = keys(deps);
  if (!k) return { status: "disabled" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const auth = `LOW ${k.access}:${k.secret}`;

  // 1. One save request.
  let jobId: string;
  try {
    const body = new URLSearchParams({
      url,
      if_not_archived_within: IF_NOT_ARCHIVED_WITHIN,
      skip_first_archive: "1",
    });
    const res = await withFuse((signal) =>
      fetchImpl(SPN2_SAVE_URL, {
        method: "POST",
        headers: {
          "Authorization": auth,
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        redirect: "error",
        signal,
      })
    );
    if (!res.ok) {
      await res.body?.cancel();
      return { status: `failed:save_http_${res.status}` };
    }
    const data = await res.json() as {
      job_id?: string;
      timestamp?: string;
      original_url?: string;
      message?: string;
    };
    // Some responses (recent dedup hit) already carry a timestamp.
    if (data.timestamp) {
      return classify(data.timestamp, data.original_url ?? url, capturedAt);
    }
    if (!data.job_id) return { status: "failed:no_job" };
    jobId = data.job_id;
  } catch (e) {
    return { status: transportClass(e, "save") };
  }

  // 2. One status check (no polling loop).
  try {
    const res = await withFuse((signal) =>
      fetchImpl(`${SPN2_STATUS_URL}/${jobId}`, {
        method: "GET",
        headers: { "Authorization": auth, "Accept": "application/json" },
        redirect: "error",
        signal,
      })
    );
    if (!res.ok) {
      await res.body?.cancel();
      return { status: "submitted" }; // job exists; URL just not resolved yet
    }
    const data = await res.json() as {
      status?: string;
      timestamp?: string;
      original_url?: string;
    };
    if (data.status === "success" && data.timestamp) {
      return classify(data.timestamp, data.original_url ?? url, capturedAt);
    }
    if (data.status === "error") return { status: "failed:job_error" };
    return { status: "submitted" }; // pending
  } catch {
    return { status: "submitted" }; // save succeeded; status unresolved
  }
}

function classify(timestamp: string, originalUrl: string, capturedAt: string): WaybackResult {
  const waybackUrl = `https://web.archive.org/web/${timestamp}/${originalUrl}`;
  const archiveMs = parseWaybackTimestamp(timestamp);
  const capturedMs = Date.parse(capturedAt);
  if (archiveMs !== null && !Number.isNaN(capturedMs) && archiveMs < capturedMs - STALE_SKEW_MS) {
    return { status: "stale", waybackUrl };
  }
  return { status: "success", waybackUrl };
}

async function withFuse(fn: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const ac = new AbortController();
  const fuse = setTimeout(() => ac.abort(), WAYBACK_ABORT_MS);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(fuse);
  }
}

function transportClass(e: unknown, phase: string): string {
  return (e as { name?: string }).name === "AbortError"
    ? `failed:${phase}_timeout`
    : `failed:${phase}_network`;
}
