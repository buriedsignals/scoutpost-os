import { assertEquals } from "jsr:@std/assert@1";
import {
  evaluateQueueIncident,
  evaluateVesselSamplerIncident,
} from "./operations_health.ts";

const NOW = new Date("2026-07-20T20:00:00Z");

Deno.test("queue delay opens only after the configured threshold", () => {
  const base = {
    key: "dispatch_queue_delay",
    kind: "dispatch_queue_delay" as const,
    label: "Scout dispatch",
    queuedCount: 12,
    activeCount: 3,
    failedCount: 0,
  };
  assertEquals(
    evaluateQueueIncident({
      ...base,
      oldestQueuedAt: "2026-07-20T19:51:00Z",
    }, NOW).active,
    false,
  );
  const delayed = evaluateQueueIncident({
    ...base,
    oldestQueuedAt: "2026-07-20T19:40:00Z",
  }, NOW);
  assertEquals(delayed.active, true);
  assertEquals(delayed.severity, "warning");
  assertEquals(delayed.details.oldest_age_minutes, 20);
});

Deno.test("queue delay becomes critical at three times threshold", () => {
  const incident = evaluateQueueIncident({
    key: "civic_queue_delay",
    kind: "civic_queue_delay",
    label: "Civic extraction",
    queuedCount: 2,
    activeCount: 1,
    failedCount: 1,
    oldestQueuedAt: "2026-07-20T19:29:00Z",
  }, NOW);
  assertEquals(incident.active, true);
  assertEquals(incident.severity, "critical");
});

Deno.test("vessel sampler reports failed and stale states independently", () => {
  const failed = evaluateVesselSamplerIncident({
    latestStartedAt: "2026-07-20T19:55:00Z",
    latestStatus: "failed",
    latestErrorCode: "vesselapi_timeout",
    latestSuccessAt: "2026-07-20T19:10:00Z",
  }, NOW);
  assertEquals(failed.active, true);
  assertEquals(failed.severity, "warning");

  const stale = evaluateVesselSamplerIncident({
    latestStartedAt: "2026-07-20T18:00:00Z",
    latestStatus: "succeeded",
    latestErrorCode: null,
    latestSuccessAt: "2026-07-20T18:00:00Z",
  }, NOW);
  assertEquals(stale.active, true);
  assertEquals(
    stale.summary,
    "Last successful vessel sampler is 120 minute(s) old",
  );
});

Deno.test("recent successful vessel sampler is healthy", () => {
  const incident = evaluateVesselSamplerIncident({
    latestStartedAt: "2026-07-20T19:07:00Z",
    latestStatus: "succeeded",
    latestErrorCode: null,
    latestSuccessAt: "2026-07-20T19:07:00Z",
  }, NOW);
  assertEquals(incident.active, false);
});
