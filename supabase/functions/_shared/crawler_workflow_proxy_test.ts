import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CrawlerProxyError,
  executeCrawlerProxy,
  sweepExpiredCrawlerProxyResults,
} from "./crawler_workflow_proxy.ts";
import { isCrawlerWorkflowProxyBase } from "./crawler_proxy_contract.ts";

Deno.test("only the hosted compatibility endpoint gets the queue-aware fuse", () => {
  assertEquals(
    isCrawlerWorkflowProxyBase(
      "https://project.supabase.co/functions/v1/crawler-proxy/",
    ),
    true,
  );
  assertEquals(isCrawlerWorkflowProxyBase("http://scrape-service:8080"), false);
});

function serviceClient() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (
          name === "admit_and_enqueue_crawler_utility" ||
          name === "enqueue_crawler_job"
        ) {
          return Promise.resolve({
            data: {
              id: "job-1",
              dedupe_key: args.p_dedupe_key,
              status: "queued",
            },
            error: null,
          });
        }
        return Promise.resolve({ data: true, error: null });
      },
    },
  };
}

Deno.test("proxy enqueues, nudges dispatch, returns and cleans its result", async () => {
  const svc = serviceClient();
  const statuses = ["queued", "succeeded"];
  let now = 0;
  let dispatches = 0;
  let dispatchedJobId = "";
  let cleaned = 0;
  const result = await executeCrawlerProxy(svc.client as never, {
    operation: "scrape",
    url: "https://Example.Test/page",
    timeoutMs: 25_000,
    waitMs: 30_000,
    workloadClass: "scout",
    tenantKey: "00000000-0000-4000-8000-000000000003",
    requestId: "request-1",
  }, {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    dispatch: (_operation, jobId) => {
      dispatches++;
      dispatchedJobId = jobId;
      return Promise.resolve();
    },
    load: () =>
      Promise.resolve({
        id: "job-1",
        status: statuses.shift() ?? "succeeded",
        error_class: null,
        error_message: null,
        result_manifest: { artifacts: [] },
      }),
    loadResult: () =>
      Promise.resolve({
        markdown: "ok",
        source_url: "https://example.test/page",
      }),
    cleanup: () => {
      cleaned++;
      return Promise.resolve();
    },
  });
  assertEquals(result.markdown, "ok");
  assertEquals(dispatches, 1);
  assertEquals(dispatchedJobId, "job-1");
  assertEquals(now, 2_000);
  assertEquals(cleaned, 1);
  assertEquals(svc.calls[0].name, "enqueue_crawler_job");
  assertEquals(
    svc.calls[0].args.p_tenant_key,
    "00000000-0000-4000-8000-000000000003",
  );
  assertEquals(svc.calls[0].args.p_continuation_key, "request-1");
  assertEquals(svc.calls[0].args.p_operation, "scrape");
});

Deno.test("utility proxy traffic retains atomic utility admission", async () => {
  const svc = serviceClient();
  await executeCrawlerProxy(svc.client as never, {
    operation: "scrape",
    url: "https://example.test/page",
    timeoutMs: 25_000,
    waitMs: 30_000,
    workloadClass: "utility",
    tenantKey: "00000000-0000-4000-8000-000000000003",
    requestId: "request-utility",
  }, {
    now: () => 0,
    load: () =>
      Promise.resolve({
        id: "job-1",
        status: "succeeded",
        error_class: null,
        error_message: null,
        result_manifest: { artifacts: [] },
      }),
    loadResult: () =>
      Promise.resolve({
        markdown: "ok",
        source_url: "https://example.test/page",
      }),
    cleanup: () => Promise.resolve(),
  });
  assertEquals(svc.calls[0].name, "admit_and_enqueue_crawler_utility");
});

