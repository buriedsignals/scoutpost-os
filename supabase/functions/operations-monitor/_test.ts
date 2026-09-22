import { assertEquals } from "jsr:@std/assert@1";
import { handleOperationsMonitor } from "./index.ts";
import { operatorAlertSubject } from "../_shared/operations_health.ts";

function observation() {
  return {
    schema_version: 1,
    observed_at: new Date().toISOString(),
    window_seconds: 3600,
    dispatch_eligible: 0,
    batched_waiting: 0,
    oldest_wait_seconds: null,
    running: 0,
    expired_running: 0,
    p95_total_seconds: null,
    fallback_required: 0,
    terminal_failed_recent: 3,
    workflow_failed_recent: 0,
    retrieval_failed_recent: 3,
    caller_abandoned_recent: 0,
    retrieval_groups: [{
      category: "retrieval_timeout",
      operation: "scrape",
      hostname: "example.test",
      jobs: 3,
      latest_terminal_at: new Date().toISOString(),
    }],
    task_runs_24h: 0,
    task_queue_p95_seconds: null,
    task_duration_p95_seconds: null,
    task_memory_peak_bytes: null,
    task_retry_rate: null,
    task_outbound_bytes_24h: 0,
    estimated_monthly_compute_dollars: 0,
  };
}

function client(telemetry: unknown, telemetryError = false) {
  const writes: Record<string, unknown>[] = [];
  const acks: string[][] = [];
  const svc = {
    from(table: string) {
      const result = {
        error: null,
        count: 0,
        data: table === "transport_sampler_runs"
          ? {
            started_at: new Date().toISOString(),
            status: "succeeded",
            error_code: null,
          }
          : null,
      };
      const query = {
        ...result,
        select: () => query,
        in: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: () => Promise.resolve(result),
      };
      return query;
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      if (name === "crawler_operations_observation") {
        return Promise.resolve({
          data: telemetry,
          error: telemetryError ? { message: "unavailable" } : null,
        });
      }
      if (name === "record_operator_incident") {
        writes.push(args);
        // Existing workflow incident resolves; ongoing retrieval warning is deduplicated.
        return Promise.resolve({
          data: [{
            should_notify: args.p_kind === "crawler_workflow_health",
            transition: args.p_kind === "crawler_workflow_health"
              ? "resolved"
              : "unchanged",
          }],
          error: null,
        });
      }
      assertEquals(name, "ack_operator_incident_notifications");
      acks.push(args.p_incident_keys as string[]);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { svc, writes, acks };
}

Deno.test("unavailable or stale crawler telemetry causes zero incident writes and zero notifications", async () => {
  for (
    const [data, error] of [
      [null, true],
      [{ ...observation(), observed_at: "2020-01-01T00:00:00Z" }, false],
      [{ ...observation(), workflow_failed_recent: undefined }, false],
    ] as const
  ) {
    const stub = client(data, error);
    let sent = 0;
    const response = await handleOperationsMonitor(
      new Request("http://localhost", { method: "POST" }),
      {
        authorize: () => {},
        serviceClient: () => stub.svc as never,
        send: () => {
          sent++;
          return Promise.resolve(true);
        },
      },
    );
    assertEquals(response.status, 500);
    assertEquals(stub.writes, []);
    assertEquals(stub.acks, []);
    assertEquals(sent, 0);
    await response.body?.cancel();
  }
});

Deno.test("partial recovery notification accounts for the deduplicated active retrieval incident", async () => {
  const stub = client(observation());
  let subject = "";
  const response = await handleOperationsMonitor(
    new Request("http://localhost", { method: "POST" }),
    {
      authorize: () => {},
      serviceClient: () => stub.svc as never,
      send: (items, activeCount) => {
        assertEquals(items.map((item) => item.incident.key), [
          "crawler_workflow_health",
        ]);
        assertEquals(items[0].transition, "resolved");
        subject = operatorAlertSubject(activeCount);
        return Promise.resolve(true);
      },
    },
  );
  assertEquals(response.status, 200);
  assertEquals(stub.writes.length, 5);
  assertEquals(
    stub.writes.find((row) => row.p_kind === "crawler_workflow_health")
      ?.p_active,
    false,
  );
  assertEquals(
    stub.writes.find((row) => row.p_kind === "crawler_retrieval_failures")
      ?.p_active,
    true,
  );
  assertEquals(subject, "⚠️ Scoutpost operations: 1 active incident");
  assertEquals(stub.acks, [["crawler_workflow_health"]]);
  assertEquals(operatorAlertSubject(0), "✅ Scoutpost operations recovered");
  await response.body?.cancel();
});
