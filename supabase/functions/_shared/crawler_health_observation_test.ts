import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  parseCrawlerObservation,
  readCrawlerObservation,
} from "./crawler_health_observation.ts";
import {
  evaluateCrawlerRetrievalIncident,
  evaluateCrawlerWorkflowIncident,
} from "./operations_health.ts";

const NOW = new Date("2026-09-21T10:00:00Z");
const healthy = {
  schema_version: 1,
  observed_at: NOW.toISOString(),
  window_seconds: 3600,
  dispatch_eligible: 0,
  batched_waiting: 0,
  oldest_wait_seconds: null,
  running: 0,
  expired_running: 0,
  p95_total_seconds: null,
  fallback_required: 0,
  terminal_failed_recent: 0,
  workflow_failed_recent: 0,
  retrieval_failed_recent: 0,
  caller_abandoned_recent: 0,
  retrieval_groups: [],
  task_runs_24h: 0,
  task_queue_p95_seconds: null,
  task_duration_p95_seconds: null,
  task_memory_peak_bytes: null,
  task_retry_rate: null,
  task_outbound_bytes_24h: 0,
  estimated_monthly_compute_dollars: 0,
};
const group = {
  category: "retrieval_timeout",
  operation: "scrape",
  hostname: "example.test",
  jobs: 3,
  latest_terminal_at: NOW.toISOString(),
};

Deno.test("retrieval-only failures open their incident without claiming workflow failure", () => {
  const observation = parseCrawlerObservation({
    ...healthy,
    terminal_failed_recent: 3,
    retrieval_failed_recent: 3,
    retrieval_groups: [group],
  }, NOW);
  assertEquals(evaluateCrawlerWorkflowIncident(observation).active, false);
  assertEquals(evaluateCrawlerRetrievalIncident(observation).active, true);
  assertEquals(
    evaluateCrawlerRetrievalIncident(observation).severity,
    "warning",
  );
});

Deno.test("systemic or unknown failures remain visible with an empty queue", () => {
  const observation = parseCrawlerObservation({
    ...healthy,
    terminal_failed_recent: 10,
    workflow_failed_recent: 10,
  }, NOW);
  assertEquals(
    evaluateCrawlerWorkflowIncident(observation).severity,
    "critical",
  );
  assertEquals(evaluateCrawlerWorkflowIncident(observation).active, true);
  assertEquals(evaluateCrawlerRetrievalIncident(observation).active, false);
});

Deno.test("provider-wide retrieval failures still escalate to critical", () => {
  const observation = parseCrawlerObservation({
    ...healthy,
    terminal_failed_recent: 10,
    retrieval_failed_recent: 10,
    retrieval_groups: [{ ...group, jobs: 10 }],
  }, NOW);
  assertEquals(
    evaluateCrawlerRetrievalIncident(observation).severity,
    "critical",
  );
});

Deno.test("splitting known and unknown failures cannot hide a mixed failure cluster", () => {
  for (const total of [2, 3, 4, 9, 10]) {
    const observation = parseCrawlerObservation({
      ...healthy,
      terminal_failed_recent: total,
      workflow_failed_recent: 1,
      retrieval_failed_recent: total - 1,
      retrieval_groups: [{ ...group, jobs: total - 1 }],
    }, NOW);
    const incident = evaluateCrawlerWorkflowIncident(observation);
    assertEquals(incident.active, total >= 3);
    assertEquals(incident.severity, total >= 10 ? "critical" : "warning");
  }
});

Deno.test("old batched-only work opens queue incident and becomes critical at 30 minutes", () => {
  const observation = parseCrawlerObservation({
    ...healthy,
    batched_waiting: 1,
    oldest_wait_seconds: 601,
  }, NOW);
  assertEquals(evaluateCrawlerWorkflowIncident(observation).active, true);
  assertEquals(
    evaluateCrawlerWorkflowIncident(observation).severity,
    "warning",
  );
  assertEquals(
    evaluateCrawlerWorkflowIncident({ ...observation, oldestWaitSeconds: 1801 })
      .severity,
    "critical",
  );
});

Deno.test("abandoned callers retain cleanup timestamp attribution", () => {
  const observation = parseCrawlerObservation({
    ...healthy,
    terminal_failed_recent: 3,
    retrieval_failed_recent: 3,
    caller_abandoned_recent: 3,
    retrieval_groups: [{ ...group, category: "caller_abandoned" }],
  }, NOW);
  const incident = evaluateCrawlerRetrievalIncident(observation);
  assertEquals(incident.details.caller_abandoned_recent, 3);
  assertEquals(
    String(incident.details.timestamp_basis).includes("cleanup"),
    true,
  );
});

Deno.test("missing, stale, malformed or inconsistent telemetry cannot resolve an incident", () => {
  for (
    const data of [
      null,
      {},
      [],
      { ...healthy, observed_at: "bad" },
      { ...healthy, observed_at: "2026-09-21T09:54:59Z" },
      { ...healthy, observed_at: "2026-09-21T10:00:31Z" },
      { ...healthy, workflow_failed_recent: undefined },
      { ...healthy, terminal_failed_recent: 3 },
      { ...healthy, expired_running: 1 },
      { ...healthy, dispatch_eligible: 1 },
      { ...healthy, retrieval_failed_recent: NaN },
      {
        ...healthy,
        retrieval_groups: [{ ...group, hostname: "user:secret@host/path" }],
      },
    ]
  ) assertThrows(() => parseCrawlerObservation(data, NOW));
  assertThrows(() => evaluateCrawlerRetrievalIncident({} as never));
});

Deno.test("observation RPC failures fail closed", async () => {
  await assertRejects(() =>
    readCrawlerObservation({
      rpc: () =>
        Promise.resolve({ data: null, error: { message: "unavailable" } }),
    } as never, NOW)
  );
  const result = await readCrawlerObservation({
    rpc: (name: string) => {
      assertEquals(name, "crawler_operations_observation");
      return Promise.resolve({ data: healthy, error: null });
    },
  } as never, NOW);
  assertEquals(result.terminalFailedRecent, 0);
});

Deno.test("blocked_hosts is optional, must be a count when present", () => {
  assertEquals(parseCrawlerObservation(healthy, NOW).blockedHosts, undefined);
  assertEquals(
    parseCrawlerObservation({ ...healthy, blocked_hosts: 2 }, NOW).blockedHosts,
    2,
  );
  assertThrows(() =>
    parseCrawlerObservation({ ...healthy, blocked_hosts: -1 }, NOW)
  );
  assertThrows(() =>
    parseCrawlerObservation({ ...healthy, blocked_hosts: "2" }, NOW)
  );
});
