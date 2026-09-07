/**
 * Shared probe contract for scout creation.
 *
 * Every pre-creation probe — the Page scout scraper test (`POST /scouts/test`),
 * the Council scout resolver (`POST /civic/discover`) and sampler
 * (`POST /civic/test`) — and the server-side create gate in `POST /scouts`
 * speak this envelope. One enum, one message table, so the web UI, the CLI,
 * MCP and raw API callers see the same `error_code` for the same input.
 *
 * Two classes of `ok:false`:
 *   - failures: transport, parse or model problems (`unreachable`, …)
 *   - outcomes: the probe worked and found nothing usable
 *     (`no_meetings_detected`). Clients render these as a distinct state with
 *     `candidates`, never as an error panel.
 */

export type ProbeStage = "reach" | "detect" | "sample";

export type ProbeErrorCode =
  | "unreachable"
  | "blocked"
  | "empty_content"
  | "outside_configured_page"
  | "no_meetings_detected"
  | "no_documents"
  | "parse_failed"
  | "model_failed"
  | "criteria_not_met";

export const PROBE_ERROR_CODES: readonly ProbeErrorCode[] = [
  "unreachable",
  "blocked",
  "empty_content",
  "outside_configured_page",
  "no_meetings_detected",
  "no_documents",
  "parse_failed",
  "model_failed",
  "criteria_not_met",
];

const PROBE_OUTCOME_CODES: ReadonlySet<ProbeErrorCode> = new Set([
  "no_meetings_detected",
]);

const PROBE_MESSAGES: Record<ProbeErrorCode, string> = {
  unreachable:
    "The page could not be fetched. Check the address, then try again.",
  blocked:
    "The website blocks automated access, so it cannot be monitored from here.",
  empty_content:
    "The page loaded but contained no readable content. Try the specific " +
    "page you want to monitor rather than a landing page.",
  outside_configured_page:
    "The page redirected to a different address. Enter the final address " +
    "of the page you want to monitor.",
  no_meetings_detected:
    "No council meetings were detected on this website. Choose one of the " +
    "suggested pages, or enter the page that lists individual meetings " +
    "(agendas, minutes or protocols).",
  no_documents:
    "No meeting documents were found on the selected page. Pick the page " +
    "that lists individual meetings rather than a section landing page, " +
    "then test again.",
  parse_failed:
    "Meeting documents were found but none could be read — they may be " +
    "scanned images, password-protected, or temporarily unavailable.",
  model_failed:
    "The documents were read but the extraction service did not respond. " +
    "Try again in a few minutes.",
  criteria_not_met:
    "The page was read successfully but does not currently match the " +
    "criteria. The scout will notify you when it does.",
};

export interface ProbeOk {
  ok: true;
  stage: ProbeStage;
}

export interface ProbeNotOk {
  ok: false;
  stage: ProbeStage;
  error_code: ProbeErrorCode;
  error: string;
}

export type ProbeEnvelope = ProbeOk | ProbeNotOk;

export function probeOk(stage: ProbeStage): ProbeOk {
  return { ok: true, stage };
}

/**
 * Build an `ok:false` envelope. `detail` is appended for operator context but
 * the message always starts with the catalogue text, so clients can rely on
 * a stable, user-facing sentence.
 */
export function probeFailure(
  stage: ProbeStage,
  code: ProbeErrorCode,
  detail?: string,
): ProbeNotOk {
  const base = PROBE_MESSAGES[code];
  const trimmed = detail?.trim();
  return {
    ok: false,
    stage,
    error_code: code,
    error: trimmed ? `${base} (${trimmed.slice(0, 200)})` : base,
  };
}

export function probeMessage(code: ProbeErrorCode): string {
  return PROBE_MESSAGES[code];
}

export function isProbeOutcome(code: string): boolean {
  return PROBE_OUTCOME_CODES.has(code as ProbeErrorCode);
}

export function isProbeErrorCode(value: unknown): value is ProbeErrorCode {
  return typeof value === "string" &&
    (PROBE_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Map a scrape-port error to a reach-stage code. Anti-bot classification is
 * the scrape port's own (`isAntiBotBlockedError`); everything else that the
 * provider could not fetch is `unreachable`.
 */
export function classifyScrapeError(
  error: unknown,
  opts: { antiBot: (e: unknown) => boolean },
): Extract<ProbeErrorCode, "blocked" | "unreachable"> {
  return opts.antiBot(error) ? "blocked" : "unreachable";
}

/** HTTP status used when the create gate rejects a scout. */
export const PROBE_GATE_STATUS = 422;
