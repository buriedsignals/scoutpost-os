/**
 * Local-only integration proof for the work-conserving Scout dispatcher.
 *
 * Run through scripts/tests/run-scout-dispatch-drain-integration.sh. The test
 * refuses every non-loopback Supabase URL and self-skips in the ordinary unit
 * suite. It uses the real local queue RPCs and handler with an HTTP fake for
 * the three Scout workers; Render and production are never contacted.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { createScoutDispatchHandler } from "./handler.ts";

const ENABLED = Deno.env.get("SCOUT_DISPATCH_RUNTIME_SMOKE") === "1";
const BURST_SIZE = 326;
const WAVE_CAPACITY = 10;
const DRAIN_CEILING = 30;

interface BurstFixture {
  runIds: string[];
}

interface QueueRow {
  scout_run_id: string;
  status: string;
  attempts: number;
  last_error_code: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
}

interface WorkerMetrics {
  attemptedRunIds: string[];
  receivedRunIds: string[];
  active: number;
  peakActive: number;
}

interface WorkerBehavior {
  httpFailureRunIds: Set<string>;
  networkFailureRunIds: Set<string>;
}

Deno.test({
  name:
    "scout dispatch runtime: real queue RPCs drain bursts without duplicates or capacity overflow",
  ignore: !ENABLED,
  async fn() {
    const apiUrl = requiredEnv("SUPABASE_URL", "API_URL").replace(/\/$/, "");
    assertLoopbackTarget(apiUrl);
    const serviceRoleKey = requiredEnv(
      "SUPABASE_SERVICE_ROLE_KEY",
      "SERVICE_ROLE_KEY",
      "SECRET_KEY",
    );
    const service = createClient(apiUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const previousEnv = setDispatcherEnv(apiUrl, serviceRoleKey);
    const metrics: WorkerMetrics = {
      attemptedRunIds: [],
      receivedRunIds: [],
      active: 0,
      peakActive: 0,
    };
    const behavior: WorkerBehavior = {
      httpFailureRunIds: new Set(),
      networkFailureRunIds: new Set(),
    };
    const fakeWorker = await startFakeWorker(metrics, behavior);
    const pendingWork: Promise<unknown>[] = [];
    const handler = createScoutDispatchHandler({
      getServiceClient: () => service,
      fetch: fakeWorker.fetch,
      logEvent: () => undefined,
      waitUntil: (work) => pendingWork.push(work),
    });
    let userId = "";

    try {
      userId = await createFixtureUser(apiUrl, serviceRoleKey);

      const burst = await seedBurst(service, userId, BURST_SIZE, "monday");
      behavior.httpFailureRunIds.add(burst.runIds[16]);
      behavior.networkFailureRunIds.add(burst.runIds[70]);

      const launchesPerInvocation: number[] = [];
      for (let invocation = 0; invocation < 11; invocation += 1) {
        const attemptsBefore = metrics.attemptedRunIds.length;
        const response = await invokeDrain(handler, serviceRoleKey);
        assertEquals(response.status, 202);
        assertEquals(response.body.capacity, WAVE_CAPACITY);
        assertEquals(response.body.max_launches_per_drain, DRAIN_CEILING);
        assertEquals(pendingWork.length, 1);

        if (invocation === 0) {
          assertEquals(
            metrics.attemptedRunIds.length - attemptsBefore,
            WAVE_CAPACITY,
            "the HTTP response must return while only the first wave is active",
          );
        }

        await Promise.all(pendingWork.splice(0));
        launchesPerInvocation.push(
          metrics.attemptedRunIds.length - attemptsBefore,
        );
      }

      assertEquals(
        launchesPerInvocation,
        [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 26],
      );
      assertEquals(metrics.attemptedRunIds.length, BURST_SIZE);
      assertEquals(new Set(metrics.attemptedRunIds).size, BURST_SIZE);
      assertEquals(metrics.receivedRunIds.length, BURST_SIZE - 1);
      assertEquals(new Set(metrics.receivedRunIds).size, BURST_SIZE - 1);
      assertEquals(metrics.peakActive, WAVE_CAPACITY);

      const idle = await invokeDrain(handler, serviceRoleKey);
      assertEquals(idle.status, 200);
      assertEquals(idle.body.status, "idle");
      assertEquals(pendingWork.length, 0);

      let rows = rowsForBurst(await queueRows(service, userId), burst);
      assertStatusCounts(rows, { waiting: 324, failed: 2 });
      assertEquals(rows.every((row) => row.attempts === 1), true);
      assertEquals(
        rows.filter((row) => row.last_error_code === "worker_http_503").length,
        1,
      );
      assertEquals(
        rows.filter((row) => row.last_error_code === "dispatch_network_error")
          .length,
        1,
      );
      await finishWaitingRuns(service, rows);
      rows = rowsForBurst(await queueRows(service, userId), burst);
      assertStatusCounts(rows, { done: 324, failed: 2 });

      const overlap = await seedBurst(service, userId, 60, "overlap");
      const overlapStart = metrics.attemptedRunIds.length;
      metrics.peakActive = 0;
      const overlappingResponses = await Promise.all([
        invokeDrain(handler, serviceRoleKey),
        invokeDrain(handler, serviceRoleKey),
        invokeDrain(handler, serviceRoleKey),
      ]);
      assert(
        overlappingResponses.every((response) =>
          response.status === 200 || response.status === 202
        ),
      );
      await Promise.all(pendingWork.splice(0));

      for (
        let refill = 0;
        metrics.attemptedRunIds.length - overlapStart < overlap.runIds.length &&
        refill < 3;
        refill += 1
      ) {
        const response = await invokeDrain(handler, serviceRoleKey);
        assertEquals(response.status, 202);
        await Promise.all(pendingWork.splice(0));
      }

      const overlapAttempts = metrics.attemptedRunIds.slice(overlapStart);
      assertEquals(overlapAttempts.length, overlap.runIds.length);
      assertEquals(new Set(overlapAttempts).size, overlap.runIds.length);
      assert(
        metrics.peakActive <= WAVE_CAPACITY,
        `overlapping drains reached ${metrics.peakActive} active workers`,
      );
      rows = rowsForBurst(await queueRows(service, userId), overlap);
      assertStatusCounts(rows, { waiting: 60 });
      await finishWaitingRuns(service, rows);

      const recovery = await seedBurst(service, userId, 1, "recovery");
      const { data: abandoned, error: abandonError } = await service.rpc(
        "claim_scout_dispatch_batch",
        {
          p_worker_id: "integration-abandoned-worker",
          p_capacity: WAVE_CAPACITY,
          p_limit: 1,
          p_lease_seconds: 60,
          p_max_attempts: 3,
        },
      );
      if (abandonError) throw new Error(abandonError.message);
      assertEquals(abandoned?.length, 1);
      const abandonedQueueId = String(abandoned?.[0]?.queue_id ?? "");
      const { error: expireError } = await service
        .from("scout_dispatch_queue")
        .update({
          lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
        })
        .eq("id", abandonedQueueId);
      if (expireError) throw new Error(expireError.message);

      const recoveryStart = metrics.attemptedRunIds.length;
      const recovered = await invokeDrain(handler, serviceRoleKey);
      assertEquals(recovered.status, 202);
      await Promise.all(pendingWork.splice(0));
      assertEquals(metrics.attemptedRunIds.length - recoveryStart, 1);
      rows = rowsForBurst(await queueRows(service, userId), recovery);
      assertStatusCounts(rows, { waiting: 1 });
      assertEquals(rows[0].attempts, 2);
      await finishWaitingRuns(service, rows);

      const finalRows = await queueRows(service, userId);
      assertEquals(finalRows.length, BURST_SIZE + 60 + 1);
      assertStatusCounts(finalRows, { done: 385, failed: 2 });
      assertEquals(
        finalRows.some((row) =>
          ["queued", "leased", "waiting"].includes(row.status)
        ),
        false,
      );
      assertEquals(metrics.active, 0);
      assertEquals(metrics.attemptedRunIds.length, BURST_SIZE + 60 + 1);
      assertEquals(metrics.receivedRunIds.length, BURST_SIZE + 60);
    } finally {
      await Promise.allSettled(pendingWork.splice(0));
      if (userId) {
        await cleanupFixtureUser(service, apiUrl, serviceRoleKey, userId);
      }
      await fakeWorker.close();
      restoreEnv(previousEnv);
    }
  },
});

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  throw new Error(`Missing local test env: ${names.join(" or ")}`);
}

function assertLoopbackTarget(url: string): void {
  const hostname = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error(
      `Scout dispatch integration refuses non-local Supabase target: ${url}`,
    );
  }
}

function setDispatcherEnv(
  apiUrl: string,
  serviceRoleKey: string,
): Map<string, string | undefined> {
  const values: Record<string, string> = {
    SUPABASE_URL: apiUrl,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    SCOUT_DISPATCH_CONCURRENCY: String(WAVE_CAPACITY),
    SCOUT_DISPATCH_MAX_LAUNCHES_PER_DRAIN: String(DRAIN_CEILING),
    SCOUT_DISPATCH_LEASE_SECONDS: "60",
    SCOUT_DISPATCH_MAX_ATTEMPTS: "3",
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }
  return previous;
}

function restoreEnv(previous: Map<string, string | undefined>): void {
  for (const [name, value] of previous) {
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
}

async function createFixtureUser(
  apiUrl: string,
  serviceRoleKey: string,
): Promise<string> {
  const response = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: `dispatch-runtime-${crypto.randomUUID()}@example.test`,
      password: `Dispatch-${crypto.randomUUID()}!`,
      email_confirm: true,
    }),
  });
  const body = await response.json().catch(() => ({})) as { id?: string };
  if (!response.ok || !body.id) {
    throw new Error(`fixture user creation failed: HTTP ${response.status}`);
  }
  return body.id;
}

async function cleanupFixtureUser(
  service: SupabaseClient,
  apiUrl: string,
  serviceRoleKey: string,
  userId: string,
): Promise<void> {
  await service.from("scouts").delete().eq("user_id", userId);
  const response = await fetch(`${apiUrl}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  });
  await response.body?.cancel();
}

async function seedBurst(
  service: SupabaseClient,
  userId: string,
  count: number,
  label: string,
): Promise<BurstFixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const scoutIds = Array.from({ length: count }, () => crypto.randomUUID());
  const runIds = Array.from({ length: count }, () => crypto.randomUUID());
  const queueIds = Array.from({ length: count }, () => crypto.randomUUID());
  const scoutTypes = ["web", "beat", "civic"];
  const scheduledBase = Date.now() - 5_000;

  await insertInChunks(
    service,
    "scouts",
    scoutIds.map((id, index) => ({
      id,
      user_id: userId,
      name: `dispatch-${label}-${suffix}-${index}`,
      type: scoutTypes[index % scoutTypes.length],
      is_active: true,
      schedule_cron: "0 8 * * *",
    })),
  );
  await insertInChunks(
    service,
    "scout_runs",
    runIds.map((id, index) => ({
      id,
      scout_id: scoutIds[index],
      user_id: userId,
      status: "running",
      stage: "queued",
      crawler_backend: "workflow",
      started_at: new Date().toISOString(),
      metadata: { integration_fixture: label },
    })),
  );
  await insertInChunks(
    service,
    "scout_dispatch_queue",
    queueIds.map((id, index) => ({
      id,
      scout_run_id: runIds[index],
      scout_id: scoutIds[index],
      user_id: userId,
      scout_type: scoutTypes[index % scoutTypes.length],
      source: "scheduled",
      status: "queued",
      scheduled_for: new Date(scheduledBase + index).toISOString(),
    })),
  );
  return { runIds };
}

async function insertInChunks(
  service: SupabaseClient,
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += 100) {
    const { error } = await service.from(table).insert(
      rows.slice(index, index + 100),
    );
    if (error) {
      throw new Error(`${table} fixture insert failed: ${error.message}`);
    }
  }
}

async function queueRows(
  service: SupabaseClient,
  userId: string,
): Promise<QueueRow[]> {
  const { data, error } = await service
    .from("scout_dispatch_queue")
    .select(
      "scout_run_id,status,attempts,last_error_code,lease_owner,lease_expires_at",
    )
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data ?? []) as QueueRow[];
}

function rowsForBurst(rows: QueueRow[], burst: BurstFixture): QueueRow[] {
  const ids = new Set(burst.runIds);
  return rows.filter((row) => ids.has(row.scout_run_id));
}

function assertStatusCounts(
  rows: QueueRow[],
  expected: Record<string, number>,
): void {
  const actual: Record<string, number> = {};
  for (const row of rows) actual[row.status] = (actual[row.status] ?? 0) + 1;
  assertEquals(actual, expected);
}

async function finishWaitingRuns(
  service: SupabaseClient,
  rows: QueueRow[],
): Promise<void> {
  const waitingRunIds = rows
    .filter((row) => row.status === "waiting")
    .map((row) => row.scout_run_id);
  const completedAt = new Date().toISOString();
  for (let index = 0; index < waitingRunIds.length; index += 100) {
    const { error } = await service
      .from("scout_runs")
      .update({
        status: "success",
        stage: "finalize",
        completed_at: completedAt,
      })
      .in("id", waitingRunIds.slice(index, index + 100));
    if (error) throw new Error(error.message);
  }
  const { error } = await service.rpc("reconcile_waiting_scout_dispatches");
  if (error) throw new Error(error.message);
}

async function invokeDrain(
  handler: (request: Request) => Promise<Response>,
  serviceRoleKey: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(
      "http://127.0.0.1/functions/v1/scout-dispatch-drain",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceRoleKey}` },
      },
    ),
  );
  const body = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  return { status: response.status, body };
}

async function startFakeWorker(
  metrics: WorkerMetrics,
  behavior: WorkerBehavior,
): Promise<{ fetch: typeof fetch; close: () => Promise<void> }> {
  let resolvePort: (port: number) => void = () => undefined;
  const portReady = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    if (
      !request.headers.has("x-service-key") &&
      !request.headers.get("authorization")?.startsWith("Bearer ")
    ) {
      return new Response("missing service authentication", { status: 401 });
    }
    if (
      ![
        "/functions/v1/scout-web-execute",
        "/functions/v1/scout-beat-execute",
        "/functions/v1/civic-execute",
      ].includes(new URL(request.url).pathname)
    ) {
      return new Response("unexpected worker path", { status: 404 });
    }

    const payload = await request.json().catch(() => ({})) as {
      run_id?: string;
    };
    const runId = payload.run_id ?? "";
    if (!runId) return new Response("missing run id", { status: 400 });
    metrics.receivedRunIds.push(runId);
    metrics.active += 1;
    metrics.peakActive = Math.max(metrics.peakActive, metrics.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (behavior.httpFailureRunIds.has(runId)) {
        return new Response("injected worker overload", { status: 503 });
      }
      return new Response(null, { status: 202 });
    } finally {
      metrics.active -= 1;
    }
  });
  const port = await portReady;
  const baseUrl = `http://127.0.0.1:${port}`;

  const fakeFetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const originalUrl = new URL(
      input instanceof Request ? input.url : String(input),
    );
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const payload = JSON.parse(rawBody) as { run_id?: string };
    const runId = payload.run_id ?? "";
    metrics.attemptedRunIds.push(runId);
    if (behavior.networkFailureRunIds.has(runId)) {
      throw new TypeError("injected worker connection reset");
    }
    return globalThis.fetch(`${baseUrl}${originalUrl.pathname}`, init);
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    close: () => server.shutdown(),
  };
}
