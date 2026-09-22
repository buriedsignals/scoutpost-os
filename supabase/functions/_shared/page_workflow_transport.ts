import type { SupabaseClient } from "./supabase.ts";
import { type CrawlerJobRow, enqueueCrawlerJob } from "./crawler_jobs.ts";
import {
  cleanupCrawlerResults,
  crawlerManifestProvider,
  gzipCrawlerJson,
  loadCrawlerResult,
} from "./crawler_results.ts";
import { ApiError } from "./errors.ts";
import {
  crawlerFallbackReason,
  scrapeFallbackOnce,
} from "./scrape_fallback.ts";
import {
  noteAntiBotRescue,
  resolveScrapePlan,
  scrapeHost,
  type ScrapePlan,
} from "./scrape_plan.ts";
import type {
  PrimaryPageScrapeOptions,
  PrimaryPageScrapeResult,
} from "./scrape_types.ts";
import { sha256HexBytes } from "./snapshot_store.ts";

const MAX_PIPELINE_STAGE_LENGTH = 100;
const ACTIVE = new Set(["queued", "batched", "running", "retryable_failed"]);
const FALLBACK_REQUEST_TIMEOUT_MS = 60_000;
const FALLBACK_CLIENT_TIMEOUT_MS = FALLBACK_REQUEST_TIMEOUT_MS + 5_000;
const FALLBACK_ADMISSION_BUDGET_MS = 35_000;

interface StoredCrawlerJob extends CrawlerJobRow {
  url: string;
  attempts: number;
  max_attempts: number;
  error_class: string | null;
  error_message: string | null;
  result_manifest: Record<string, unknown> | null;
  lease_token: string | null;
}

export class PageWorkflowPending extends Error {
  constructor(readonly stage: "waiting_root" | "waiting_children") {
    super(stage);
    this.name = "PageWorkflowPending";
  }
}

export function isHostPolicyRouted(
  job: { error_message: string | null },
): boolean {
  return typeof job.error_message === "string" &&
    job.error_message.startsWith("host policy:");
}

export interface PageWorkflowTransportDeps {
  resolvePlan: (url: string) => Promise<ScrapePlan>;
  noteAntiBotRescue: (host: string | null) => Promise<void>;
}

export class PageWorkflowTransport {
  // Admission is bounded per invocation, not renewed after each child. Once
  // admitted, a paid request gets its own complete renderer/client window.
  private readonly fallbackAdmissionDeadlineMs: number;

  private readonly deps: PageWorkflowTransportDeps;
  constructor(
    private readonly svc: SupabaseClient,
    private readonly run: {
      id: string;
      scoutId: string;
      userId: string;
      tenantKey: string;
    },
    invocationStartedAt = Date.now(),
    deps: Partial<PageWorkflowTransportDeps> = {},
  ) {
    this.fallbackAdmissionDeadlineMs = invocationStartedAt +
      FALLBACK_ADMISSION_BUDGET_MS;
    this.deps = {
      resolvePlan: (url) => resolveScrapePlan(url),
      noteAntiBotRescue,
      ...deps,
    };
  }

  async scrape(
    opts: PrimaryPageScrapeOptions,
    stage: string,
  ): Promise<PrimaryPageScrapeResult> {
    const job = await this.enqueue(opts.url, stage, opts.timeoutMs ?? 25_000);
    const current = await this.load(job.id);
    if (ACTIVE.has(current.status)) {
      throw new PageWorkflowPending(
        stage === "root" ? "waiting_root" : "waiting_children",
      );
    }
    if (current.status === "fallback_required") {
      const completed = await this.completeFallback(current, opts);
      if (
        !completed && (await this.load(job.id)).status === "fallback_required"
      ) {
        throw new PageWorkflowPending(
          stage === "root" ? "waiting_root" : "waiting_children",
        );
      }
      if (completed && stage === "root") {
        // Resume from the stored result rather than combining a slow root
        // render with child work inside the Edge request's 150s idle limit.
        throw new PageWorkflowPending("waiting_root");
      }
      return await this.scrape(opts, stage);
    }
    if (current.status === "cancelled") {
      throw new Error("crawler job cancelled because its Page run terminated");
    }
    if (current.status !== "succeeded") {
      throw new Error(
        current.error_message || current.error_class || "crawler job failed",
      );
    }
    const result = await loadCrawlerResult(this.svc, current.result_manifest);
    const pageResult = result as unknown as PrimaryPageScrapeResult;
    return {
      ...pageResult,
      served_by: crawlerManifestProvider(current.result_manifest) ?? "crawl4ai",
      scrape_strategy:
        crawlerManifestProvider(current.result_manifest) === "firecrawl"
          ? pageResult.fallback_reason === "timeout_exhausted"
            ? "workflow_timeout_fallback"
            : "workflow_antibot_fallback"
          : "workflow",
      scrape_attempts: Math.max(1, current.attempts),
    };
  }

