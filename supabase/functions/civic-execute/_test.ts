/**
 * Tests for civic-execute Edge Function.
 *
 * Requires local supabase stack running. The happy-path test calls live
 * Firecrawl and is gated on SCOUT_LIVE_PROVIDER_TESTS=1 +
 * FIRECRAWL_API_KEY + service auth.
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestUser,
  functionUrl,
  getTestingServiceRoleKey,
  SUPABASE_URL,
} from "../_shared/_testing.ts";

const SERVICE_ROLE_KEY = getTestingServiceRoleKey();
const liveKeys = Deno.env.get("SCOUT_LIVE_PROVIDER_TESTS") === "1" &&
  Boolean(Deno.env.get("FIRECRAWL_API_KEY"));

const SERVICE_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
};

function adminDb() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.test("civic-execute: unauthenticated returns 401", async () => {
  const res = await fetch(functionUrl("civic-execute"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scout_id: "00000000-0000-0000-0000-000000000000",
    }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("civic-execute: 400 when tracked_urls is empty", async () => {
  const user = await createTestUser();
  const db = adminDb();
  try {
    const { data: scout, error } = await db
      .from("scouts")
      .insert({
        user_id: user.id,
        name: "Civic Test (empty)",
        type: "civic",
        root_domain: "example.gov",
        regularity: "weekly",
        schedule_cron: "0 6 * * 1",
        tracked_urls: [],
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const res = await fetch(functionUrl("civic-execute"), {
      method: "POST",
      headers: SERVICE_HEADERS,
      body: JSON.stringify({ scout_id: scout.id }),
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "scout has no tracked_urls");

    await db.from("scouts").delete().eq("id", scout.id);
  } finally {
    await user.cleanup();
  }
});

Deno.test("civic-execute: 404 when scout missing", async () => {
  const res = await fetch(functionUrl("civic-execute"), {
    method: "POST",
    headers: SERVICE_HEADERS,
    body: JSON.stringify({
      scout_id: "00000000-0000-0000-0000-000000000000",
    }),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test({
  name: "civic-execute: happy path returns queued count (live firecrawl)",
  ignore: !liveKeys,
  fn: async () => {
    const user = await createTestUser();
    const db = adminDb();
    try {
      const { data: scout, error } = await db
        .from("scouts")
        .insert({
          user_id: user.id,
          name: "Civic Test (live)",
          type: "civic",
          root_domain: "example.com",
          regularity: "weekly",
          schedule_cron: "0 6 * * 1",
          tracked_urls: ["https://example.com"],
          processed_pdf_urls: [],
          baseline_established_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);

      const res = await fetch(functionUrl("civic-execute"), {
        method: "POST",
        headers: SERVICE_HEADERS,
        body: JSON.stringify({ scout_id: scout.id }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.status, "ok");
      assertExists(body.run_id);
      assertEquals(typeof body.queued, "number");
      assertEquals(body.tracked_urls_checked, 1);

      await db.from("scouts").delete().eq("id", scout.id);
    } finally {
      await user.cleanup();
    }
  },
});
