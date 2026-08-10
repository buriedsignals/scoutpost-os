export interface ScoutDispatchConfig {
  concurrency: number;
  maxLaunchesPerDrain: number;
  leaseSeconds: number;
  maxAttempts: number;
}

type EnvReader = (name: string) => string | undefined;

/**
 * Keep the fail-safe queue admission aligned with the two ordinary browser
 * slots. The all-Workflow profile overrides concurrency to ten; its actual
 * browser admission remains owned by the downstream crawler queue.
 */
export function resolveScoutDispatchConfig(
  readEnv: EnvReader = (name) => Deno.env.get(name),
): ScoutDispatchConfig {
  return {
    concurrency: boundedInt(
      readEnv("SCOUT_DISPATCH_CONCURRENCY"),
      2,
      1,
      20,
    ),
    maxLaunchesPerDrain: boundedInt(
      readEnv("SCOUT_DISPATCH_MAX_LAUNCHES_PER_DRAIN"),
      30,
      1,
      30,
    ),
    leaseSeconds: boundedInt(
      readEnv("SCOUT_DISPATCH_LEASE_SECONDS"),
      900,
      60,
      3_600,
    ),
    maxAttempts: boundedInt(
      readEnv("SCOUT_DISPATCH_MAX_ATTEMPTS"),
      3,
      1,
      10,
    ),
  };
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
