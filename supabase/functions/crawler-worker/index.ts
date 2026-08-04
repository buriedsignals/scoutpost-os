import { z } from "https://esm.sh/zod@3";
import { timingSafeEqual } from "../_shared/auth.ts";
import { sha256HexBytes } from "../_shared/snapshot_store.ts";
import type { SupabaseClient } from "../_shared/supabase.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonOk } from "../_shared/responses.ts";

const MiB = 1024 * 1024;
export const COMPRESSED_ARTIFACT_MAX = 50 * MiB;
export const RESULT_JSON_DECODED_MAX = 16 * MiB;
export const SNAPSHOT_ARTIFACT_DECODED_MAX = 25 * MiB;
export const SNAPSHOT_COMBINED_DECODED_MAX = 30 * MiB;
const REQUEST_MAX = 128 * 1024;
const UUID = z.string().uuid();

const Artifact = z.object({
  kind: z.enum(["result", "mhtml", "screenshot"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(COMPRESSED_ARTIFACT_MAX),
});
const Completion = z.discriminatedUnion("ok", [
  z.object({
    job_id: UUID,
    attempt_id: UUID,
    execution_id: UUID,
    ok: z.literal(true),
    artifacts: z.array(Artifact).min(1).max(3),
  }),
  z.object({
    job_id: UUID,
    attempt_id: UUID,
    execution_id: UUID,
    ok: z.literal(false),
    error_class: z.enum(["anti_bot", "timeout", "retryable", "terminal"]),
    error: z.string().max(1500),
  }),
]);
const Input = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("claim"),
    batch_id: UUID,
    execution_id: UUID,
  }),
  z.object({
    action: z.literal("complete"),
    batch_id: UUID,
    results: z.array(Completion).min(1).max(20),
    response_delay_ms: z.number().int().min(0).max(5_000).optional(),
  }),
]);

type CompletionInput = z.infer<typeof Completion>;
type ArtifactInput = z.infer<typeof Artifact>;
type Operation = "scrape" | "snapshot" | "parse_pdf";

interface ClaimedJob {
  id: string;
  lease_token: string;
  operation: Operation;
  url: string;
  options?: Record<string, unknown>;
  request_kind: string;
  attempt: number;
}

interface JobState {
  id: string;
  batch_id: string;
  lease_token: string;
  operation: Operation;
  status: string;
  request_kind: string;
  continuation_key: string;
  result_manifest?: Record<string, unknown> | null;
}

const encoder = new TextEncoder();
export { timingSafeEqual };

export function workerTokenAccepted(
  provided: string,
  env: Record<string, string | undefined>,
  now = new Date(),
): boolean {
  if (timingSafeEqual(provided, env.WORKFLOW_WORKER_TOKEN)) return true;
  if (!timingSafeEqual(provided, env.WORKFLOW_WORKER_TOKEN_PREVIOUS)) {
    return false;
  }
  const rawExpiry = env.WORKFLOW_WORKER_TOKEN_PREVIOUS_EXPIRES_AT;
  if (!rawExpiry) return false;
  const expiry = new Date(rawExpiry);
  if (!Number.isFinite(expiry.getTime())) return false;
  const remaining = expiry.getTime() - now.getTime();
  return remaining >= 0 && remaining <= 24 * 60 * 60 * 1000;
}

function authorize(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const provided = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  return workerTokenAccepted(provided, {
    WORKFLOW_WORKER_TOKEN: Deno.env.get("WORKFLOW_WORKER_TOKEN"),
    WORKFLOW_WORKER_TOKEN_PREVIOUS: Deno.env.get(
      "WORKFLOW_WORKER_TOKEN_PREVIOUS",
    ),
    WORKFLOW_WORKER_TOKEN_PREVIOUS_EXPIRES_AT: Deno.env.get(
      "WORKFLOW_WORKER_TOKEN_PREVIOUS_EXPIRES_AT",
    ),
  });
}

