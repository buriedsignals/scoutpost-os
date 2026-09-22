export type IncidentKind =
  | "dispatch_queue_delay"
  | "civic_queue_delay"
  | "crawler_workflow_health"
  | "crawler_retrieval_failures"
  | "vessel_sampler_health";

export interface OperationalIncident {
  key: string;
  kind: IncidentKind;
  active: boolean;
  severity: "warning" | "critical";
  summary: string;
  details: Record<string, unknown>;
}

export interface QueueObservation {
  key: string;
  kind: Extract<IncidentKind, "dispatch_queue_delay" | "civic_queue_delay">;
  label: string;
  queuedCount: number;
  activeCount: number;
  failedCount: number;
  oldestQueuedAt: string | null;
}

export interface VesselSamplerObservation {
  latestStartedAt: string | null;
  latestStatus: string | null;
  latestErrorCode: string | null;
  latestSuccessAt: string | null;
}

export interface CrawlerWorkflowObservation {
  dispatchEligible: number;
  oldestWaitSeconds: number | null;
  running: number;
  expiredRunning: number;
  p95TotalSeconds: number | null;
  fallbackRequired: number;
  terminalFailedRecent: number;
  taskRuns24h: number;
  taskQueueP95Seconds: number | null;
  taskDurationP95Seconds: number | null;
  taskMemoryPeakBytes: number | null;
  taskRetryRate: number | null;
  taskOutboundBytes24h: number;
  estimatedMonthlyComputeDollars: number;
  // Optional for existing callers; the new monitor validates the complete v1 observation.
  batchedWaiting?: number;
  workflowFailedRecent?: number;
  retrievalFailedRecent?: number;
  callerAbandonedRecent?: number;
  observedAt?: string;
  /** Hosts currently routed away from the primary renderer by scrape_host_policy. */
  blockedHosts?: number;
  retrievalGroups?: Array<{
    category: string;
    operation: string;
    hostname: string;
    jobs: number;
    latest_terminal_at: string;
  }>;
}

export const DEFAULT_QUEUE_DELAY_MS = 10 * 60_000;
// Isolated terminal failures (one bad URL, a Firecrawl timeout) are routine.
// Open an incident only when they cluster within the one-hour window.
export const TERMINAL_FAILURE_WARNING_COUNT = 3;
export const TERMINAL_FAILURE_CRITICAL_COUNT = 10;
export const DEFAULT_SAMPLER_STALE_MS = 95 * 60_000;

function ageMs(now: Date, value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, now.getTime() - parsed) : null;
}

function ageMinutes(value: number | null): number | null {
  return value === null ? null : Math.floor(value / 60_000);
}

export function evaluateQueueIncident(
  observation: QueueObservation,
  now = new Date(),
  thresholdMs = DEFAULT_QUEUE_DELAY_MS,
): OperationalIncident {
  const oldestAgeMs = ageMs(now, observation.oldestQueuedAt);
  const active = observation.queuedCount > 0 && oldestAgeMs !== null &&
    oldestAgeMs >= thresholdMs;
  const oldestAgeMinutes = ageMinutes(oldestAgeMs);
  const severity = oldestAgeMs !== null && oldestAgeMs >= thresholdMs * 3
    ? "critical"
    : "warning";
  return {
    key: observation.key,
    kind: observation.kind,
    active,
    severity,
    summary: active
      ? `${observation.label} has ${observation.queuedCount} queued item(s); ` +
        `the oldest has waited ${oldestAgeMinutes} minute(s)`
      : `${observation.label} queue delay is within threshold`,
    details: {
      queued_count: observation.queuedCount,
      active_count: observation.activeCount,
      failed_count: observation.failedCount,
      oldest_queued_at: observation.oldestQueuedAt,
      oldest_age_minutes: oldestAgeMinutes,
      threshold_minutes: Math.floor(thresholdMs / 60_000),
    },
  };
}

export function evaluateVesselSamplerIncident(
  observation: VesselSamplerObservation,
  now = new Date(),
  staleMs = DEFAULT_SAMPLER_STALE_MS,
): OperationalIncident {
  const latestAgeMs = ageMs(now, observation.latestStartedAt);
  const successAgeMs = ageMs(now, observation.latestSuccessAt);
  const latestFailed = observation.latestStatus === "failed";
  const missing = observation.latestStartedAt === null;
  const stale = successAgeMs === null || successAgeMs >= staleMs;
  const active = missing || latestFailed || stale;
  const severity =
    missing || successAgeMs === null || successAgeMs >= staleMs * 2
      ? "critical"
      : "warning";

  let summary = "VesselAPI sampler heartbeat is healthy";
  if (missing) summary = "No vessel sampler heartbeat exists";
  else if (latestFailed) {
    summary = `Latest vessel sampler failed (${
      observation.latestErrorCode ?? "unknown"
    })`;
  } else if (stale) {
    summary = `Last successful vessel sampler is ${
      ageMinutes(successAgeMs)
    } minute(s) old`;
  }

  return {
    key: "vessel_sampler_health",
    kind: "vessel_sampler_health",
    active,
    severity,
    summary,
    details: {
      latest_started_at: observation.latestStartedAt,
      latest_status: observation.latestStatus,
      latest_error_code: observation.latestErrorCode,
      latest_age_minutes: ageMinutes(latestAgeMs),
      latest_success_at: observation.latestSuccessAt,
      latest_success_age_minutes: ageMinutes(successAgeMs),
      stale_after_minutes: Math.floor(staleMs / 60_000),
    },
  };
}

