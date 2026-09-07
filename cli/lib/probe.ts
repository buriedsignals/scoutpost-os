// Human-readable rendering of the shared probe envelope (stderr only; stdout
// stays JSON for agents). Mirrors supabase/functions/_shared/scout_probe.ts.

export interface ProbeCandidate {
  url: string;
  description?: string;
  documents_visible?: number;
  recommended?: boolean;
}

export interface ProbeLike {
  ok?: boolean;
  stage?: string;
  error_code?: string;
  error?: string;
  candidates?: ProbeCandidate[];
  validated?: string[];
  invalid?: string[];
}

/** Codes that mean "the probe worked and found nothing usable". */
export const PROBE_OUTCOME_CODES: readonly string[] = ["no_meetings_detected"];

export function isProbeOutcome(code: string | undefined): boolean {
  return code !== undefined && PROBE_OUTCOME_CODES.includes(code);
}

export function probeSummaryLines(result: ProbeLike): string[] {
  const lines: string[] = [];
  if (result.ok === false) {
    const label = isProbeOutcome(result.error_code)
      ? "No council meetings detected"
      : `Probe failed (${result.error_code ?? "unknown"})`;
    lines.push(`${label}: ${result.error ?? ""}`.trim());
    if (result.invalid?.length) {
      lines.push(`Pages without meetings: ${result.invalid.join(", ")}`);
    }
  } else if (result.ok === true) {
    lines.push(`Probe passed (${result.stage ?? "ok"}).`);
  }
  const candidates = result.candidates ?? [];
  if (candidates.length > 0) {
    lines.push(
      "Pages with meetings visible — pass one or two as --tracked-urls:",
    );
    candidates.forEach((candidate, index) => {
      const marker = candidate.recommended ? " (recommended)" : "";
      const visible = typeof candidate.documents_visible === "number"
        ? ` — ${candidate.documents_visible} meeting document(s) visible`
        : "";
      lines.push(
        `  ${index + 1}. ${candidate.url}${marker}` +
          (candidate.description ? `\n     ${candidate.description}` : "") +
          visible,
      );
    });
  }
  return lines;
}

export function printProbeSummary(result: ProbeLike): void {
  for (const line of probeSummaryLines(result)) console.error(line);
}

/**
 * Structured body of a create-gate rejection (HTTP 422 from POST /scouts),
 * or null when the payload is not a probe envelope.
 */
export function probeEnvelopeFromPayload(payload: unknown): ProbeLike | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== false || typeof record.error_code !== "string") return null;
  return record as ProbeLike;
}
