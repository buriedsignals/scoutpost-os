import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_BENCHMARK_FETCH_TIMEOUT_MS,
  resolveBenchmarkFetchTimeoutMs,
  strictDescendantCaptureUrls,
  waitForScoutRun,
} from "./_bench_shared.ts";

Deno.test("benchmark fetch window outlives the hosted request idle boundary", () => {
  assert(DEFAULT_BENCHMARK_FETCH_TIMEOUT_MS > 150_000);
  assertEquals(
    resolveBenchmarkFetchTimeoutMs(undefined),
    DEFAULT_BENCHMARK_FETCH_TIMEOUT_MS,
  );
  assertEquals(
    resolveBenchmarkFetchTimeoutMs("invalid"),
    DEFAULT_BENCHMARK_FETCH_TIMEOUT_MS,
  );
  assertEquals(resolveBenchmarkFetchTimeoutMs("5000"), 5_000);
});

Deno.test("positive notification waits through pending until delivery is recorded", async () => {
  const originalFetch = globalThis.fetch;
  const statuses = ["pending", "sent"];
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: "run-1",
          status: "success",
          articles_count: 1,
          error_message: null,
          notification_status: statuses.shift(),
        }),
        { status: 200 },
      ),
    );
  try {
    const run = await waitForScoutRun(
      {
        supabaseUrl: "https://example.test",
        serviceKey: "service",
        anonKey: "anon",
        apiKey: "api",
        ownerEmail: "test@example.test",
        userId: "user-1",
      },
      "run-1",
      { intervalMs: 0, timeoutMs: 1_000, waitForPositiveNotification: true },
    );
    assertEquals(run.notification_status, "sent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Basel listing evidence counts same-run strict-descendant captures, not initial child units", () => {
  const captures = strictDescendantCaptureUrls(
    "https://www.baselland.ch/politik/medienmitteilungen/",
    [
      "https://www.baselland.ch/politik/medienmitteilungen/",
      "https://www.baselland.ch/politik/medienmitteilungen/2026/notice-1",
      "https://www.baselland.ch/politik/medienmitteilungen/2026/notice-2?ref=list",
      "https://www.baselland.ch/other/notice-3",
    ],
  );
  assertEquals(captures, [
    "https://www.baselland.ch/politik/medienmitteilungen/2026/notice-1",
    "https://www.baselland.ch/politik/medienmitteilungen/2026/notice-2?ref=list",
  ]);
});
