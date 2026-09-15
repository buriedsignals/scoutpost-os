import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { incrementAndMaybeNotify } from "./scout_failures.ts";
import type { SupabaseClient } from "./supabase.ts";

Deno.test("disabled Page replay records failures without sending deactivation email", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("RESEND_API_KEY");
  Deno.env.set("RESEND_API_KEY", "test-key");
  let failures = 3;
  let deliveries = 0;
  const svc = {
    rpc: () =>
      Promise.resolve({
        data: [{ consecutive_failures: ++failures, is_active: false }],
        error: null,
      }),
    auth: {
      admin: {
        getUserById: () =>
          Promise.resolve({
            data: { user: { email: "replay@example.test" } },
            error: null,
          }),
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                preferred_language: "en",
                health_notifications_enabled: true,
              },
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  globalThis.fetch = (() => {
    deliveries++;
    return Promise.resolve(
      new Response(JSON.stringify({ id: "email-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  const context = {
    scoutId: "scout-1",
    userId: "user-1",
    scoutName: "Paused page",
    scoutType: "web",
    notificationMode: "disabled" as const,
  };
  try {
    const suppressed = await incrementAndMaybeNotify(svc, context);
    assertEquals(suppressed.consecutiveFailures, 4);
    assertEquals(suppressed.isActive, false);
    assertEquals(suppressed.notified, false);
    assertEquals(deliveries, 0);
    const ordinary = await incrementAndMaybeNotify(svc, {
      scoutId: context.scoutId,
      userId: context.userId,
      scoutName: context.scoutName,
      scoutType: context.scoutType,
    });
    assertEquals(ordinary.notified, true);
    assertEquals(deliveries, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", originalKey);
  }
});
