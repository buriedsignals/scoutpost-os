import type { SupabaseClient } from "./supabase.ts";

const API_BASE = "https://api.render.com/v1";

export interface RenderTaskRun {
  id: string;
  status:
    | "canceled"
    | "completed"
    | "failed"
    | "paused"
    | "pending"
    | "running"
    | "succeeded";
  retries?: number;
  attempts?: Array<{ startedAt?: string; completedAt?: string }>;
  results?: unknown[];
  startedAt?: string;
  completedAt?: string;
}

export class RenderWorkflowError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${requiredEnv("RENDER_WORKFLOW_API_KEY")}`,
    "content-type": "application/json",
  };
}

/** Uses the current official SDK contract: POST /v1/task-runs. */
export async function startCrawlerTask(batchId: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/task-runs`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        task: requiredEnv("RENDER_CRAWLER_TASK_SLUG"),
        // Render's task API passes a JSON array as positional arguments.
        input: [batchId],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RenderWorkflowError("render task start transport");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new RenderWorkflowError(
      "render task start rejected",
      response.status,
    );
  }
  const body = await response.json().catch(() => null) as
    | { id?: unknown }
    | null;
  if (typeof body?.id !== "string" || !body.id) {
    throw new RenderWorkflowError(
      "render task start missing id",
      response.status,
    );
  }
  return body.id;
}

export async function getCrawlerTaskRun(
  taskRunId: string,
): Promise<RenderTaskRun> {
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE}/task-runs/${encodeURIComponent(taskRunId)}`,
      {
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new RenderWorkflowError("render task read transport");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new RenderWorkflowError("render task read rejected", response.status);
  }
  const body = await response.json() as Partial<RenderTaskRun>;
  if (typeof body.id !== "string" || typeof body.status !== "string") {
    throw new RenderWorkflowError("render task read invalid response");
  }
  return body as RenderTaskRun;
}

export async function refreshCrawlerRenderRuns(
  svc: SupabaseClient,
  limit = 60,
): Promise<number> {
  const { data, error } = await svc.from("crawler_batches")
    .select("id,render_task_run_id,submitted_at")
    .not("render_task_run_id", "is", null)
    .eq("render_terminal", false)
    .order("render_metrics_checked_at", { ascending: true, nullsFirst: true })
    .limit(Math.min(100, Math.max(1, limit)));
  if (error) throw new Error("active crawler batch read failed");
  let refreshed = 0;
  const batches = data ?? [];
  let cursor = 0;
  const refreshNext = async (): Promise<void> => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      if (!batch) return;
      try {
        const task = await getCrawlerTaskRun(batch.render_task_run_id);
        const result = lastObject(task.results);
        const attemptSeconds = (task.attempts ?? []).reduce(
          (total, attempt) =>
            total +
            (secondsBetween(attempt.startedAt, attempt.completedAt) ?? 0),
          0,
        );
        const { error: updateError } = await svc.rpc(
          "reconcile_crawler_render_run",
          {
            p_batch_id: batch.id,
            p_render_task_run_id: batch.render_task_run_id,
            p_status: task.status,
            p_metrics: {
              status: task.status,
              // The API's top-level retries value was zero during Gate A even
              // when attempt history proved a retry. Attempts are authoritative.
              retry_count: Math.max(0, (task.attempts?.length ?? 0) - 1),
              attempt_count: task.attempts?.length ?? 0,
              accepted_to_start_seconds: secondsBetween(
                batch.submitted_at,
                task.startedAt,
              ),
              attempt_seconds: attemptSeconds,
              started_at: task.startedAt ?? null,
              completed_at: task.completedAt ?? null,
              memory_peak_bytes: numericField(result, "memory_peak_bytes"),
              outbound_bytes: numericField(result, "outbound_bytes"),
              allowed_connections: numericField(result, "allowed_connections"),
              blocked_connections: numericField(result, "blocked_connections"),
            },
          },
        );
        if (!updateError) refreshed++;
      } catch {
        // Staleness remains visible through render_metrics_checked_at.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, batches.length) }, () => refreshNext()),
  );
  return refreshed;
}

function lastObject(
  values: unknown[] | undefined,
): Record<string, unknown> | null {
  const value = values?.at(-1);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numericField(
  value: Record<string, unknown> | null,
  key: string,
): number | null {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function secondsBetween(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null;
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}
