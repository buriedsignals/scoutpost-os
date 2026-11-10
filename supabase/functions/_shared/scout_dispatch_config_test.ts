import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isQueueBackedScoutType,
  resolveScoutDispatchConfig,
} from "./scout_dispatch_config.ts";

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

function queued(type: string, env: Record<string, string> = {}): boolean {
  return isQueueBackedScoutType(type, (name) => env[name]);
}

Deno.test("web, beat and civic are queue-backed unless switched off or unlisted", () => {
  for (const type of ["web", "beat", "civic"]) {
    assertEquals(queued(type), true);
    assertEquals(queued(type, { SCOUT_DISPATCH_QUEUE_TYPES: "" }), true);
    assertEquals(queued(type, { SCOUT_DISPATCH_QUEUE_ENABLED: "off" }), false);
    assertEquals(
      queued(type, { SCOUT_DISPATCH_QUEUE_TYPES: "web" }),
      type === "web",
    );
  }
});

Deno.test("social is queue-backed only when the secret names it", () => {
  assertEquals(queued("social"), false);
  assertEquals(queued("social", { SCOUT_DISPATCH_QUEUE_TYPES: "" }), false);
  assertEquals(
    queued("social", { SCOUT_DISPATCH_QUEUE_TYPES: "web,beat,civic" }),
    false,
  );
  assertEquals(
    queued("social", { SCOUT_DISPATCH_QUEUE_TYPES: "web, Social" }),
    true,
  );
  assertEquals(
    queued("social", {
      SCOUT_DISPATCH_QUEUE_TYPES: "social",
      SCOUT_DISPATCH_QUEUE_ENABLED: "false",
    }),
    false,
  );
});

Deno.test("transport and unknown types are never queue-backed", () => {
  assertEquals(
    queued("transport", { SCOUT_DISPATCH_QUEUE_TYPES: "transport" }),
    false,
  );
});