export function evaluateCrawlerWorkflowIncident(
  observation: CrawlerWorkflowObservation,
  thresholdMs = DEFAULT_QUEUE_DELAY_MS,
): OperationalIncident {
  const oldestWaitMs = observation.oldestWaitSeconds === null
    ? null
    : observation.oldestWaitSeconds * 1000;
  const waiting = observation.dispatchEligible +
    (observation.batchedWaiting ?? 0);
  const delayed = waiting > 0 && oldestWaitMs !== null &&
    oldestWaitMs >= thresholdMs;
  const workflowFailures = observation.workflowFailedRecent ??
    observation.terminalFailedRecent;
  // Keep mixed clusters visible: e.g. 2 known retrieval + 2 unknown failures
  // must not disappear below two independent warning thresholds.
  const terminalWarning = workflowFailures > 0 &&
    observation.terminalFailedRecent >=
      TERMINAL_FAILURE_WARNING_COUNT;
  const terminalCritical = workflowFailures > 0 &&
    observation.terminalFailedRecent >=
      TERMINAL_FAILURE_CRITICAL_COUNT;
  const active = delayed || observation.expiredRunning > 0 || terminalWarning;
  const severity = observation.expiredRunning > 0 || terminalCritical ||
      (delayed && oldestWaitMs! >= thresholdMs * 3)
    ? "critical"
    : "warning";
  const oldestMinutes = oldestWaitMs === null
    ? null
    : Math.floor(oldestWaitMs / 60_000);
  return {
    key: "crawler_workflow_health",
    kind: "crawler_workflow_health",
    active,
    severity,
    summary: active
      ? `Crawler Workflow has ${waiting} waiting item(s); ` +
        `oldest wait ${oldestMinutes ?? "unknown"} minute(s), ` +
        `${observation.expiredRunning} expired lease(s), ` +
        `${workflowFailures} infrastructure or unclassified failure(s) among ${observation.terminalFailedRecent} recent terminal failures`
      : "Crawler Workflow queue, leases and infrastructure failure count are within thresholds",
    details: {
      dispatch_eligible: observation.dispatchEligible,
      batched_waiting: observation.batchedWaiting ?? 0,
      observed_at: observation.observedAt ?? null,
      workflow_failed_recent: workflowFailures,
      failure_threshold_basis:
        "all terminal failures when infrastructure or unclassified failures are present",
      oldest_wait_seconds: observation.oldestWaitSeconds,
      running: observation.running,
      expired_running: observation.expiredRunning,
      p95_total_seconds: observation.p95TotalSeconds,
      fallback_required: observation.fallbackRequired,
      terminal_failed_recent: observation.terminalFailedRecent,
      terminal_failure_warning_count: TERMINAL_FAILURE_WARNING_COUNT,
      terminal_failure_critical_count: TERMINAL_FAILURE_CRITICAL_COUNT,
      task_runs_24h: observation.taskRuns24h,
      task_queue_p95_seconds: observation.taskQueueP95Seconds,
      task_duration_p95_seconds: observation.taskDurationP95Seconds,
      task_memory_peak_bytes: observation.taskMemoryPeakBytes,
      task_retry_rate: observation.taskRetryRate,
      task_outbound_bytes_24h: observation.taskOutboundBytes24h,
      estimated_monthly_compute_dollars:
        observation.estimatedMonthlyComputeDollars,
      threshold_minutes: Math.floor(thresholdMs / 60_000),
    },
  };
}

export function operatorAlertSubject(activeIncidentCount: number): string {
  return activeIncidentCount > 0
    ? `⚠️ Scoutpost operations: ${activeIncidentCount} active incident${
      activeIncidentCount === 1 ? "" : "s"
    }`
    : "✅ Scoutpost operations recovered";
}

export function evaluateCrawlerRetrievalIncident(
  observation: CrawlerWorkflowObservation,
): OperationalIncident {
  if (observation.retrievalFailedRecent === undefined) {
    throw new Error("crawler retrieval observation missing");
  }
  const count = observation.retrievalFailedRecent;
  const abandoned = observation.callerAbandonedRecent ?? 0;
  const active = count >= TERMINAL_FAILURE_WARNING_COUNT;
  return {
    key: "crawler_retrieval_failures",
    kind: "crawler_retrieval_failures",
    active,
    severity: count >= TERMINAL_FAILURE_CRITICAL_COUNT ? "critical" : "warning",
    summary: active
      ? `Crawler recorded ${count} unsuccessful retrieval(s) in the last hour, ` +
        `including ${abandoned} abandoned caller(s); cause may be target or provider`
      : "Crawler retrieval failure count is within threshold",
    details: {
      observed_at: observation.observedAt,
      window_seconds: 3600,
      retrieval_failed_recent: count,
      caller_abandoned_recent: abandoned,
      groups: observation.retrievalGroups ?? [],
      group_limit: 10,
      timestamp_basis:
        "terminal transition; abandoned-caller timestamps reflect cleanup, not original retrieval time",
      terminal_failure_warning_count: TERMINAL_FAILURE_WARNING_COUNT,
      terminal_failure_critical_count: TERMINAL_FAILURE_CRITICAL_COUNT,
    },
  };
}