async function parseInput(req: Request): Promise<z.infer<typeof Input>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > REQUEST_MAX) {
    throw new WorkerInputError("request too large");
  }
  const raw = await req.text();
  if (encoder.encode(raw).length > REQUEST_MAX) {
    throw new WorkerInputError("request too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerInputError("invalid JSON");
  }
  const result = Input.safeParse(parsed);
  if (!result.success) throw new WorkerInputError("invalid worker input");
  return result.data;
}

class WorkerInputError extends Error {}

export async function claimBatch(
  svc: SupabaseClient,
  batchId: string,
  executionId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await svc.rpc("claim_crawler_batch", {
    p_batch_id: batchId,
    p_lease_seconds: 600,
  });
  if (error) throw new Error("claim failed");
  const jobs = (data ?? []) as ClaimedJob[];
  return await Promise.all(jobs.map(async (job) => {
    const specs: [ArtifactInput["kind"], string][] = [
      ["result", artifactPath(job.id, job.lease_token, executionId, "result")],
      ...(job.operation === "snapshot"
        ? [
          [
            "mhtml",
            artifactPath(job.id, job.lease_token, executionId, "mhtml"),
          ],
          [
            "screenshot",
            artifactPath(job.id, job.lease_token, executionId, "screenshot"),
          ],
        ] as [ArtifactInput["kind"], string][]
        : []),
    ];
    const uploads: Record<string, { url: string }> = {};
    for (const [kind, path] of specs) {
      const { data: signed, error: uploadError } = await svc.storage
        .from("crawler-results").createSignedUploadUrl(path, { upsert: false });
      if (uploadError || !signed?.signedUrl) {
        throw new Error("upload signing failed");
      }
      uploads[kind] = { url: signed.signedUrl };
    }
    return {
      id: job.id,
      attempt_id: job.lease_token,
      execution_id: executionId,
      operation: job.operation,
      url: job.url,
      timeout_ms: boundedTimeout(job.options?.timeout_ms),
      ...(job.request_kind === "benchmark"
        ? {
          minimum_duration_ms: boundedBenchmarkDuration(job.options),
          ...benchmarkFaults(job),
        }
        : {}),
      uploads,
    };
  }));
}

export function benchmarkFaults(job: ClaimedJob): Record<string, unknown> {
  if (job.request_kind !== "benchmark" || job.attempt !== 1) return {};
  const options = job.options ?? {};
  return {
    ...(options.inject_task_exit_after === 5 ? { fault_exit_after: 5 } : {}),
    ...(options.inject_callback_timeout === true
      ? { fault_callback_timeout: true }
      : {}),
  };
}

function boundedTimeout(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(120_000, Math.max(1_000, value))
    : 25_000;
}

function boundedBenchmarkDuration(options: unknown): number {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return 0;
  }
  const value = (options as Record<string, unknown>).minimum_duration_ms;
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(60_000, Math.max(0, value))
    : 0;
}

export function artifactPath(
  jobId: string,
  attemptId: string,
  executionId: string,
  kind: ArtifactInput["kind"],
): string {
  const suffix = kind === "result"
    ? ".json.gz"
    : kind === "mhtml"
    ? ".mhtml.gz"
    : ".png";
  return `results/${jobId}/${attemptId}/${executionId}${suffix}`;
}

function expectedArtifactPaths(
  job: JobState,
  completion: CompletionInput,
): string[] {
  const kinds: ArtifactInput["kind"][] = job.operation === "snapshot"
    ? ["result", "mhtml", "screenshot"]
    : ["result"];
  return kinds.map((kind) =>
    artifactPath(
      completion.job_id,
      completion.attempt_id,
      completion.execution_id,
      kind,
    )
  );
}

