/**
 * Production-scheduler Page Scout smoke.
 *
 * Uses the same stable zero-unit page as the Page Scout benchmark. After the
 * product establishes a real baseline, the benchmark makes that stored
 * baseline deterministically stale. The production scheduler—not this
 * script—then has to dispatch the run and Any Change must alert on the real
 * canonical page delta despite creating zero units.
 */

import {
  assertLiveBenchmarkAllowed,
  dataApiHeaders,
  getCtx,
  pgSelectOne,
} from "./_bench_shared.ts";

const FIXTURE_URL = "https://example.com/";

async function apiJson<T>(
  url: string,
  init: RequestInit,
  label: string,
): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${label}: ${res.status} ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : null) as T;
}

function dailyCronAt(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} * * *`;
}

async function waitForBaseline(
  ctx: Awaited<ReturnType<typeof getCtx>>,
  scoutId: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const scout = await pgSelectOne<{ baseline_established_at: string | null }>(
      ctx,
      "scouts",
      { id: scoutId },
      "baseline_established_at",
    );
    if (scout?.baseline_established_at) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("timed out waiting for Page Scout baseline");
}

async function seedStaleBaseline(
  ctx: Awaited<ReturnType<typeof getCtx>>,
  scoutId: string,
): Promise<void> {
  const query = new URLSearchParams({
    select: "id",
    scout_id: `eq.${scoutId}`,
    source_url: `eq.${FIXTURE_URL}`,
    order: "captured_at.desc",
    limit: "1",
  });
  const lookup = await fetch(
    `${ctx.supabaseUrl}/rest/v1/raw_captures?${query}`,
    { headers: dataApiHeaders(ctx) },
  );
  if (!lookup.ok) {
    throw new Error(
      `baseline lookup failed: ${lookup.status} ${await lookup.text()}`,
    );
  }
  const [capture] = await lookup.json() as Array<{ id: string }>;
  if (!capture) throw new Error("creation baseline raw capture is missing");

  const update = await fetch(
    `${ctx.supabaseUrl}/rest/v1/raw_captures?id=eq.${capture.id}`,
    {
      method: "PATCH",
      headers: {
        ...dataApiHeaders(ctx),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content_md:
          "# Prior benchmark page\n\nThis deterministic prior content is replaced by the live example.com page.",
        content_sha256: "0".repeat(64),
        canonical_content_sha256: "0".repeat(64),
      }),
    },
  );
  if (!update.ok) {
    throw new Error(
      `baseline seed failed: ${update.status} ${await update.text()}`,
    );
  }
  await update.body?.cancel();
}

async function waitForScheduledRun(
  ctx: Awaited<ReturnType<typeof getCtx>>,
  scoutId: string,
  afterIso: string,
): Promise<{
  id: string;
  status: string;
  articles_count: number;
  notification_status: string | null;
  error_message: string | null;
}> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const qs = new URLSearchParams({
      select:
        "id,status,articles_count,notification_status,error_message,started_at",
      scout_id: `eq.${scoutId}`,
      started_at: `gt.${afterIso}`,
      order: "started_at.desc",
      limit: "1",
    });
    const res = await fetch(`${ctx.supabaseUrl}/rest/v1/scout_runs?${qs}`, {
      headers: dataApiHeaders(ctx),
    });
    if (!res.ok) {
      throw new Error(`run lookup failed: ${res.status} ${await res.text()}`);
    }
    const rows = await res.json() as Array<{
      id: string;
      status: string;
      articles_count: number;
      notification_status: string | null;
      error_message: string | null;
    }>;
    const run = rows[0];
    if (run && !["running", "pending"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("timed out waiting for the actual production scheduler");
}

async function main(): Promise<void> {
  const ctx = await getCtx();
  assertLiveBenchmarkAllowed(ctx.supabaseUrl, { firecrawl: true });
  if (!ctx.userToken) throw new Error("benchmark requires a user token");

  const apiHeaders = {
    apikey: ctx.anonKey,
    Authorization: `Bearer ${ctx.userToken}`,
    "Content-Type": "application/json",
  };
  let scoutId: string | null = null;

  try {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const scout = await apiJson<{ id: string }>(
      `${ctx.supabaseUrl}/functions/v1/scouts`,
      {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          name: `bench-page-scheduler-${crypto.randomUUID().slice(0, 8)}`,
          type: "web",
          url: FIXTURE_URL,
          criteria: "",
          topic: "web benchmark",
          preferred_language: "en",
          regularity: "daily",
          schedule_cron: dailyCronAt(tomorrow),
        }),
      },
      "create scout",
    );
    scoutId = scout.id;
    await waitForBaseline(ctx, scoutId);
    await seedStaleBaseline(ctx, scoutId);

    // Reschedule only after the baseline exists and has been made stale. The
    // scheduler—not this script—must create and dispatch the run.
    const due = new Date(Date.now() + 2 * 60 * 1000);
    await apiJson(
      `${ctx.supabaseUrl}/functions/v1/scouts/${scoutId}`,
      {
        method: "PATCH",
        headers: apiHeaders,
        body: JSON.stringify({
          is_active: true,
          regularity: "daily",
          schedule_cron: dailyCronAt(due),
        }),
      },
      "schedule scout",
    );

    const scheduledAfter = new Date().toISOString();
    const run = await waitForScheduledRun(ctx, scoutId, scheduledAfter);
    if (run.status !== "success") {
      throw new Error(
        `scheduled run ${run.status}: ${run.error_message ?? ""}`,
      );
    }
    if (run.articles_count !== 0) {
      throw new Error(
        `zero-unit fixture produced ${run.articles_count} units; fixture contract regressed`,
      );
    }
    if (run.notification_status !== "sent") {
      throw new Error(
        `Any Change notification was ${
          run.notification_status ?? "null"
        }, expected sent`,
      );
    }
    console.log(
      `PASS scheduler Any Change: run=${run.id} units=0 notification=sent`,
    );
  } finally {
    if (scoutId) {
      await fetch(`${ctx.supabaseUrl}/functions/v1/scouts/${scoutId}`, {
        method: "DELETE",
        headers: apiHeaders,
      }).catch(() => {});
    }
  }
}

if (import.meta.main) await main();
