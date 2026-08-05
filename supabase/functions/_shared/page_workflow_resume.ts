import { internalServiceAuthHeaders } from "./auth.ts";

export interface PageWorkflowResume {
  runId: string;
  scoutId: string;
}

export async function resumePageRuns(
  runs: PageWorkflowResume[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL");
  if (runs.length === 0) return;
  if (!base) throw new Error("SUPABASE_URL is required for Page resume");
  const outcomes = await Promise.allSettled(
    runs.map(async ({ runId, scoutId }) => {
      const response = await fetchImpl(
        `${base}/functions/v1/scout-web-execute`,
        {
          method: "POST",
          headers: {
            ...internalServiceAuthHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ scout_id: scoutId, run_id: runId }),
          signal: AbortSignal.timeout(150_000),
        },
      );
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error(`page resume failed: ${response.status}`);
      }
    }),
  );
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    throw new Error("one or more Page workflow resumes failed");
  }
}
