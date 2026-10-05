/**
 * Tests for social-kickoff.
 *
 * Runs against local supabase (127.0.0.1:54321). The live happy-path test
 * is gated on SCOUT_LIVE_PROVIDER_TESTS=1 + APIFY_API_TOKEN since it makes a
 * real Apify run.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestUser,
  functionUrl,
  getTestingServiceRoleKey,
  SUPABASE_URL,
} from "../_shared/_testing.ts";

function svc() {
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

const liveProviderTests = Deno.env.get("SCOUT_LIVE_PROVIDER_TESTS") === "1";

async function insertScout(
  userId: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await svc()
    .from("scouts")
    .insert({
      user_id: userId,
      name: `social-${crypto.randomUUID()}`,
      type: "social",
      schedule_cron: "0 6 * * *",
      is_active: true,
      ...fields,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

Deno.test("social-kickoff: unauthenticated request returns 401", async () => {
  const res = await fetch(functionUrl("social-kickoff"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scout_id: crypto.randomUUID() }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test(
  "social-kickoff: scout without platform returns 400",
  async () => {
    const user = await createTestUser();
    let scoutId: string | null = null;
    try {
      // No platform, no profile_handle — expect ValidationError (400).
      scoutId = await insertScout(user.id, {});
      const res = await fetch(functionUrl("social-kickoff"), {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify({ scout_id: scoutId }),
      });
      const body = await res.json();
      assertEquals(res.status, 400);
      assert(
        typeof body.error === "string" &&
          body.error.toLowerCase().includes("platform"),
        `unexpected error: ${JSON.stringify(body)}`,
      );
    } finally {
      if (scoutId) await svc().from("scouts").delete().eq("id", scoutId);
      await user.cleanup();
    }
  },
);

Deno.test(
  {
    name:
      "social-kickoff: happy path starts apify run (live APIFY_API_TOKEN required)",
    ignore: !liveProviderTests || !Deno.env.get("APIFY_API_TOKEN"),
  },
  async () => {
    const user = await createTestUser();
    let scoutId: string | null = null;
    try {
      scoutId = await insertScout(user.id, {
        platform: "x",
        profile_handle: "apify",
        baseline_established_at: new Date().toISOString(),
      });
      const { error: snapshotErr } = await svc()
        .from("post_snapshots")
        .insert({
          user_id: user.id,
          scout_id: scoutId,
          platform: "x",
          handle: "apify",
          post_count: 0,
          posts: [],
        });
      if (snapshotErr) throw new Error(snapshotErr.message);
      const res = await fetch(functionUrl("social-kickoff"), {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify({ scout_id: scoutId }),
      });
      const body = await res.json();
      assertEquals(res.status, 202, JSON.stringify(body));
      assertEquals(body.status, "started");
      assert(typeof body.queue_id === "string" && body.queue_id.length > 0);
      assert(
        typeof body.apify_run_id === "string" && body.apify_run_id.length > 0,
      );
    } finally {
      if (scoutId) {
        // Queue rows cascade via scout_id FK.
        await svc().from("scouts").delete().eq("id", scoutId);
      }
      await user.cleanup();
    }
  },
);