  async prepareChildren(
    urls: string[],
    opts: Omit<PrimaryPageScrapeOptions, "url">,
  ): Promise<void> {
    const jobs = await Promise.all(
      urls.map((url) =>
        this.enqueue(url, childStage(url), opts.timeoutMs ?? 12_000)
      ),
    );
    const rows = await Promise.all(jobs.map((job) => this.load(job.id)));
    if (
      rows.some((row) =>
        ACTIVE.has(row.status) ||
        (row.status === "fallback_required" && row.lease_token !== null)
      )
    ) {
      throw new PageWorkflowPending("waiting_children");
    }
    let attemptedFallback = false;
    for (const row of rows) {
      if (row.status !== "fallback_required") continue;
      try {
        const completed = await this.completeFallback(row, {
          ...opts,
          url: row.url,
        });
        if (!completed) throw new PageWorkflowPending("waiting_children");
      } catch (error) {
        // Provider failures remain durable per-URL failures for Phase B.
        // Claim, storage and completion failures must still fail the run.
        if (
          !(error instanceof ApiError &&
            error.code === "scrape_fallback_failed")
        ) {
          throw error;
        }
      }
      attemptedFallback = true;
    }
    if (attemptedFallback) {
      // Keep slow rendering before Phase B effects; the existing resume pass
      // consumes stored results without replaying partial notification work.
      throw new PageWorkflowPending("waiting_children");
    }
  }

