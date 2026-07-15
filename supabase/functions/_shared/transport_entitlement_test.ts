import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ApiError } from "./errors.ts";
import { assertTransportEntitled } from "./transport_entitlement.ts";

function clientFor(
  result: { data: { tier?: string } | null; error: { message: string } | null },
): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve(result) }),
      }),
    }),
  } as unknown as SupabaseClient;
}

async function withCreditsEnabled(run: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get("COJO_CREDITS_ENABLED");
  Deno.env.set("COJO_CREDITS_ENABLED", "true");
  try {
    await run();
  } finally {
    if (previous === undefined) Deno.env.delete("COJO_CREDITS_ENABLED");
    else Deno.env.set("COJO_CREDITS_ENABLED", previous);
  }
}

Deno.test("Fleet entitlement accepts Pro and Team tiers", async () => {
  await withCreditsEnabled(async () => {
    await assertTransportEntitled(
      clientFor({ data: { tier: "pro" }, error: null }),
      "user-pro",
    );
    await assertTransportEntitled(
      clientFor({ data: { tier: "team" }, error: null }),
      "user-team",
    );
  });
});

Deno.test("Fleet entitlement rejects Free tier with the public error contract", async () => {
  await withCreditsEnabled(async () => {
    const error = await assertRejects(
      () =>
        assertTransportEntitled(
          clientFor({ data: { tier: "free" }, error: null }),
          "user-free",
        ),
      ApiError,
      "Fleet Scout is a Pro/Team feature",
    );
    assertEquals(error.status, 403);
    assertEquals(error.code, "transport_forbidden");
  });
});

Deno.test("Fleet entitlement fails closed when the tier read fails", async () => {
  await withCreditsEnabled(async () => {
    const error = await assertRejects(
      () =>
        assertTransportEntitled(
          clientFor({ data: null, error: { message: "database unavailable" } }),
          "user-error",
          "transport-test",
        ),
      ApiError,
    );
    assertEquals(error.status, 403);
    assertEquals(error.code, "transport_forbidden");
  });
});