export async function readStreamLimited(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) throw new Error("artifact has no body");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("artifact exceeds limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export async function gunzipLimited(
  bytes: Uint8Array,
  limit: number,
): Promise<Uint8Array> {
  const input = new Blob([bytes.slice().buffer]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return await readStreamLimited(input, limit);
}

async function fetchArtifact(
  svc: SupabaseClient,
  path: string,
  artifact: ArtifactInput,
): Promise<Uint8Array> {
  const { data, error } = await svc.storage.from("crawler-results")
    .createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw new Error("artifact signing failed");
  const response = await fetch(data.signedUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("artifact unavailable");
  }
  const bytes = await readStreamLimited(response.body, artifact.bytes);
  if (bytes.byteLength !== artifact.bytes) {
    throw new Error("artifact size mismatch");
  }
  if (await sha256HexBytes(bytes) !== artifact.sha256) {
    throw new Error("artifact hash mismatch");
  }
  return bytes;
}

export function validateResultSchema(
  operation: Operation,
  value: unknown,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid result schema");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.markdown !== "string" || typeof result.source_url !== "string"
  ) {
    throw new Error("invalid result schema");
  }
  if (
    operation === "parse_pdf" && (
      !Number.isInteger(result.pages) || !Number.isInteger(result.chars) ||
      typeof result.parser !== "string"
    )
  ) {
    throw new Error("invalid PDF result schema");
  }
}

export async function verifyCompletionBundle(
  svc: SupabaseClient,
  job: JobState,
  completion: Extract<CompletionInput, { ok: true }>,
): Promise<{ manifest: Record<string, unknown>; paths: string[] }> {
  const byKind = new Map(completion.artifacts.map((item) => [item.kind, item]));
  if (byKind.size !== completion.artifacts.length || !byKind.has("result")) {
    throw new Error("invalid artifact set");
  }
  if (job.operation === "snapshot") {
    if (
      byKind.size !== 3 || !byKind.has("mhtml") || !byKind.has("screenshot")
    ) {
      throw new Error("snapshot artifacts missing");
    }
  } else if (byKind.size !== 1) {
    throw new Error("unexpected artifacts");
  }

  const paths: string[] = [];
  const verified: Record<string, unknown>[] = [];
  let snapshotDecoded = 0;
  for (const artifact of completion.artifacts) {
    const path = artifactPath(
      completion.job_id,
      completion.attempt_id,
      completion.execution_id,
      artifact.kind,
    );
    paths.push(path);
    const bytes = await fetchArtifact(svc, path, artifact);
    if (artifact.kind === "result") {
      const decoded = await gunzipLimited(bytes, RESULT_JSON_DECODED_MAX);
      let result: unknown;
      try {
        result = JSON.parse(new TextDecoder().decode(decoded));
      } catch {
        throw new Error("invalid result JSON");
      }
      validateResultSchema(job.operation, result);
    } else if (artifact.kind === "mhtml") {
      snapshotDecoded += (
        await gunzipLimited(bytes, SNAPSHOT_ARTIFACT_DECODED_MAX)
      ).byteLength;
    } else {
      if (bytes.byteLength > SNAPSHOT_ARTIFACT_DECODED_MAX) {
        throw new Error("screenshot exceeds limit");
      }
      const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (!magic.every((value, index) => bytes[index] === value)) {
        throw new Error("screenshot is not PNG");
      }
      snapshotDecoded += bytes.byteLength;
    }
    verified.push({ ...artifact, path });
  }
  if (snapshotDecoded > SNAPSHOT_COMBINED_DECODED_MAX) {
    throw new Error("snapshot bundle exceeds limit");
  }
  return {
    manifest: {
      execution_id: completion.execution_id,
      artifacts: verified,
    },
    paths,
  };
}

async function loadJob(
  svc: SupabaseClient,
  batchId: string,
  completion: CompletionInput,
): Promise<JobState | null> {
  const { data, error } = await svc.from("crawler_jobs")
    .select(
      "id,batch_id,lease_token,operation,status,request_kind,continuation_key,result_manifest",
    )
    .eq("id", completion.job_id)
    .eq("batch_id", batchId)
    .maybeSingle();
  if (error) throw new Error("job lookup failed");
  return data as JobState | null;
}

