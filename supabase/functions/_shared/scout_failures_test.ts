import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  DEFERRED_RETRY_DELAY_MS,
  incrementAndMaybeNotify,
  isDeferrableRetrievalFailure,
  recordScoutRunFailure,
} from "./scout_failures.ts";
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

// ---------------------------------------------------------------------------
// recordScoutRunFailure
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-22T08:06:00Z");

function accountingClient(
  run: { dispatch_source: string | null; crawler_backend?: string | null },
  options: { enqueueError?: string; alreadyQueued?: boolean } = {},
) {
  const calls: { rpc: string; args: Record<string, unknown> }[] = [];
  let failures = 0;
  const svc = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ rpc: name, args });
      if (name === "enqueue_scout_dispatch") {
        if (options.enqueueError) {
          return Promise.resolve({
            data: null,
            error: { message: options.enqueueError },
          });
        }
        return Promise.resolve({
          data: [{
            run_id: "retry-run",
            enqueued: !options.alreadyQueued,
            crawler_backend: "service",
          }],
          error: null,
        });
      }
      if (name === "increment_scout_failures") {
        return Promise.resolve({
          data: [{ consecutive_failures: ++failures, is_active: true }],
          error: null,
        });
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                metadata: { dispatch_source: run.dispatch_source },
                crawler_backend: run.crawler_backend ?? "workflow",
              },
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  return { svc, calls, failures: () => failures };
}

const base = {
  scoutId: "scout-1",
  userId: "user-1",
  scoutName: "NPCC board",
  scoutType: "web",
  runId: "run-1",
  errorClass: "provider" as const,
  errorMessage:
    'firecrawl scrape failed: 408 {"success":false,"code":"SCRAPE_TIMEOUT"}',
  now: () => NOW,
};

Deno.test("retrieval failures are recognised at run level", () => {
  assertEquals(isDeferrableRetrievalFailure("timeout", null), true);
  assertEquals(
    isDeferrableRetrievalFailure("provider", base.errorMessage),
    true,
  );
  assertEquals(
    isDeferrableRetrievalFailure(
      "provider",
      "Page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://x",
    ),
    true,
  );
  assertEquals(
    isDeferrableRetrievalFailure("provider", "firecrawl scrape failed: 401"),
    false,
  );
  assertEquals(isDeferrableRetrievalFailure("auth", "timeout"), false);
  assertEquals(isDeferrableRetrievalFailure("unknown", "timed out"), false);
});

Deno.test("a scheduled retrieval failure defers once and is not counted", async () => {
  const { svc, calls, failures } = accountingClient({
    dispatch_source: "scheduled",
    crawler_backend: "workflow",
  });
  const result = await recordScoutRunFailure(svc, base);
  assertEquals(result.outcome, "deferred");
  assertEquals(failures(), 0);
  const enqueue = calls.find((c) => c.rpc === "enqueue_scout_dispatch")!;
  assertEquals(enqueue.args.p_source, "deferred_retry");
  assertEquals(enqueue.args.p_retry_of, "run-1");
  assertEquals(enqueue.args.p_run_id, null);
  assertEquals(enqueue.args.p_crawler_backend, "workflow");
  assertEquals(
    enqueue.args.p_scheduled_for,
    new Date(NOW + DEFERRED_RETRY_DELAY_MS).toISOString(),
  );
  assertEquals(calls.some((c) => c.rpc === "increment_scout_failures"), false);
});

Deno.test("an existing retry is reported without a second one or a strike", async () => {
  const { svc, failures } = accountingClient(
    { dispatch_source: "scheduled" },
    { alreadyQueued: true },
  );
  const result = await recordScoutRunFailure(svc, base);
  assertEquals(result, {
    outcome: "deferred",
    retryRunId: "retry-run",
    alreadyQueued: true,
  });
  assertEquals(failures(), 0);
});

Deno.test("manual runs, retries of retries, and non-retrieval errors count as before", async () => {
  for (
    const [run, ctx] of [
      [{ dispatch_source: "manual" }, base],
      [{ dispatch_source: "deferred_retry" }, base],
      [{ dispatch_source: "scheduled" }, {
        ...base,
        errorMessage: "firecrawl scrape failed: 401 unauthorized",
      }],
      [{ dispatch_source: "scheduled" }, {
        ...base,
        errorClass: "unknown" as const,
      }],
      [{ dispatch_source: "scheduled" }, { ...base, runId: null }],
    ] as const
  ) {
    const { svc, calls, failures } = accountingClient(run);
    const result = await recordScoutRunFailure(svc, ctx);
    assertEquals(result.outcome, "counted", JSON.stringify(ctx));
    assertEquals(failures(), 1);
    assertEquals(calls.some((c) => c.rpc === "enqueue_scout_dispatch"), false);
  }
});

Deno.test("non-queue scouts and excluded classes never defer", async () => {
  const transport = accountingClient({ dispatch_source: "scheduled" });
  assertEquals(
    (await recordScoutRunFailure(transport.svc, {
      ...base,
      scoutType: "transport",
    })).outcome,
    "counted",
  );
  const ignored = accountingClient({ dispatch_source: "scheduled" });
  assertEquals(
    (await recordScoutRunFailure(ignored.svc, {
      ...base,
      errorClass: "validation",
    })).outcome,
    "ignored",
  );
  assertEquals(
    (await recordScoutRunFailure(ignored.svc, {
      ...base,
      countFailure: false,
    })).outcome,
    "ignored",
  );
  assertEquals(ignored.failures(), 0);
});

Deno.test("a retry queue failure falls back to counting", async () => {
  const { svc, failures } = accountingClient(
    { dispatch_source: "scheduled" },
    { enqueueError: "scout is paused or not found" },
  );
  const result = await recordScoutRunFailure(svc, base);
  assertEquals(result.outcome, "counted");
  assertEquals(failures(), 1);
});

Deno.test("pre-loaded dispatch facts skip the run lookup", async () => {
  const { svc, calls } = accountingClient({ dispatch_source: "manual" });
  const result = await recordScoutRunFailure(svc, {
    ...base,
    dispatchSource: "scheduled",
    crawlerBackend: "service",
  });
  assertEquals(result.outcome, "deferred");
  const enqueue = calls.find((c) => c.rpc === "enqueue_scout_dispatch")!;
  assertEquals(enqueue.args.p_crawler_backend, "service");
});
