import type { SupabaseClient } from "./supabase.ts";
import { type CrawlerJobRow, enqueueCrawlerJob } from "./crawler_jobs.ts";
import {
  cleanupCrawlerResults,
  crawlerManifestProvider,
  gzipCrawlerJson,
  loadCrawlerResult,
} from "./crawler_results.ts";
import {
  crawlerFallbackReason,
  scrapeFallbackOnce,
} from "./scrape_fallback.ts";
import type {
  PrimaryPageScrapeOptions,
  PrimaryPageScrapeResult,
} from "./scrape_types.ts";
import { sha256HexBytes } from "./snapshot_store.ts";

const MAX_PIPELINE_STAGE_LENGTH = 100;
const ACTIVE = new Set(["queued", "batched", "running", "retryable_failed"]);

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

export class PageWorkflowTransport {
  constructor(
    private readonly svc: SupabaseClient,
    private readonly run: {
      id: string;
      scoutId: string;
      userId: string;
      tenantKey: string;
    },
  ) {}

  async scrape(
    opts: PrimaryPageScrapeOptions,
    stage: string,
  ): Promise<PrimaryPageScrapeResult> {
    // Queued primary work has already finished when fallback is admitted.
    // A Page child shares Phase B's remaining renderer budget; the primary
    // navigation fuse must not clip that budget a second time.
    const deadlineMs = opts.deadlineMs ??
      Date.now() + (opts.abortAfterMs ?? (opts.timeoutMs ?? 25_000) + 5_000);
    const job = await this.enqueue(opts.url, stage, opts.timeoutMs ?? 25_000);
    const current = await this.load(job.id);
    if (ACTIVE.has(current.status)) {
      throw new PageWorkflowPending(
        stage === "root" ? "waiting_root" : "waiting_children",
      );
    }
    if (current.status === "fallback_required") {
      const completed = await this.completeFallback(current, opts, deadlineMs);
      if (
        !completed && (await this.load(job.id)).status === "fallback_required"
      ) {
        throw new PageWorkflowPending(
          stage === "root" ? "waiting_root" : "waiting_children",
        );
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

  async prepareChildren(urls: string[], timeoutMs: number): Promise<void> {
    const jobs = await Promise.all(
      urls.map((url) => this.enqueue(url, childStage(url), timeoutMs)),
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
    return await enqueueCrawlerJob(this.svc, {
      requestKind: "scout_run",
      tenantKey: this.run.tenantKey,
      continuationKey: this.run.id,
      operation: "scrape",
      pipelineStage: stage,
      url,
      itemKey: stage,
      options: { timeout_ms: timeoutMs },
      scoutRunId: this.run.id,
      scoutId: this.run.scoutId,
      userId: this.run.userId,
      maxAttempts: 3,
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
    deadlineMs: number,
  ): Promise<boolean> {
    const reason = crawlerFallbackReason(
      "scrape",
      job.error_class,
      job.attempts,
      job.max_attempts,
    );
    if (!reason) throw new Error("crawler job has no eligible fallback reason");
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
          timeoutMs: opts.deadlineMs === undefined
            ? opts.timeoutMs
            : Math.floor(deadlineMs - Date.now()),
          workloadClass: "scout",
          formats: ["markdown", "rawHtml"],
        },
        reason,
        deadlineMs,
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
      return true;
    } catch (error) {
      const current = await this.load(job.id).catch(() => null);
      if (uploadedPath && current && current.status !== "succeeded") {
        await this.svc.storage.from("crawler-results").remove([uploadedPath]);
      }
      await this.svc.rpc("complete_crawler_fallback", {
        p_job_id: job.id,
        p_lease_token: leaseToken,
        p_ok: false,
        p_manifest: null,
        p_error: error instanceof Error ? error.message : String(error),
      });
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