export function rejectedBundleIsLosing(
  job: JobState,
  completion: CompletionInput,
): boolean {
  return job.result_manifest?.execution_id !== completion.execution_id;
}

async function assertBenchmarkResponseDelay(
  svc: SupabaseClient,
  batchId: string,
  results: CompletionInput[],
): Promise<void> {
  for (const completion of results) {
    const job = await loadJob(svc, batchId, completion);
    if (!job || job.request_kind !== "benchmark") {
      throw new WorkerInputError("response delay is benchmark-only");
    }
  }
}

export async function completeBatch(
  svc: SupabaseClient,
  batchId: string,
  results: CompletionInput[],
): Promise<{ accepted: number; rejected: number }> {
  let accepted = 0;
  let rejected = 0;
  for (const completion of results) {
    const job = await loadJob(svc, batchId, completion);
    if (
      !job || job.status !== "running" ||
      !timingSafeEqual(job.lease_token, completion.attempt_id)
    ) {
      if (job && rejectedBundleIsLosing(job, completion)) {
        await svc.storage.from("crawler-results")
          .remove(expectedArtifactPaths(job, completion)).catch(() => {});
      }
      rejected++;
      continue;
    }

    let paths = expectedArtifactPaths(job, completion);
    let changed = false;
    try {
      if (completion.ok) {
        const bundle = await verifyCompletionBundle(svc, job, completion);
        paths = bundle.paths;
        const response = await svc.rpc("complete_crawler_job", {
          p_job_id: completion.job_id,
          p_lease_token: completion.attempt_id,
          p_ok: true,
          p_manifest: bundle.manifest,
          p_error_class: null,
          p_error: null,
        });
        if (response.error) throw new Error("completion failed");
        changed = response.data === true;
      } else {
        const response = await svc.rpc("complete_crawler_job", {
          p_job_id: completion.job_id,
          p_lease_token: completion.attempt_id,
          p_ok: false,
          p_manifest: null,
          p_error_class: completion.error_class,
          p_error: completion.error,
        });
        if (response.error) throw new Error("completion failed");
        changed = response.data === true;
        await svc.storage.from("crawler-results").remove(paths).catch(() => {});
        paths = [];
      }
    } catch {
      if (paths.length > 0) {
        await svc.storage.from("crawler-results").remove(paths).catch(() => {});
      }
      throw new Error("crawler completion rejected");
    }
    if (!changed && paths.length > 0) {
      await svc.storage.from("crawler-results").remove(paths);
    }
    if (changed) accepted++;
    else rejected++;
  }
  return { accepted, rejected };
}

export async function handleCrawlerWorker(
  req: Request,
  svc = getServiceClient(),
): Promise<Response> {
  if (req.method !== "POST") return jsonError("method not allowed", 405);
  if (!authorize(req)) return jsonError("unauthorized", 401);
  let input: z.infer<typeof Input>;
  try {
    input = await parseInput(req);
  } catch (error) {
    if (error instanceof WorkerInputError) return jsonError(error.message, 400);
    return jsonError("invalid worker input", 400);
  }
  try {
    if (input.action === "claim") {
      return jsonOk({
        jobs: await claimBatch(svc, input.batch_id, input.execution_id),
      });
    }
    if (input.response_delay_ms) {
      await assertBenchmarkResponseDelay(svc, input.batch_id, input.results);
    }
    const completed = await completeBatch(svc, input.batch_id, input.results);
    if (input.response_delay_ms) {
      await new Promise((resolve) =>
        setTimeout(resolve, input.response_delay_ms)
      );
    }
    return jsonOk({
      ok: true,
      ...completed,
    });
  } catch {
    return jsonError("crawler worker failed", 500);
  }
}

if (import.meta.main) Deno.serve((req) => handleCrawlerWorker(req));
