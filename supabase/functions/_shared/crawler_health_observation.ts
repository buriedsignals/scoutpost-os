import type { CrawlerWorkflowObservation } from "./operations_health.ts";
import type { SupabaseClient } from "./supabase.ts";

// A missing/old/malformed observation must fail collection before any incident
// is recorded. Never turn absent telemetry into zero failures and a resolution.
export async function readCrawlerObservation(
  svc: SupabaseClient,
  now = new Date(),
): Promise<CrawlerWorkflowObservation> {
  const { data, error } = await svc.rpc("crawler_operations_observation");
  if (error) throw new Error("crawler health observation unavailable");
  return parseCrawlerObservation(data, now);
}

export function parseCrawlerObservation(
  data: unknown,
  now = new Date(),
): CrawlerWorkflowObservation {
  const invalid = (): never => {
    throw new Error("crawler health observation missing, invalid or stale");
  };
  if (!data || typeof data !== "object" || Array.isArray(data)) invalid();
  const row = data as Record<string, unknown>;
  if (row.schema_version !== 1 || row.window_seconds !== 3600) invalid();
  const observedAt = row.observed_at;
  if (typeof observedAt !== "string") return invalid();
  const observedMs = Date.parse(observedAt);
  if (
    !Number.isFinite(observedMs) || now.getTime() - observedMs > 300_000 ||
    observedMs - now.getTime() > 30_000
  ) invalid();

  function number(
    key: string,
    nullable = false,
    integer = false,
  ): number | null {
    const value = row[key];
    if (nullable && value === null) return null;
    if (
      typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (integer && !Number.isSafeInteger(value))
    ) return invalid();
    return value;
  }
  const count = (key: string) => number(key, false, true)!;
  const result: CrawlerWorkflowObservation = {
    observedAt,
    dispatchEligible: count("dispatch_eligible"),
    batchedWaiting: count("batched_waiting"),
    oldestWaitSeconds: number("oldest_wait_seconds", true),
    running: count("running"),
    expiredRunning: count("expired_running"),
    p95TotalSeconds: number("p95_total_seconds", true),
    fallbackRequired: count("fallback_required"),
    terminalFailedRecent: count("terminal_failed_recent"),
    workflowFailedRecent: count("workflow_failed_recent"),
    retrievalFailedRecent: count("retrieval_failed_recent"),
    callerAbandonedRecent: count("caller_abandoned_recent"),
    taskRuns24h: count("task_runs_24h"),
    taskQueueP95Seconds: number("task_queue_p95_seconds", true),
    taskDurationP95Seconds: number("task_duration_p95_seconds", true),
    taskMemoryPeakBytes: number("task_memory_peak_bytes", true),
    taskRetryRate: number("task_retry_rate", true),
    taskOutboundBytes24h: count("task_outbound_bytes_24h"),
    estimatedMonthlyComputeDollars: number(
      "estimated_monthly_compute_dollars",
    )!,
  };
  if (
    result.workflowFailedRecent! + result.retrievalFailedRecent! !==
      result.terminalFailedRecent ||
    result.callerAbandonedRecent! > result.retrievalFailedRecent! ||
    result.expiredRunning > result.running ||
    (result.dispatchEligible + result.batchedWaiting! > 0 &&
      result.oldestWaitSeconds === null)
  ) invalid();

  // Added with scrape_host_policy; older observations omit it.
  if (row.blocked_hosts !== undefined) {
    result.blockedHosts = count("blocked_hosts");
  }
  if (
    !Array.isArray(row.retrieval_groups) || row.retrieval_groups.length > 10
  ) invalid();
  result.retrievalGroups = (row.retrieval_groups as unknown[]).map((value) => {
    if (!value || typeof value !== "object") return invalid();
    const group = value as Record<string, unknown>;
    if (
      !["caller_abandoned", "retrieval_timeout", "target_navigation"].includes(
        String(group.category),
      ) ||
      !["scrape", "parse_pdf", "snapshot"].includes(String(group.operation)) ||
      typeof group.hostname !== "string" ||
      !/^[a-z0-9.-]{1,253}$/.test(group.hostname) ||
      typeof group.jobs !== "number" || !Number.isSafeInteger(group.jobs) ||
      group.jobs <= 0 ||
      typeof group.latest_terminal_at !== "string" ||
      !Number.isFinite(Date.parse(group.latest_terminal_at))
    ) return invalid();
    return {
      category: String(group.category),
      operation: String(group.operation),
      hostname: group.hostname,
      jobs: group.jobs,
      latest_terminal_at: group.latest_terminal_at,
    };
  });
  const grouped = result.retrievalGroups.reduce(
    (sum, group) => sum + group.jobs,
    0,
  );
  if (
    grouped > result.retrievalFailedRecent! ||
    (result.retrievalFailedRecent! > 0 && grouped === 0)
  ) invalid();
  return result;
}