  async cleanup(): Promise<void> {
    const { data, error } = await this.svc.from("crawler_jobs")
      .select("id,result_manifest")
      .eq("scout_run_id", this.run.id)
      .eq("request_kind", "scout_run")
      .eq("status", "succeeded");
    if (error) {
      throw new Error(`crawler cleanup lookup failed: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{
      id: string;
      result_manifest: Record<string, unknown> | null;
    }>;
    await cleanupCrawlerResults(this.svc, rows);
  }

  private async enqueue(
    url: string,
    stage: string,
    timeoutMs: number,
  ): Promise<CrawlerJobRow> {
    // Host memory decides the renderer order for the durable path too: a
    // blocked host skips the worker and lands directly in fallback_required.
    const plan = await this.deps.resolvePlan(url);
    return await enqueueCrawlerJob(this.svc, {
      requestKind: "scout_run",
      tenantKey: this.run.tenantKey,
      continuationKey: this.run.id,
      operation: "scrape",
      pipelineStage: stage,
      url,
      itemKey: stage,
      options: plan.skipPrimary
        ? { timeout_ms: timeoutMs, host_policy: "firecrawl" }
        : { timeout_ms: timeoutMs },
      scoutRunId: this.run.id,
      scoutId: this.run.scoutId,
      userId: this.run.userId,
      maxAttempts: 3,
      fallbackReason: plan.skipPrimary ? "anti_bot" : undefined,
    });
  }

  private async load(id: string): Promise<StoredCrawlerJob> {
    const { data, error } = await this.svc.from("crawler_jobs")
      .select(
        "id,dedupe_key,status,request_kind,continuation_key,url,attempts,max_attempts,error_class,error_message,result_manifest,lease_token",
      )
      .eq("id", id)
      .single();
    if (error || !data) throw new Error("crawler job lookup failed");
    return data as StoredCrawlerJob;
  }

  private async completeFallback(
    job: StoredCrawlerJob,
    opts: PrimaryPageScrapeOptions,
  ): Promise<boolean> {
    const reason = crawlerFallbackReason(
      "scrape",
      job.error_class,
      job.attempts,
      job.max_attempts,
    );
    // Decide before completion rewrites the job row: a policy-routed job never
    // tried crawl4ai, so its rescue is not evidence of a block.
    const policyRouted = isHostPolicyRouted(job);
    if (!reason) throw new Error("crawler job has no eligible fallback reason");
    if (Date.now() >= this.fallbackAdmissionDeadlineMs) {
      return false;
    }
    const claim = await this.svc.rpc("claim_page_crawler_fallback", {
      p_job_id: job.id,
      p_lease_seconds: 600,
    });
    if (claim.error) throw new Error("fallback claim failed");
    if (typeof claim.data !== "string") return false;
    const leaseToken = claim.data;
    let uploadedPath: string | null = null;
    try {
      const result = await scrapeFallbackOnce(
        opts.url,
        {
          ...opts,
          timeoutMs: FALLBACK_REQUEST_TIMEOUT_MS,
          workloadClass: "scout",
          formats: ["markdown", "rawHtml"],
        },
        reason,
        Date.now() + FALLBACK_CLIENT_TIMEOUT_MS,
      );
      const bytes = await gzipCrawlerJson(result);
      const executionId = crypto.randomUUID();
      const path = `results/${job.id}/fallback/${executionId}.json.gz`;
      uploadedPath = path;
      const upload = await this.svc.storage.from("crawler-results").upload(
        path,
        bytes,
        { contentType: "application/gzip", upsert: false },
      );
      if (upload.error) throw new Error("fallback result upload failed");
      const manifest = {
        execution_id: executionId,
        provider: "firecrawl",
        fallback_reason: reason,
        artifacts: [{
          kind: "result",
          path,
          bytes: bytes.byteLength,
          sha256: await sha256HexBytes(bytes),
        }],
      };
      const completed = await this.svc.rpc("complete_crawler_fallback", {
        p_job_id: job.id,
        p_lease_token: leaseToken,
        p_ok: true,
        p_manifest: manifest,
        p_error: null,
      });
      if (completed.error || completed.data !== true) {
        const current = await this.load(job.id).catch(() => null);
        if (current?.status === "succeeded") {
          if (current.result_manifest?.execution_id !== executionId) {
            await this.svc.storage.from("crawler-results").remove([path]);
          }
          return true;
        }
        throw new Error("fallback completion rejected");
      }
      // Evidence for host memory: the worker's crawl4ai attempt was blocked
      // and Firecrawl rescued it. Policy-routed jobs never tried crawl4ai.
      if (reason === "anti_bot" && !policyRouted) {
        await this.deps.noteAntiBotRescue(scrapeHost(job.url));
      }
      return true;
    } catch (error) {
      const current = await this.load(job.id).catch(() => null);
      if (uploadedPath && current && current.status !== "succeeded") {
        await this.svc.storage.from("crawler-results").remove([uploadedPath]);
      }
      const failed = await this.svc.rpc("complete_crawler_fallback", {
        p_job_id: job.id,
        p_lease_token: leaseToken,
        p_ok: false,
        p_manifest: null,
        p_error: error instanceof Error ? error.message : String(error),
      });
      if (failed.error || failed.data !== true) {
        throw new Error("fallback failure completion rejected", {
          cause: error,
        });
      }
      throw error;
    }
  }
}

export function childStage(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  const normalized = parsed.toString().replace(/\/+$/, "");
  const stage = `child:${normalized}`;
  if (stage.length <= MAX_PIPELINE_STAGE_LENGTH) return stage;

  // The URL remains a separate part of the crawler dedupe key. This compact
  // stage is therefore only a bounded, observable label; the hash prevents
  // long URLs with the same prefix from becoming indistinguishable in logs.
  const suffix = `:${fnv1aHex(normalized)}`;
  return `${
    stage.slice(0, MAX_PIPELINE_STAGE_LENGTH - suffix.length)
  }${suffix}`;
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
