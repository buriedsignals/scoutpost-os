import type { SupabaseClient } from "./supabase.ts";
import { type CrawlerJobRow, enqueueCrawlerJob } from "./crawler_jobs.ts";
import { firecrawlScrape } from "./scrape_firecrawl.ts";
import type {
  PrimaryPageScrapeOptions,
  PrimaryPageScrapeResult,
} from "./scrape_types.ts";
import { sha256HexBytes } from "./snapshot_store.ts";

const RESULT_LIMIT = 16 * 1024 * 1024;
const MAX_PIPELINE_STAGE_LENGTH = 100;
const ACTIVE = new Set(["queued", "batched", "running", "retryable_failed"]);

interface StoredCrawlerJob extends CrawlerJobRow {
  url: string;
  attempts: number;
  error_class: string | null;
  error_message: string | null;
  result_manifest: Record<string, unknown> | null;
}

interface ResultArtifact {
  kind: string;
  path: string;
  bytes: number;
  sha256: string;
}

export class PageWorkflowPending extends Error {
  constructor(readonly stage: "waiting_root" | "waiting_children") {
    super(stage);
  }
}

export class PageWorkflowTransport {
  private readonly failedFallbackJobs = new Set<string>();

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
    const job = await this.enqueue(opts.url, stage, opts.timeoutMs ?? 25_000);
    const current = await this.load(job.id);
    if (ACTIVE.has(current.status)) {
      throw new PageWorkflowPending(
        stage === "root" ? "waiting_root" : "waiting_children",
      );
    }
    if (current.status === "fallback_required") {
      if (this.failedFallbackJobs.has(current.id)) {
        throw new Error("anti-bot fallback failed");
      }
      await this.completeAntiBotFallback(current, opts);
      return await this.scrape(opts, stage);
    }
    if (current.status !== "succeeded") {
      throw new Error(
        current.error_message || current.error_class || "crawler job failed",
      );
    }
    const result = await loadResult(this.svc, current.result_manifest);
    const pageResult = result as unknown as PrimaryPageScrapeResult;
    return {
      ...pageResult,
      served_by: manifestProvider(current.result_manifest) ?? "crawl4ai",
      scrape_strategy: manifestProvider(current.result_manifest) === "firecrawl"
        ? "workflow_antibot_fallback"
        : "workflow",
      scrape_attempts: Math.max(1, current.attempts),
    };
  }

  async prepareChildren(urls: string[], timeoutMs: number): Promise<void> {
    const jobs = await Promise.all(
      urls.map((url) => this.enqueue(url, childStage(url), timeoutMs)),
    );
    const rows = await Promise.all(jobs.map((job) => this.load(job.id)));
    for (const row of rows) {
      if (row.status === "fallback_required") {
        try {
          await this.completeAntiBotFallback(row, {
            url: row.url,
            workloadClass: "scout",
            timeoutMs,
          });
        } catch {
          // Child failures are recorded by the existing Page pipeline per URL.
          this.failedFallbackJobs.add(row.id);
        }
      }
    }
    const refreshed = await Promise.all(jobs.map((job) => this.load(job.id)));
    if (refreshed.some((row) => ACTIVE.has(row.status))) {
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
    const paths = rows.flatMap((row) => manifestArtifacts(row.result_manifest))
      .map((artifact) => artifact.path);
    if (paths.length > 0) {
      const removed = await this.svc.storage.from("crawler-results").remove(
        paths,
      );
      if (removed.error) throw new Error("crawler result cleanup failed");
    }
    if (rows.length > 0) {
      const cleared = await this.svc.from("crawler_jobs")
        .update({ result_manifest: null })
        .in("id", rows.map((row) => row.id));
      if (cleared.error) throw new Error("crawler manifest cleanup failed");
    }
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
        "id,dedupe_key,status,request_kind,continuation_key,url,attempts,error_class,error_message,result_manifest",
      )
      .eq("id", id)
      .single();
    if (error || !data) throw new Error("crawler job lookup failed");
    return data as StoredCrawlerJob;
  }

  private async completeAntiBotFallback(
    job: StoredCrawlerJob,
    opts: PrimaryPageScrapeOptions,
  ): Promise<void> {
    let uploadedPath: string | null = null;
    try {
      const result = {
        ...await firecrawlScrape(opts.url, {
          workloadClass: "scout",
          timeoutMs: opts.timeoutMs,
          formats: ["markdown", "rawHtml"],
        }),
        served_by: "firecrawl",
      };
      const bytes = await gzipJson(result);
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
        artifacts: [{
          kind: "result",
          path,
          bytes: bytes.byteLength,
          sha256: await sha256HexBytes(bytes),
        }],
      };
      const completed = await this.svc.rpc("complete_crawler_fallback", {
        p_job_id: job.id,
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
          return;
        }
        throw new Error("fallback completion rejected");
      }
    } catch (error) {
      const current = await this.load(job.id).catch(() => null);
      if (uploadedPath && current && current.status !== "succeeded") {
        await this.svc.storage.from("crawler-results").remove([uploadedPath]);
      }
      await this.svc.rpc("complete_crawler_fallback", {
        p_job_id: job.id,
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

function manifestProvider(
  manifest: Record<string, unknown> | null,
): "firecrawl" | "crawl4ai" | null {
  return manifest?.provider === "firecrawl" || manifest?.provider === "crawl4ai"
    ? manifest.provider
    : null;
}

function manifestArtifacts(
  manifest: Record<string, unknown> | null,
): ResultArtifact[] {
  if (!Array.isArray(manifest?.artifacts)) return [];
  return manifest.artifacts.filter((value): value is ResultArtifact => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.kind === "string" && typeof item.path === "string" &&
      Number.isInteger(item.bytes) && typeof item.sha256 === "string";
  });
}

async function loadResult(
  svc: SupabaseClient,
  manifest: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const artifact = manifestArtifacts(manifest).find((item) =>
    item.kind === "result"
  );
  if (!artifact || artifact.bytes < 1 || artifact.bytes > RESULT_LIMIT) {
    throw new Error("invalid crawler result manifest");
  }
  const signed = await svc.storage.from("crawler-results")
    .createSignedUrl(artifact.path, 60);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error("crawler result signing failed");
  }
  const response = await fetch(signed.data.signedUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("crawler result unavailable");
  const compressed = new Uint8Array(await response.arrayBuffer());
  if (
    compressed.byteLength !== artifact.bytes ||
    await sha256HexBytes(compressed) !== artifact.sha256
  ) {
    throw new Error("crawler result integrity failure");
  }
  const decoded = await gunzipLimited(compressed, RESULT_LIMIT);
  const parsed = JSON.parse(new TextDecoder().decode(decoded));
  if (
    !parsed || typeof parsed !== "object" ||
    typeof parsed.markdown !== "string" ||
    typeof parsed.source_url !== "string"
  ) {
    throw new Error("invalid crawler result");
  }
  return parsed as Record<string, unknown>;
}

async function gzipJson(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return await readLimited(stream, RESULT_LIMIT);
}

async function gunzipLimited(
  bytes: Uint8Array,
  limit: number,
): Promise<Uint8Array> {
  return await readLimited(
    new Blob([bytes.slice().buffer]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    ),
    limit,
  );
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) throw new Error("crawler result exceeds limit");
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
