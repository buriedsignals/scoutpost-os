import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { decrementOrThrow } from "./credits.ts";

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
  if (prior === undefined) Deno.env.delete("COJO_CREDITS_ENABLED");
  else Deno.env.set("COJO_CREDITS_ENABLED", prior);
});
