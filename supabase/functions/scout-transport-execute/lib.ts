/**
 * Pure helpers for scout-transport-execute, split from index.ts so tests can
 * import them without triggering Deno.serve.
 */

import {
  type TransportMode,
  validateTransportConfig,
} from "../_shared/transport_config.ts";

/** Sub-daily transport runs are high-volume; expire their run rows sooner
 * than the platform-wide 90-day default. */
export const TRANSPORT_RUN_TTL_DAYS = 30;

/** A `running` row younger than this blocks a new run of the same scout —
 * matches the stale-run sweeper's grace window so a wedged run can't block
 * forever. */
export const OVERLAP_GRACE_MINUTES = 45;

export function transportRunExpiresAt(now: Date = new Date()): string {
  return new Date(now.getTime() + TRANSPORT_RUN_TTL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString();
}

export function overlapCutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() - OVERLAP_GRACE_MINUTES * 60 * 1000)
    .toISOString();
}

/** Modes gain real executors in U2 (aircraft), U3 (vessel), U4 (satellite).
 * Until then the worker completes runs as unbilled `skipped`. */
export const IMPLEMENTED_MODES: ReadonlySet<TransportMode> = new Set();

export interface RunningRowRef {
  id: string;
  started_at: string;
}

/**
 * Deterministic single-winner election among concurrent runs of one scout:
 * every dispatcher inserts (or brings) its own `running` row first, then the
 * OLDEST row within the grace window proceeds (started_at asc, id asc as the
 * tiebreak). Everyone else yields. Unlike a check-then-act SELECT, two racers
 * can never both proceed — and because each racer only yields to a STRICTLY
 * older-or-lower peer, they can never both yield either.
 */
export function shouldYieldToPeer(
  our: RunningRowRef,
  peers: RunningRowRef[],
): boolean {
  return peers.some((p) =>
    p.id !== our.id &&
    (p.started_at < our.started_at ||
      (p.started_at === our.started_at && p.id < our.id))
  );
}

export interface TransportPrecheck {
  ok: boolean;
  mode?: TransportMode;
  hasCriteria?: boolean;
  error?: string;
}

/** Non-billable pre-check: parse + validate the scout's transport config.
 * Runs before any credit charge so a misconfigured scout never bills. */
export function precheckTransportScout(rawConfig: unknown): TransportPrecheck {
  const validated = validateTransportConfig(rawConfig ?? {});
  if (validated.config === null) return { ok: false, error: validated.error };
  return {
    ok: true,
    mode: validated.config.mode,
    hasCriteria: Boolean(validated.config.criteria),
  };
}
