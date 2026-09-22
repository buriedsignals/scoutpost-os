import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
// Capture registration rather than changing production bootstrap for tests.
const originalServe = Deno.serve;
let capturedHandler: ((req: Request) => Promise<Response>) | undefined;
try {
  Deno.serve = ((handler: unknown) => {
    if (typeof handler !== "function") {
      throw new Error("expected request handler");
    }
    capturedHandler = handler as (req: Request) => Promise<Response>;
    return {} as Deno.HttpServer;
  }) as typeof Deno.serve;
  // Module-loading boundary: static import would start the server before capture.
  await import("./index.ts");
} finally {
  Deno.serve = originalServe;
}
if (!capturedHandler) throw new Error("Beat handler was not registered");
const handleBeatExecuteRequest = capturedHandler;

const SCOUT_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
type Retrieval =
  | "stale"
  | "failed"
  | "mixed"
  | "search_failed"
  | "search_empty";

// Exercise the actual handler, provider adapters, and lifecycle against an
// in-memory PostgREST boundary. No request is allowed to leave this fixture.
async function runScenario(retrieval: Retrieval, baselineOnly: boolean) {
  const values = {
    SERVICE_SUPABASE_URL: "https://database.invalid",
    SERVICE_SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    INTERNAL_SERVICE_KEY: "test-internal",
    COJO_CREDITS_ENABLED: "true",
    SCRAPE_PROVIDER: "crawl4ai",
    SCRAPE_SERVICE_URL: "https://scraper.invalid",
    SCRAPE_SERVICE_TOKEN: "test-scraper",
    FIRECRAWL_API_KEY: "test-firecrawl",
    OPENROUTER_API_KEY: "",
  };
  const previous = Object.keys(values).map((key) =>
    [key, Deno.env.get(key)] as const
  );
  const originalFetch = globalThis.fetch;
  const initialBaseline = baselineOnly ? null : "2026-01-01T00:00:00Z";
  const scout: Record<string, unknown> = {
    id: SCOUT_ID,
    user_id: USER_ID,
    type: "beat",
    criteria: "transport policy",
    priority_sources: retrieval.startsWith("search_")
      ? []
      : Array.from({ length: 6 }, (_, i) =>
        `https://news.invalid/articles/${i}`),
    baseline_established_at: initialBaseline,
  };
  const run: Record<string, unknown> = {
    id: RUN_ID,
    scout_id: SCOUT_ID,
    user_id: USER_ID,
    status: "queued",
    metadata: {},
  };
  let balance = 100;
  let charges = 0;
  let refunds = 0;
  let failures = 1;
  let scrapes = 0;
  let searches = 0;
  const forbidden: string[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  try {
    for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "GET"
        ? {}
        : await request.json() as Record<string, unknown>;
      if (url.hostname === "scraper.invalid") {
        scrapes++;
        const sourceUrl = String(body.url);
        if (
          retrieval === "failed" ||
          (retrieval === "mixed" && sourceUrl.endsWith("/0"))
        ) {
          // Cover both rejected provider promises and fulfilled empty documents.
          return sourceUrl.endsWith("/0")
            ? json({ detail: "renderer unavailable" }, 503)
            : json({ markdown: "", source_url: sourceUrl });
        }
        return json({
          markdown:
            "# Transport policy\nThe council adopted new transport policy.",
          title: "Transport policy decision",
          metadata: { publishedTime: "2000-01-01T00:00:00Z" },
          source_url: sourceUrl,
          status_code: 200,
        });
      }
      if (
        url.hostname === "api.firecrawl.dev" && url.pathname.endsWith("/search")
      ) {
        searches++;
        return retrieval === "search_failed"
          ? json({ error: "search unavailable" }, 503)
          : json({ success: true, data: { web: [] } });
      }
      if (url.hostname === "database.invalid") {
        const resource = url.pathname.replace("/rest/v1/", "");
        if (resource === "scouts" || resource === "scout_runs") {
          const row = resource === "scouts" ? scout : run;
          if (request.method === "PATCH") Object.assign(row, body);
          return json(request.method === "GET" ? [row] : null);
        }
        if (resource === "scout_run_events") return json(null);
        // Host memory read on every scrape; no row means the static order.
        if (resource === "scrape_host_policy") return json([]);
        if (resource === "rpc/decrement_credits") {
          charges++;
          balance -= Number(body.p_cost);
          return json({ balance, owner: "user" });
        }
        if (resource === "rpc/refund_credits") {
          refunds++;
          balance += Number(body.p_cost);
          return json(null);
        }
        if (resource === "rpc/reset_scout_failures") {
          failures = 0;
          return json(null);
        }
        if (resource === "rpc/increment_scout_failures") {
          failures++;
          return json({ consecutive_failures: failures, is_active: true });
        }
      }
      // In particular: no raw captures, information units, extraction, or mail
      // may be created from known stale source publications.
      forbidden.push(`${request.method} ${request.url}`);
      throw new Error(`unexpected fixture request: ${request.url}`);
    }) as typeof fetch;
    const response = await handleBeatExecuteRequest(
      new Request(
        "https://function.invalid/scout-beat-execute",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": values.INTERNAL_SERVICE_KEY,
          },
          body: JSON.stringify({
            scout_id: SCOUT_ID,
            run_id: RUN_ID,
            baseline_only: baselineOnly,
          }),
        },
      ),
    );
    return {
      status: response.status,
      body: await response.json(),
      scout,
      run,
      initialBaseline,
      balance,
      charges,
      refunds,
      failures,
      scrapes,
      searches,
      forbidden,
    };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("Beat readable stale sources complete without units, billing, alerts, or failure escalation", async (t) => {
  for (const baselineOnly of [true, false]) {
    await t.step(
      baselineOnly
        ? "baseline becomes ready"
        : "monitoring refunds and resets failures",
      async () => {
        const result = await runScenario("stale", baselineOnly);
        // Previously 500: `all 6 sources failed: ` despite six readable responses.
        assertEquals(result.status, 200);
        assertEquals(result.run.status, "success");
        assertEquals(result.run.error_message, null);
        assertEquals(result.run.criteria_status, false);
        assertEquals(
          result.run.notification_status,
          baselineOnly ? "not_applicable" : "skipped",
        );
        assertEquals(result.run.articles_count, 0);
        assertEquals(result.run.sources_scraped, 6);
        assertEquals(result.run.sources_failed, 0);
        assertEquals(result.body.baseline_initialized, baselineOnly);
        assertEquals(typeof result.scout.baseline_established_at, "string");
        if (!baselineOnly) {
          assertEquals(
            result.scout.baseline_established_at,
            result.initialBaseline,
          );
        }
        assertEquals(result.balance, 100);
        assertEquals(result.charges, baselineOnly ? 0 : 1);
        assertEquals(result.refunds, baselineOnly ? 0 : 1);
        assertEquals(result.failures, 0);
        assertEquals(result.scrapes, 6);
        assertEquals(result.forbidden, []);
      },
    );
  }
});

