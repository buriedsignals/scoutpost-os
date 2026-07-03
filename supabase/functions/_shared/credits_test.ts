import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { decrementOrThrow } from "./credits.ts";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}

Deno.test("decrementOrThrow no-ops unless credits are explicitly enabled", async () => {
  const prior = Deno.env.get("COJO_CREDITS_ENABLED");
  Deno.env.delete("COJO_CREDITS_ENABLED");
  let called = false;
  const client = {
    rpc() {
      called = true;
      return Promise.resolve({ data: null, error: null });
    },
  };

  const result = await decrementOrThrow(client as never, {
    userId: "user",
    cost: 10,
    scoutId: null,
    scoutType: "web",
    operation: "website_extraction",
  });

  assertEquals(called, false);
  assertEquals(result.owner, "user");
  assertEquals(result.balance, Number.MAX_SAFE_INTEGER);
  restoreEnv("COJO_CREDITS_ENABLED", prior);
});

Deno.test("decrementOrThrow uses the decrement_credits RPC when credits are enabled", async () => {
  const prior = Deno.env.get("COJO_CREDITS_ENABLED");
  Deno.env.set("COJO_CREDITS_ENABLED", "true");
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({
        data: [{ balance: 993, owner: "org" }],
        error: null,
      });
    },
  };

  try {
    const result = await decrementOrThrow(client as never, {
      userId: "user-1",
      cost: 7,
      scoutId: "scout-1",
      scoutType: "beat",
      operation: "beat",
    });

    assertEquals(result, { balance: 993, owner: "org" });
    assertEquals(calls, [{
      fn: "decrement_credits",
      args: {
        p_user_id: "user-1",
        p_cost: 7,
        p_scout_id: "scout-1",
        p_scout_type: "beat",
        p_operation: "beat",
      },
    }]);
  } finally {
    restoreEnv("COJO_CREDITS_ENABLED", prior);
  }
});

Deno.test("calculateMonitoringCost covers the transport sub-daily window", async () => {
  const { calculateMonitoringCost, getTransportCost } = await import("./credits.ts");
  assertEquals(calculateMonitoringCost(1, "3h"), 240);
  assertEquals(calculateMonitoringCost(1, "6h"), 120);
  assertEquals(calculateMonitoringCost(1, "12h"), 60);
  assertEquals(calculateMonitoringCost(1, "daily"), 30);
  assertEquals(calculateMonitoringCost(2, "3h"), 480);
  // Per-run transport cost: 1 base, +1 with free-text criteria.
  assertEquals(getTransportCost(false), 1);
  assertEquals(getTransportCost(true), 2);
});
