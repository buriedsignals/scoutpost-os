import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.224.0/assert/assert_rejects.ts";
import {
  PageWorkflowPending,
  PageWorkflowTransport,
} from "./page_workflow_transport.ts";
import { maybeInitializeMissingWebBaselineRun } from "./web_scout_baseline.ts";

function transportWithStatus(
  status: string,
  errorMessage: string | null = null,
) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const row = {
    id: "job-1",
    dedupe_key: "dedupe-1",
    status,
    request_kind: "scout_run",
    continuation_key: "run-1",
    url: "https://example.com",
    attempts: 1,
    error_class: status === "terminal_failed" ? "terminal" : null,
    error_message: errorMessage,
    result_manifest: null,
  };
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    single() {
      return Promise.resolve({ data: row, error: null });
    },
  };
  const svc = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({
        data: fn === "enqueue_crawler_job" ? row : true,
        error: null,
      });
    },
    from() {
      return query;
    },
  };
  return {
    calls,
    svc,
    transport: new PageWorkflowTransport(svc as never, {
      id: "run-1",
      scoutId: "scout-1",
      userId: "user-1",
      tenantKey: "user-1",
    }),
  };
}

Deno.test("root enqueue pauses without starting a provider locally", async () => {
  const { calls, transport } = transportWithStatus("queued");
  const error = await assertRejects(
    () =>
      transport.scrape({
        url: "https://example.com",
        workloadClass: "scout",
        timeoutMs: 25_000,
      }, "root"),
    PageWorkflowPending,
  );
  assertEquals(error.stage, "waiting_root");
  assertEquals(calls[0].fn, "enqueue_crawler_job");
  assertEquals(calls[0].args.p_continuation_key, "run-1");
  assertEquals(calls[0].args.p_pipeline_stage, "root");
});

Deno.test("missing baseline repair composes with Workflow pending/resume transport", async () => {
  const { calls, svc, transport } = transportWithStatus("queued");
  const error = await assertRejects(
    () =>
      maybeInitializeMissingWebBaselineRun(
        svc as never,
        {
          id: "scout-1",
          user_id: "user-1",
          url: "https://example.com",
          baseline_established_at: null,
        },
        "run-1",
        {
          scrape: async (url) =>
            await transport.scrape({
              url,
              workloadClass: "utility",
              timeoutMs: 25_000,
              abortAfterMs: 30_000,
            }, "root"),
          hasCurrentCanonicalBaseline: async () => false,
          now: () => "2026-08-10T00:00:00Z",
        },
      ),
    PageWorkflowPending,
  );
  assertEquals(error.stage, "waiting_root");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].fn, "enqueue_crawler_job");
});

Deno.test("terminal crawler failure fails the resumable Page run", async () => {
  const { transport } = transportWithStatus("terminal_failed", "unsafe URL");
  await assertRejects(
    () =>
      transport.scrape({
        url: "https://example.com",
        workloadClass: "scout",
      }, "root"),
    Error,
    "unsafe URL",
  );
});

Deno.test("terminal child failure remains a per-URL Page result", async () => {
  const { transport } = transportWithStatus("terminal_failed", "unsafe URL");
  await transport.prepareChildren(["https://example.com/child"], 25_000);
});
