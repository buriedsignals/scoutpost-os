/**
 * One clock for a bounded request.
 *
 * Hosted Edge requests are cut at 150 seconds of idle time. A stage that
 * wants to start asks whether the remaining time still covers the reserve the
 * later stages need plus a floor for itself; a stage that runs asks for a
 * timeout bounded by what is left. The Page fallback has used the same
 * arithmetic since #480; this makes it reusable.
 */
export interface RequestBudget {
  /** Milliseconds left, never negative. */
  remainingMs(): number;
  elapsedMs(): number;
  /**
   * True when remaining time minus `reserveMs` still leaves at least
   * `floorMs`. A refusal marks the budget exhausted for diagnostics.
   */
  canStart(opts: { reserveMs: number; floorMs: number }): boolean;
  /** The smaller of `defaultMs` and remaining minus reserve, floored at 0. */
  timeoutFor(defaultMs: number, opts: { reserveMs: number }): number;
  readonly exhausted: boolean;
}

export function createRequestBudget(opts: {
  totalMs: number;
  now?: () => number;
}): RequestBudget {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  let exhausted = false;
  const remainingMs = () => Math.max(0, opts.totalMs - (now() - startedAt));
  return {
    remainingMs,
    elapsedMs: () => Math.max(0, now() - startedAt),
    canStart({ reserveMs, floorMs }) {
      const ok = remainingMs() - reserveMs >= floorMs;
      if (!ok) exhausted = true;
      return ok;
    },
    timeoutFor(defaultMs, { reserveMs }) {
      return Math.max(0, Math.min(defaultMs, remainingMs() - reserveMs));
    },
    get exhausted() {
      return exhausted;
    },
  };
}
