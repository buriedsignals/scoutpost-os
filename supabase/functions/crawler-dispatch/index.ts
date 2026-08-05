import { z } from "https://esm.sh/zod@3";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonOk } from "../_shared/responses.ts";
import {
  refreshCrawlerRenderRuns,
  startCrawlerTask,
} from "../_shared/render_workflows.ts";

const Input = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("scheduled") }),
  z.object({
    mode: z.literal("single"),
    operation: z.enum(["scrape", "snapshot", "parse_pdf"]),
  }),
]);

const scheduledPlans = [
  { operation: "scrape" as const, batchSize: 20, maxBatches: 22 },
  { operation: "parse_pdf" as const, batchSize: 5, maxBatches: 4 },
  { operation: "snapshot" as const, batchSize: 1, maxBatches: 2 },
];

const START_CONCURRENCY = 8;

export async function handleCrawlerDispatch(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonError("method not allowed", 405);
  try {
    requireServiceKey(req);
  } catch {
    return jsonError("unauthorized", 401);
  }
  let input: z.infer<typeof Input>;
  try {
    input = Input.parse(await req.json());
  } catch {
    return jsonError("invalid dispatch input", 400);
  }

  const svc = getServiceClient();
  const { error: reconcileError } = await svc.rpc("reconcile_crawler_jobs");
  if (reconcileError) return jsonError("crawler reconciliation failed", 500);
  const plans = input.mode === "single"
    ? scheduledPlans.filter((plan) => plan.operation === input.operation).map(
      (plan) => ({ ...plan, maxBatches: 1 }),
    )
    : scheduledPlans;
  let formed = 0;
  let submitted = 0;
  let deferred = 0;
  let ambiguous = 0;
  let budgetExhausted = false;
  const batchIds: string[] = [];

  for (const plan of plans) {
    if (budgetExhausted) break;
    const { data: pending, error: pendingError } = await svc
      .from("crawler_batches")
      .select("id")
      .eq("operation", plan.operation)
      .eq("status", "pending")
      .is("render_task_run_id", null)
      .is("submission_reservation_token", null)
      .order("created_at", { ascending: true })
      .limit(plan.maxBatches);
    if (pendingError) {
      return jsonError("crawler pending batch read failed", 500);
    }
    const candidates = (pending ?? []).map((batch) => ({ batch_id: batch.id }));
    const remaining = plan.maxBatches - candidates.length;
    let created: Array<{ batch_id: string }> = [];
    if (remaining > 0) {
      const { data: batches, error } = await svc.rpc("create_crawler_batches", {
        p_operation: plan.operation,
        p_batch_size: plan.batchSize,
        p_job_limit: plan.batchSize * remaining,
      });
      if (error) return jsonError("crawler batch creation failed", 500);
      created = batches ?? [];
      formed += created.length;
      candidates.push(...created);
    }
    // Render task starts are independent. Bounded parallelism keeps a busy
    // dispatch within the Edge Function deadline without creating an
    // unbounded fan-out or bypassing the database reservation gate.
    let nextCandidate = 0;
    const workers = Array.from(
      { length: Math.min(START_CONCURRENCY, candidates.length) },
      async () => {
        while (!budgetExhausted) {
          const index = nextCandidate++;
          const batch = candidates[index];
          if (!batch) return;
          batchIds.push(batch.batch_id);
          const { data: reservationToken, error: reserveError } = await svc.rpc(
            "reserve_crawler_batch_submission",
            { p_batch_id: batch.batch_id, p_limit: 28 },
          );
          if (reserveError) throw new Error("crawler reservation failed");
          if (!reservationToken) {
            deferred++;
            budgetExhausted = true;
            return;
          }

          try {
            const taskRunId = await startCrawlerTask(batch.batch_id);
            const { data: marked, error: markError } = await svc.rpc(
              "mark_crawler_batch_submitted",
              {
                p_batch_id: batch.batch_id,
                p_reservation_token: reservationToken,
                p_render_task_run_id: taskRunId,
              },
            );
            if (markError || marked !== true) {
              // The task exists and may already be claiming. Its batch remains
              // reserved; claim/reconciliation is safe without another POST.
              ambiguous++;
              continue;
            }
            submitted++;
          } catch {
            // A timeout/5xx may have reached Render. Never issue a second POST
            // for this reservation. An unclaimed pending batch self-releases.
            ambiguous++;
          }
        }
      },
    );
    try {
      await Promise.all(workers);
    } catch {
      return jsonError("crawler reservation failed", 500);
    }
  }

  let reconciled = 0;
  if (input.mode === "scheduled") {
    try {
      // Task starts are never held behind Render reads. This dispatcher is the
      // sole recurring reconciliation owner once its post-Gate cron is enabled.
      reconciled = await refreshCrawlerRenderRuns(svc, 60);
    } catch {
      // Stale metrics remain visible; accepted task starts are not rolled back.
    }
  }

  return jsonOk({
    ok: true,
    formed,
    submitted,
    deferred,
    ambiguous,
    reconciled,
    batch_ids: batchIds,
  });
}

if (import.meta.main) Deno.serve(handleCrawlerDispatch);
