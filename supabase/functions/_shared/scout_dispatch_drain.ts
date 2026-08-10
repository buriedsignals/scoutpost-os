export interface ScoutDispatchDrainOptions<T> {
  initialClaims: T[];
  capacity: number;
  maxLaunches: number;
  claimNext: (limit: number) => Promise<T[]>;
  dispatch: (claim: T) => Promise<unknown>;
}

export interface ScoutDispatchDrainResult {
  launched: number;
  waves: number;
  dispatchRejections: number;
  ceilingReached: boolean;
}

/**
 * Refill dispatch capacity as each wave settles, stopping at a hard per-request
 * launch ceiling. Database leases remain the authority for global concurrency.
 */
export async function drainScoutDispatchInWaves<T>(
  options: ScoutDispatchDrainOptions<T>,
): Promise<ScoutDispatchDrainResult> {
  const { capacity, maxLaunches, claimNext, dispatch } = options;
  assertPositiveInteger("capacity", capacity);
  assertPositiveInteger("maxLaunches", maxLaunches);

  let claims = options.initialClaims;
  let launched = 0;
  let waves = 0;
  let dispatchRejections = 0;

  while (claims.length > 0) {
    const remaining = maxLaunches - launched;
    const waveLimit = Math.min(capacity, remaining);
    if (waveLimit <= 0) break;
    if (claims.length > waveLimit) {
      throw new RangeError(
        `dispatch wave returned ${claims.length} claims for limit ${waveLimit}`,
      );
    }

    waves += 1;
    const settled = await Promise.allSettled(claims.map(dispatch));
    dispatchRejections += settled.filter((result) =>
      result.status === "rejected"
    ).length;
    launched += claims.length;

    if (launched >= maxLaunches) break;
    claims = await claimNext(Math.min(capacity, maxLaunches - launched));
  }

  return {
    launched,
    waves,
    dispatchRejections,
    ceilingReached: launched >= maxLaunches,
  };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
