import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { completeBatch } from "./index.ts";
import { handleCrawlerProxy } from "../crawler-proxy/index.ts";
import { executeCrawlerProxy } from "../_shared/crawler_workflow_proxy.ts";
import { scrape } from "../_shared/scrape.ts";
const HTTP2 =
  "Unexpected error:\nError: Page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://example.org/article";
function fixture(overrides: Record<string, unknown> = {}) {
  const job = {
    id: "job",
    batch_id: "batch",
    lease_token: "lease",
    operation: "scrape" as "scrape" | "snapshot",
    request_kind: "proxy",
    continuation_key: "request",
    status: "running",
    attempts: 3,
    max_attempts: 3,
    error_class: null as string | null,
    error_message: null as string | null,
    result_manifest: null,
    ...overrides,
  };
  const classes: unknown[] = [];
  const client = {
    from: () => {
      let columns: string[] = [];
      const query = {
        select: (value: string) => {
          columns = value.split(",");
          return query;
        },
        eq: () => query,
        maybeSingle: () =>
          Promise.resolve({
            data: Object.fromEntries(
              columns.map((key) => [key, job[key as keyof typeof job]]),
            ),
            error: null,
          }),
      };
      return query;
    },
    storage: {
      from: () => ({ remove: () => Promise.resolve({ error: null }) }),
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === "complete_crawler_job") {
        classes.push(args.p_error_class);
        job.error_class = args.p_error_class as string;
        job.error_message = args.p_error as string;
        job.status = args.p_error_class === "anti_bot"
          ? "fallback_required"
          : job.attempts >= job.max_attempts
          ? "terminal_failed"
          : "retryable_failed";
      } else if (name === "complete_crawler_fallback") {
        job.status = "terminal_failed";
        job.error_class = "fallback_terminal";
        job.error_message = args.p_error as string;
      } else {return Promise.resolve({
          data: { id: job.id, status: "queued", dedupe_key: args.p_dedupe_key },
          error: null,
        });}
      return Promise.resolve({ data: true, error: null });
    },
  };
  const completion = {
    job_id: job.id,
    attempt_id: "lease",
    execution_id: "execution",
    ok: false as const,
    error_class: "retryable" as const,
    error: HTTP2,
  };
  return { job, client, completion, classes };
}
Deno.test("HTTP2 completion delegates only exhausted proxy scrapes", async () => {
  const cases = [
    { job: { attempts: 1 }, expected: "retryable" },
    { job: { attempts: 2 }, expected: "retryable" },
    { job: {}, expected: "anti_bot" },
    { job: { attempts: 1, max_attempts: 1 }, expected: "anti_bot" },
    { job: { attempts: 3, max_attempts: 5 }, expected: "retryable" },
    { job: { operation: "snapshot" }, expected: "retryable" },
    { job: { operation: "parse_pdf" }, expected: "retryable" },
    { job: { request_kind: "benchmark" }, expected: "retryable" },
    {
      job: {},
      error: "Page.goto: net::ERR_CONNECTION_RESET",
      expected: "retryable",
    },
    {
      job: {},
      error: "Page.goto: net::ERR_HTTP2_PROTOCOL_ERROR_OTHER",
      expected: "retryable",
    },
    {
      job: {},
      error:
        "Page.goto: Timeout at https://example.org/net::ERR_HTTP2_PROTOCOL_ERROR",
      expected: "retryable",
    },
  ];
  for (const test of cases) {
    const f = fixture(test.job);
    await completeBatch(f.client as never, "batch", [{
      ...f.completion,
      error: test.error ?? HTTP2,
    }]);
    assertEquals(f.classes, [test.expected], JSON.stringify(test));
    assertEquals(f.job.error_message, test.error ?? HTTP2);
  }
  for (const error_class of ["terminal", "timeout"] as const) {
    const f = fixture();
    await completeBatch(f.client as never, "batch", [{
      ...f.completion,
      error_class,
    }]);
    assertEquals(f.classes, [error_class]);
  }
});
for (
  const mode of ["recover", "disabled", "no-key", "firecrawl-fails"] as const
) {
  Deno.test(`exhausted HTTP2 crosses worker, proxy and shared scrape: ${mode}`, async () => {
    const f = fixture();
    const keys = [
      "SCRAPE_PROVIDER",
      "SCRAPE_SERVICE_URL",
      "SCRAPE_SERVICE_TOKEN",
      "FIRECRAWL_API_KEY",
    ];
    const saved = keys.map((key) => Deno.env.get(key));
    const originalFetch = globalThis.fetch;
    let firecrawlCalls = 0;
    try {
      Deno.env.set("SCRAPE_PROVIDER", "crawl4ai");
      Deno.env.set(
        "SCRAPE_SERVICE_URL",
        "https://project.supabase.co/functions/v1/crawler-proxy",
      );
      Deno.env.set("SCRAPE_SERVICE_TOKEN", "test-token");
      Deno.env.delete("FIRECRAWL_API_KEY");
      if (mode !== "no-key") Deno.env.set("FIRECRAWL_API_KEY", "test-key");
      globalThis.fetch = (async (input, init) => {
        if (String(input).startsWith("https://api.firecrawl.dev/")) {
          firecrawlCalls++;
          if (mode === "firecrawl-fails") {
            return new Response("provider unavailable", { status: 503 });
          }
          return Response.json({
            data: {
              markdown: "Recovered article body",
              metadata: {
                sourceURL: "https://example.org/article",
                statusCode: 200,
              },
            },
          });
        }
        // Substitute only provider and database I/O, exercising the real adapters.
        for (let attempt = 1; attempt <= 3; attempt++) {
          f.job.attempts = attempt;
          f.job.status = "running";
          await completeBatch(f.client as never, "batch", [f.completion]);
        }
        return await handleCrawlerProxy(new Request(input as string, init), {
          scrapeToken: "test-token",
          execute: (request) =>
            executeCrawlerProxy(f.client as never, request, {
              load: () => Promise.resolve(f.job),
              now: () => 0,
            }),
        });
      }) as typeof fetch;
      const run = () =>
        scrape("https://example.org/article", {
          tenantKey: "system:http2-test",
          workloadClass: "system",
          noAntibotFallback: mode === "disabled",
        });
      if (mode === "recover") {
        const result = await run();
        assertEquals(result.markdown, "Recovered article body");
        assertEquals(result.served_by, "firecrawl");
      } else {await assertRejects(
          run,
          Error,
          mode === "firecrawl-fails" ? "provider unavailable" : "anti-bot",
        );}
      assertEquals(f.classes, ["retryable", "retryable", "anti_bot"]);
      assertEquals(
        firecrawlCalls,
        mode === "recover" || mode === "firecrawl-fails" ? 1 : 0,
      );
      assertEquals(f.job.error_class, "fallback_terminal");
      assertEquals(
        f.job.error_message,
        "anti-bot fallback delegated to scrape caller",
      );
    } finally {
      globalThis.fetch = originalFetch;
      keys.forEach((key, i) =>
        saved[i] === undefined
          ? Deno.env.delete(key)
          : Deno.env.set(key, saved[i]!)
      );
    }
  });
}
