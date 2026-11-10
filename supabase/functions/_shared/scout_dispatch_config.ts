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

const QUEUE_BACKED_TYPES = new Set(["web", "beat", "civic", "social"]);
// Types that stay on the direct path unless SCOUT_DISPATCH_QUEUE_TYPES lists
// them. A5 of the social plan removes the exception.
const OPT_IN_QUEUE_TYPES = new Set(["social"]);

/**
 * Whether execute-scout sends this scout type through the dispatch queue.
 * Web, beat and civic are on unless SCOUT_DISPATCH_QUEUE_ENABLED is off or
 * SCOUT_DISPATCH_QUEUE_TYPES omits them. Social is on only when that list is
 * set and names it, so deploying the social worker changes nothing until the
 * secret is set, and unsetting it switches back without a deploy.
 */
export function isQueueBackedScoutType(
  scoutType: string,
  readEnv: EnvReader = (name) => Deno.env.get(name),
): boolean {
  const enabled = readEnv("SCOUT_DISPATCH_QUEUE_ENABLED")?.trim().toLowerCase();
  if (enabled && ["0", "false", "no", "off"].includes(enabled)) return false;
  if (!QUEUE_BACKED_TYPES.has(scoutType)) return false;

  const configuredTypes = readEnv("SCOUT_DISPATCH_QUEUE_TYPES");
  if (!configuredTypes) return !OPT_IN_QUEUE_TYPES.has(scoutType);
  return new Set(
    configuredTypes.split(",").map((value) => value.trim().toLowerCase()),
  ).has(scoutType);
}