Deno.test("Beat retrieval failures remain failures even alongside stale readable sources", async (t) => {
  for (const retrieval of ["failed", "mixed", "search_failed"] as const) {
    for (const baselineOnly of [true, false]) {
      await t.step(
        `${retrieval}: ${baselineOnly ? "baseline" : "monitoring"}`,
        async () => {
          const result = await runScenario(retrieval, baselineOnly);
          assertEquals(result.status, 502);
          assertEquals(result.run.status, "error");
          assertEquals(result.run.error_class, "provider");
          assertMatch(
            String(result.run.error_message),
            retrieval === "search_failed"
              ? /every search query errored/
              : /renderer unavailable/,
          );
          assertEquals(
            result.scout.baseline_established_at,
            result.initialBaseline,
          );
          assertEquals(result.balance, 100);
          assertEquals(result.charges, baselineOnly ? 0 : 1);
          assertEquals(result.refunds, baselineOnly ? 0 : 1);
          assertEquals(result.failures, baselineOnly ? 1 : 2);
          assertEquals(result.forbidden, []);
          if (retrieval === "search_failed") {
            assertEquals(result.searches > 0, true);
          }
        },
      );
    }
  }
});

Deno.test("Beat genuinely empty discovery remains a non-billable ready baseline or quiet monitoring run", async (t) => {
  for (const baselineOnly of [true, false]) {
    await t.step(baselineOnly ? "baseline" : "monitoring", async () => {
      const result = await runScenario("search_empty", baselineOnly);
      assertEquals(result.status, 200);
      assertEquals(result.run.status, "success");
      assertEquals(result.run.articles_count, 0);
      assertEquals(result.run.sources_scraped, 0);
      assertEquals(typeof result.scout.baseline_established_at, "string");
      assertEquals(
        result.run.notification_status,
        baselineOnly ? "not_applicable" : "skipped",
      );
      assertEquals(result.balance, 100);
      assertEquals(result.refunds, baselineOnly ? 0 : 1);
      assertEquals(result.failures, 0);
      assertEquals(result.scrapes, 0);
      assertEquals(result.searches > 0, true);
      assertEquals(result.forbidden, []);
    });
  }
});
