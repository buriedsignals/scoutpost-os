/**
 * Tests for apify-callback Edge Function.
 *
 * Auth is service-role-only; a user JWT must be rejected. The "already
 * processed" and "failed-event" paths exercise idempotency + queue-row status
 * transitions without any external calls.
 */

import {
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestUser,
  functionUrl,
  getTestingServiceRoleKey,
  SUPABASE_URL,
} from "../_shared/_testing.ts";

function adminDb() {
  return createClient(SUPABASE_URL, getTestingServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function serviceHeaders(): HeadersInit {
  return {
    "Authorization": `Bearer ${getTestingServiceRoleKey()}`,
    "Content-Type": "application/json",
  };
}

function userHeaders(token: string): HeadersInit {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function webhookBody(apifyRunId: string, eventType: string, datasetId = "ds-test") {
  return {
    eventType,
    resource: {
      id: apifyRunId,
      actorId: "actor-x",
      status: eventType === "ACTOR.RUN.SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      defaultDatasetId: datasetId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    },
  };
}

Deno.test("apify-callback: unauthenticated request returns 401", async () => {
  const res = await fetch(functionUrl("apify-callback"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(webhookBody("run-unauth", "ACTOR.RUN.SUCCEEDED")),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test(
  "apify-callback: user JWT (not service-role) returns 401",
  async () => {
    const user = await createTestUser();
    try {
      const res = await fetch(functionUrl("apify-callback"), {
        method: "POST",
        headers: userHeaders(user.token),
        body: JSON.stringify(webhookBody("run-user", "ACTOR.RUN.SUCCEEDED")),
      });
      await res.body?.cancel();
      assertEquals(res.status, 401);
    } finally {
      await user.cleanup();
    }
  },
);

Deno.test(
  "apify-callback: unknown apify_run_id returns 404",
  async () => {
    const res = await fetch(functionUrl("apify-callback"), {
      method: "POST",
      headers: serviceHeaders(),
      body: JSON.stringify(
        webhookBody(`run-missing-${crypto.randomUUID()}`, "ACTOR.RUN.SUCCEEDED"),
      ),
    });
    const body = await res.json();
    assertEquals(res.status, 404, JSON.stringify(body));
  },
);

Deno.test(
  "apify-callback: already-terminal queue row returns already_processed",
  async () => {
    const user = await createTestUser();
    const db = adminDb();
    const apifyRunId = `run-done-${crypto.randomUUID()}`;
    let scoutId: string | null = null;
    let queueId: string | null = null;
    try {
      const { data: scout, error: scoutErr } = await db
        .from("scouts")
        .insert({
          user_id: user.id,
          name: `apify-cb-done-${crypto.randomUUID()}`,
          type: "social",
          platform: "instagram",
          profile_handle: "someone",
          schedule_cron: "0 6 * * *",
          is_active: false,
        })
        .select("id")
        .single();
      if (scoutErr) throw new Error(scoutErr.message);
      scoutId = scout.id as string;

      const { data: queue, error: queueErr } = await db
        .from("apify_run_queue")
        .insert({
          user_id: user.id,
          scout_id: scoutId,
          apify_run_id: apifyRunId,
          platform: "instagram",
          handle: "someone",
          status: "succeeded",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (queueErr) throw new Error(queueErr.message);
      queueId = queue.id as string;

      const res = await fetch(functionUrl("apify-callback"), {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify(webhookBody(apifyRunId, "ACTOR.RUN.SUCCEEDED")),
      });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(body.status, "already_processed");
    } finally {
      if (queueId) await db.from("apify_run_queue").delete().eq("id", queueId);
      if (scoutId) await db.from("scouts").delete().eq("id", scoutId);
      await user.cleanup();
    }
  },
);

Deno.test(
  "apify-callback: failed event updates queue row to failed",
  async () => {
    const user = await createTestUser();
    const db = adminDb();
    const apifyRunId = `run-fail-${crypto.randomUUID()}`;
    let scoutId: string | null = null;
    let queueId: string | null = null;
    try {
      const { data: scout, error: scoutErr } = await db
        .from("scouts")
        .insert({
          user_id: user.id,
          name: `apify-cb-fail-${crypto.randomUUID()}`,
          type: "social",
          platform: "instagram",
          profile_handle: "someone",
          schedule_cron: "0 6 * * *",
          is_active: false,
        })
        .select("id")
        .single();
      if (scoutErr) throw new Error(scoutErr.message);
      scoutId = scout.id as string;

      const { data: queue, error: queueErr } = await db
        .from("apify_run_queue")
        .insert({
          user_id: user.id,
          scout_id: scoutId,
          apify_run_id: apifyRunId,
          platform: "instagram",
          handle: "someone",
          status: "running",
          started_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (queueErr) throw new Error(queueErr.message);
      queueId = queue.id as string;

      const res = await fetch(functionUrl("apify-callback"), {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify(webhookBody(apifyRunId, "ACTOR.RUN.FAILED")),
      });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(body.status, "failed_recorded");

      // Verify queue row is now 'failed'.
      const { data: after, error: afterErr } = await db
        .from("apify_run_queue")
        .select("status, last_error, completed_at")
        .eq("id", queueId)
        .single();
      if (afterErr) throw new Error(afterErr.message);
      assertEquals(after.status, "failed");
      assertEquals(after.last_error, "ACTOR.RUN.FAILED");
    } finally {
      if (queueId) await db.from("apify_run_queue").delete().eq("id", queueId);
      if (scoutId) await db.from("scouts").delete().eq("id", scoutId);
      await user.cleanup();
    }
  },
);
