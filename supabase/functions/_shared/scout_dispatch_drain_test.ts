import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { drainScoutDispatchInWaves } from "./scout_dispatch_drain.ts";

Deno.test("scout dispatch refills ten-wide waves up to thirty launches", async () => {
  const queued = Array.from({ length: 326 }, (_, index) => index + 1);
  const initialClaims = queued.splice(0, 10);
  const claimLimits: number[] = [];
  let active = 0;
  let peakActive = 0;

  const result = await drainScoutDispatchInWaves({
    initialClaims,
    capacity: 10,
    maxLaunches: 30,
    claimNext: (limit) => {
      claimLimits.push(limit);
      return Promise.resolve(queued.splice(0, limit));
    },
    dispatch: async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await Promise.resolve();
      active -= 1;
    },
  });

  assertEquals(result, {
    launched: 30,
    waves: 3,
    dispatchRejections: 0,
    ceilingReached: true,
  });
  assertEquals(claimLimits, [10, 10]);
  assertEquals(peakActive, 10);
  assertEquals(active, 0);
  assertEquals(queued.length, 296);
});

Deno.test("eleven bounded drain invocations clear a 326-scout burst", async () => {
  const queued = Array.from({ length: 326 }, (_, index) => index + 1);
  const launchesPerDrain: number[] = [];

  while (queued.length > 0) {
    const result = await drainScoutDispatchInWaves({
      initialClaims: queued.splice(0, 10),
      capacity: 10,
      maxLaunches: 30,
      claimNext: (limit) => Promise.resolve(queued.splice(0, limit)),
      dispatch: () => Promise.resolve(),
    });
    launchesPerDrain.push(result.launched);
  }

  assertEquals(launchesPerDrain, [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 26]);
  assertEquals(queued.length, 0);
});

Deno.test("scout dispatch stops when the queue is empty", async () => {
  const queued = Array.from({ length: 26 }, (_, index) => index + 1);
  const initialClaims = queued.splice(0, 10);

  const result = await drainScoutDispatchInWaves({
    initialClaims,
    capacity: 10,
    maxLaunches: 30,
    claimNext: (limit) => Promise.resolve(queued.splice(0, limit)),
    dispatch: () => Promise.resolve(),
  });

  assertEquals(result, {
    launched: 26,
    waves: 3,
    dispatchRejections: 0,
    ceilingReached: false,
  });
  assertEquals(queued.length, 0);
});

Deno.test("one rejected dispatch does not prevent later waves", async () => {
  const queued = [3];
  const dispatched: number[] = [];

  const result = await drainScoutDispatchInWaves({
    initialClaims: [1, 2],
    capacity: 2,
    maxLaunches: 10,
    claimNext: (limit) => Promise.resolve(queued.splice(0, limit)),
    dispatch: (claim) => {
      dispatched.push(claim);
      return claim === 2
        ? Promise.reject(new Error("injected dispatch failure"))
        : Promise.resolve();
    },
  });

  assertEquals(dispatched, [1, 2, 3]);
  assertEquals(result, {
    launched: 3,
    waves: 2,
    dispatchRejections: 1,
    ceilingReached: false,
  });
});

Deno.test("scout dispatch rejects a claim batch above its bounded wave", async () => {
  await assertRejects(
    () =>
      drainScoutDispatchInWaves({
        initialClaims: [1, 2, 3],
        capacity: 2,
        maxLaunches: 10,
        claimNext: () => Promise.resolve([]),
        dispatch: () => Promise.resolve(),
      }),
    RangeError,
    "dispatch wave returned 3 claims for limit 2",
  );
});
