/**
 * Tests for civic-extract-worker.
 *
 * Runs against the configured Supabase project in SUPABASE_URL.
 * The happy-path test is gated on SCOUT_LIVE_PROVIDER_TESTS=1 plus live keys
 * (Firecrawl + OpenRouter); without them only auth and idle-queue paths run.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestUser,
  functionUrl,
  SUPABASE_URL,
} from "../_shared/_testing.ts";

function serviceKey(): string {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!k) throw new Error("SUPABASE_SERVICE_ROLE_KEY required for tests");
  return k;
}

function svc() {
  return createClient(SUPABASE_URL, serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function serviceHeaders(): HeadersInit {
  return {
    "Authorization": `Bearer ${serviceKey()}`,
    "Content-Type": "application/json",
  };
}

async function insertCivicScout(userId: string): Promise<string> {
  const { data, error } = await svc()
    .from("scouts")
    .insert({
      user_id: userId,
      name: `civic-${crypto.randomUUID()}`,
      type: "civic",
      root_domain: "example.gov",
      schedule_cron: "0 6 * * *",
      is_active: true,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

Deno.test("civic-extract-worker: unauthenticated request returns 401", async () => {
  const res = await fetch(functionUrl("civic-extract-worker"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test(
  "civic-extract-worker: empty queue returns idle",
  async () => {
    // The queue may already contain work in the target project; assert only
    // that the worker responds 200 with an expected terminal state.
    const res = await fetch(functionUrl("civic-extract-worker"), {
      method: "POST",
      headers: serviceHeaders(),
      body: "{}",
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(
      body.status === "idle" || body.status === "processed",
      `unexpected body: ${JSON.stringify(body)}`,
    );
  },
);

const liveProviderTests = Deno.env.get("SCOUT_LIVE_PROVIDER_TESTS") === "1";
const hasLiveKeys = liveProviderTests &&
  !!Deno.env.get("OPENROUTER_API_KEY") &&
  !!Deno.env.get("FIRECRAWL_API_KEY");

Deno.test(
  {
    name:
      "civic-extract-worker: happy path claims + processes queue row (live keys required)",
    ignore: !hasLiveKeys,
  },
  async () => {
    const user = await createTestUser();
    let scoutId: string | null = null;
    try {
      scoutId = await insertCivicScout(user.id);

      // Insert a pending queue row.
      const { data: queued, error: qErr } = await svc()
        .from("civic_extraction_queue")
        .insert({
          user_id: user.id,
          scout_id: scoutId,
          source_url: "https://example.com/",
          doc_kind: "html",
          status: "pending",
        })
        .select("id")
        .single();
      if (qErr) throw new Error(qErr.message);
      const queueId = queued.id as string;

      const res = await fetch(functionUrl("civic-extract-worker"), {
        method: "POST",
        headers: serviceHeaders(),
        body: "{}",
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.status, "processed");
      assertEquals(body.queue_id, queueId);
      assert(typeof body.promises_extracted === "number");
    } finally {
      if (scoutId) await svc().from("scouts").delete().eq("id", scoutId);
      await user.cleanup();
    }
  },
);
