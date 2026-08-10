import { enqueueCrawlerJob } from "./crawler_jobs.ts";
import { cleanupCrawlerResults, loadCrawlerResult } from "./crawler_results.ts";
import { internalServiceAuthHeaders } from "./auth.ts";
import { getServiceRoleKey, getSupabaseUrl } from "./supabase.ts";
import type { SupabaseClient } from "./supabase.ts";

export type ProxyOperation = "scrape" | "snapshot" | "parse_pdf";
export type ProxyWorkloadClass = "scout" | "utility" | "system";

const ACTIVE = new Set(["queued", "batched", "running", "retryable_failed"]);
const REDISPATCH_MS = 5_000;
const POLL_MS = 2_000;

interface StoredProxyJob {
  id: string;
  status: string;
  error_class: string | null;
  error_message: string | null;
  result_manifest: Record<string, unknown> | null;
}

export class CrawlerProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown = message,
  ) {
    super(message);
    this.name = "CrawlerProxyError";
  }
}

interface ProxyDeps {
  dispatch(operation: ProxyOperation, jobId: string): Promise<void>;
  load(jobId: string): Promise<StoredProxyJob>;
  loadResult(
    manifest: Record<string, unknown> | null,
    operation: ProxyOperation,
  ): Promise<Record<string, unknown>>;
  cleanup(job: StoredProxyJob): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export async function executeCrawlerProxy(
  svc: SupabaseClient,
  input: {
    operation: ProxyOperation;
    url: string;
    timeoutMs: number;
    waitMs: number;
    workloadClass: ProxyWorkloadClass;
    tenantKey: string;
    requestId: string;
    signal?: AbortSignal;
  },
  overrides: Partial<ProxyDeps> = {},
): Promise<Record<string, unknown>> {
  const deps = proxyDeps(svc, overrides);
  const job = await enqueueCrawlerJob(svc, {
    requestKind: "proxy",
    admissionClass: input.workloadClass === "scout" ? "scout" : "utility",
    tenantKey: input.tenantKey,
    continuationKey: input.requestId,
    operation: input.operation,
    pipelineStage: `proxy_${input.operation}`,
    url: input.url,
    itemKey: input.requestId,
    options: { timeout_ms: input.timeoutMs },
  });

  const deadline = deps.now() + input.waitMs;
  let nextDispatch = 0;
  while (deps.now() < deadline) {
    if (input.signal?.aborted) {
      throw new CrawlerProxyError("crawler proxy client disconnected", 499);
    }
    const current = await deps.load(job.id);
    if (current.status === "succeeded") {
      const result = await deps.loadResult(
        current.result_manifest,
        input.operation,
      );
      await deps.cleanup(current);
      return result;
    }
    if (current.status === "fallback_required") {
      const completed = await svc.rpc("complete_crawler_fallback", {
        p_job_id: current.id,
        p_ok: false,
        p_manifest: null,
        p_error: "anti-bot fallback delegated to scrape caller",
      });
      if (completed.error || completed.data !== true) {
        throw new CrawlerProxyError("crawler fallback handoff failed", 500);
      }
      throw new CrawlerProxyError(
        "scrape blocked by anti-bot protection",
        502,
        "scrape failed: Blocked by anti-bot protection",
      );
    }
    if (!ACTIVE.has(current.status)) {
      throw terminalFailure(current, input.operation);
    }

    const now = deps.now();
    if (
      (current.status === "queued" || current.status === "retryable_failed") &&
      now >= nextDispatch
    ) {
      nextDispatch = now + REDISPATCH_MS;
      try {
        await deps.dispatch(input.operation, job.id);
      } catch {
        // The scheduled dispatcher remains the recovery owner. Keep polling;
        // an immediate nudge is an optimization, not a second source of truth.
      }
    }
    await deps.sleep(Math.min(POLL_MS, Math.max(1, deadline - deps.now())));
  }
  throw new CrawlerProxyError(
    `workflow ${input.operation} timed out after ${input.waitMs}ms`,
    504,
  );
}

export async function sweepExpiredCrawlerProxyResults(
  svc: SupabaseClient,
  cutoffIso: string,
): Promise<number> {
  const staleFallbacks = await svc.from("crawler_jobs")
    .select("id")
    .eq("request_kind", "proxy")
    .eq("status", "fallback_required")
    .lt("completed_at", cutoffIso)
    .order("completed_at", { ascending: true })
    .limit(20);
  if (staleFallbacks.error) {
    throw new Error("crawler proxy fallback cleanup lookup failed");
  }
  const closed = await Promise.all(
    (staleFallbacks.data ?? []).map((row) =>
      svc.rpc("complete_crawler_fallback", {
        p_job_id: row.id,
        p_ok: false,
        p_manifest: null,
        p_error: "crawler proxy caller no longer waiting",
      })
    ),
  );
  if (closed.some((result) => result.error)) {
    throw new Error("crawler proxy fallback cleanup failed");
  }

  const { data, error } = await svc.from("crawler_jobs")
    .select("id,result_manifest")
    .eq("request_kind", "proxy")
    .eq("status", "succeeded")
    .not("result_manifest", "is", null)
    .lt("completed_at", cutoffIso)
    .order("completed_at", { ascending: true })
    .limit(100);
  if (error) throw new Error("crawler proxy cleanup lookup failed");
  const rows = (data ?? []) as StoredProxyJob[];
  await cleanupCrawlerResults(svc, rows);
  return rows.length + closed.filter((result) => result.data === true).length;
}

function proxyDeps(
  svc: SupabaseClient,
  overrides: Partial<ProxyDeps>,
): ProxyDeps {
  return {
    dispatch: triggerImmediateCrawlerDispatch,
    load: async (jobId) => {
      const { data, error } = await svc.from("crawler_jobs")
        .select("id,status,error_class,error_message,result_manifest")
        .eq("id", jobId)
        .single();
      if (error || !data) throw new Error("crawler proxy job lookup failed");
      return data as StoredProxyJob;
    },
    loadResult: (manifest, operation) =>
      loadCrawlerResult(svc, manifest, operation),
    cleanup: (job) => cleanupCrawlerResults(svc, [job]),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...overrides,
  };
}

async function triggerImmediateCrawlerDispatch(
  operation: ProxyOperation,
  jobId: string,
): Promise<void> {
  const response = await fetch(
    `${getSupabaseUrl().replace(/\/+$/, "")}/functions/v1/crawler-dispatch`,
    {
      method: "POST",
      headers: {
        ...internalServiceAuthHeaders(),
        "apikey": getServiceRoleKey(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "immediate", operation, job_id: jobId }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`crawler immediate dispatch failed (${response.status})`);
  }
  await response.body?.cancel();
}

function terminalFailure(
  job: StoredProxyJob,
  operation: ProxyOperation,
): CrawlerProxyError {
  const message = job.error_message || job.error_class || "crawler job failed";
  if (operation === "parse_pdf") {
    const needsOcr = /needs_ocr:\s*(\d+) chars over (\d+) pages/i.exec(message);
    if (needsOcr) {
      return new CrawlerProxyError(message, 422, {
        error: "needs_ocr",
        pages: Number(needsOcr[2]),
        chars: Number(needsOcr[1]),
      });
    }
    if (message.includes("not_a_pdf")) {
      return new CrawlerProxyError(message, 415, { error: "not_a_pdf" });
    }
    if (message.includes("pdf_too_large")) {
      return new CrawlerProxyError(message, 413, { error: "pdf_too_large" });
    }
  }
  if (message.includes("private_address")) {
    return new CrawlerProxyError(message, 422, { error: "private_address" });
  }
  return new CrawlerProxyError(message, 502, `${operation} failed: ${message}`);
}
