import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveScoutDispatchConfig } from "./scout_dispatch_config.ts";

Deno.test("scout dispatch defaults to the two ordinary Render browser slots", () => {
  assertEquals(resolveScoutDispatchConfig(() => undefined), {
    concurrency: 2,
    maxLaunchesPerDrain: 30,
    leaseSeconds: 900,
    maxAttempts: 3,
  });
});

Deno.test("scout dispatch keeps bounded environment overrides", () => {
  const env = new Map([
    ["SCOUT_DISPATCH_CONCURRENCY", "99"],
    ["SCOUT_DISPATCH_MAX_LAUNCHES_PER_DRAIN", "999"],
    ["SCOUT_DISPATCH_LEASE_SECONDS", "30"],
    ["SCOUT_DISPATCH_MAX_ATTEMPTS", "invalid"],
  ]);

  assertEquals(resolveScoutDispatchConfig((name) => env.get(name)), {
    concurrency: 20,
    maxLaunchesPerDrain: 30,
    leaseSeconds: 60,
    maxAttempts: 3,
  });
});