Deno.test("proxy closes anti-bot jobs before delegating Firecrawl fallback", async () => {
  const svc = serviceClient();
  const error = await assertRejects(
    () =>
      executeCrawlerProxy(svc.client as never, {
        operation: "scrape",
        url: "https://example.test",
        timeoutMs: 25_000,
        waitMs: 30_000,
        workloadClass: "scout",
        tenantKey: "00000000-0000-4000-8000-000000000003",
        requestId: "request-1",
      }, {
        now: () => 0,
        load: () =>
          Promise.resolve({
            id: "job-1",
            status: "fallback_required",
            error_class: "anti_bot",
            error_message: "challenge",
            result_manifest: null,
          }),
      }),
    CrawlerProxyError,
    "anti-bot",
  );
  assertEquals(error.status, 502);
  assertEquals(svc.calls[1].name, "complete_crawler_fallback");
});

Deno.test("proxy preserves structured PDF compatibility errors", async () => {
  const svc = serviceClient();
  const error = await assertRejects(
    () =>
      executeCrawlerProxy(svc.client as never, {
        operation: "parse_pdf",
        url: "https://example.test/scan.pdf",
        timeoutMs: 120_000,
        waitMs: 205_000,
        workloadClass: "scout",
        tenantKey: "00000000-0000-4000-8000-000000000003",
        requestId: "request-1",
      }, {
        now: () => 0,
        load: () =>
          Promise.resolve({
            id: "job-1",
            status: "terminal_failed",
            error_class: "terminal",
            error_message: "needs_ocr: 12 chars over 4 pages",
            result_manifest: null,
          }),
      }),
    CrawlerProxyError,
  );
  assertEquals(error.status, 422);
  assertEquals(error.detail, { error: "needs_ocr", pages: 4, chars: 12 });
});

Deno.test("proxy sweep closes a stale unclaimed anti-bot fallback", async () => {
  let reads = 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const svc = {
    from() {
      let read = 0;
      const query = {
        select() {
          read = ++reads;
          return query;
        },
        eq() {
          return query;
        },
        not() {
          return query;
        },
        lt() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return Promise.resolve({
            data: read === 1 ? [{ id: "fallback-1" }] : [],
            error: null,
          });
        },
      };
      return query;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: true, error: null });
    },
  };

  assertEquals(
    await sweepExpiredCrawlerProxyResults(
      svc as never,
      "2026-08-10T12:00:00Z",
    ),
    1,
  );
  assertEquals(calls, [{
    name: "complete_crawler_fallback",
    args: {
      p_job_id: "fallback-1",
      p_ok: false,
      p_manifest: null,
      p_error: "crawler proxy caller no longer waiting",
    },
  }]);
});

Deno.test("proxy sweep removes stale result artifacts and clears manifests", async () => {
  let read = 0;
  let removed: string[] = [];
  let clearedIds: string[] = [];
  const manifest = {
    artifacts: [{
      kind: "result",
      path: "results/job-1/result.json.gz",
      bytes: 12,
      sha256: "a".repeat(64),
    }],
  };
  const svc = {
    from() {
      const query = {
        select() {
          read++;
          return query;
        },
        eq() {
          return query;
        },
        not() {
          return query;
        },
        lt() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return Promise.resolve({
            data: read === 1
              ? []
              : [{ id: "job-1", result_manifest: manifest }],
            error: null,
          });
        },
        update() {
          return query;
        },
        in(_column: string, ids: string[]) {
          clearedIds = ids;
          return Promise.resolve({ error: null });
        },
      };
      return query;
    },
    rpc() {
      return Promise.resolve({ data: true, error: null });
    },
    storage: {
      from() {
        return {
          remove(paths: string[]) {
            removed = paths;
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };

  assertEquals(
    await sweepExpiredCrawlerProxyResults(
      svc as never,
      "2026-08-10T12:00:00Z",
    ),
    1,
  );
  assertEquals(removed, ["results/job-1/result.json.gz"]);
  assertEquals(clearedIds, ["job-1"]);
});
