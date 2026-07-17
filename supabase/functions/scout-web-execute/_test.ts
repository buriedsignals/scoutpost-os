/**
 * Tests for scout-web-execute worker.
 *
 * Auth is service-role-only; a user JWT must be rejected. The happy-path test
 * requires SCOUT_LIVE_PROVIDER_TESTS=1 plus live Firecrawl + OpenRouter keys and
 * is skipped otherwise.
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

function authHeaders(bearer: string): HeadersInit {
  return {
    "Authorization": `Bearer ${bearer}`,
    "Content-Type": "application/json",
  };
}

function internalHeaders(): HeadersInit {
  const k = Deno.env.get("INTERNAL_SERVICE_KEY");
  if (!k) throw new Error("INTERNAL_SERVICE_KEY required for this test");
  return {
    "X-Service-Key": k,
    "Content-Type": "application/json",
  };
}

Deno.test("scout-web-execute: non-service auth returns 401", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("scout-web-execute"), {
      method: "POST",
      headers: authHeaders(user.token),
      body: JSON.stringify({ scout_id: crypto.randomUUID() }),
    });
    await res.body?.cancel();
    assertEquals(res.status, 401);
  } finally {
    await user.cleanup();
  }
});

Deno.test("scout-web-execute: X-Service-Key reaches scout lookup", async () => {
  if (!Deno.env.get("INTERNAL_SERVICE_KEY")) {
    console.warn("skipping: INTERNAL_SERVICE_KEY not set");
    return;
  }
  const res = await fetch(functionUrl("scout-web-execute"), {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ scout_id: crypto.randomUUID() }),
  });
  const body = await res.json();
  assertEquals(res.status, 404);
  assertEquals(body.code, "not_found");
});

const liveProviderTests = Deno.env.get("SCOUT_LIVE_PROVIDER_TESTS") === "1";
const hasLiveKeys = liveProviderTests &&
  !!Deno.env.get("FIRECRAWL_API_KEY") &&
  !!Deno.env.get("OPENROUTER_API_KEY");

Deno.test(
  {
    name:
      "scout-web-execute: happy path (live Firecrawl + OpenRouter keys required)",
    ignore: !hasLiveKeys,
  },
  async () => {
    const user = await createTestUser();
    let scoutId: string | null = null;
    try {
      const { data: scout, error } = await svc()
        .from("scouts")
        .insert({
          user_id: user.id,
          name: `web-test-${crypto.randomUUID()}`,
          type: "web",
          url: "https://example.com",
          schedule_cron: "0 6 * * *",
          baseline_established_at: new Date().toISOString(),
          is_active: true,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      scoutId = scout.id as string;

      const res = await fetch(functionUrl("scout-web-execute"), {
        method: "POST",
        headers: authHeaders(serviceKey()),
        body: JSON.stringify({ scout_id: scoutId }),
      });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(body.status, "ok");
      assert(
        ["same", "changed", "new", "removed"].includes(body.change),
        `unexpected change value: ${body.change}`,
      );
    } finally {
      if (scoutId) await svc().from("scouts").delete().eq("id", scoutId);
      await user.cleanup();
    }
  },
);
