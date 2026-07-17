/**
 * Tests for scout-beat-execute Edge Function.
 *
 * Runs against the configured Supabase project in SUPABASE_URL.
 * Live-API tests are gated on SCOUT_LIVE_PROVIDER_TESTS=1 +
 * FIRECRAWL_API_KEY + OPENROUTER_API_KEY + service auth.
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestUser,
  functionUrl,
  SUPABASE_URL,
} from "../_shared/_testing.ts";

const SERVICE_KEY = Deno.env.get("INTERNAL_SERVICE_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const LIVE_PROVIDER_TESTS = Deno.env.get("SCOUT_LIVE_PROVIDER_TESTS") === "1";
const hasServiceAuth = Boolean(SERVICE_ROLE_KEY || SERVICE_KEY);
const liveKeys = Boolean(
  LIVE_PROVIDER_TESTS && hasServiceAuth && FIRECRAWL_KEY && OPENROUTER_KEY,
);

function svcHeaders(): HeadersInit {
  if (SERVICE_ROLE_KEY) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    };
  }
  return {
    "Content-Type": "application/json",
    "X-Service-Key": SERVICE_KEY,
  };
}

function adminDb() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.test("scout-beat-execute: unauthenticated returns 401", async () => {
  const res = await fetch(functionUrl("scout-beat-execute"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scout_id: "00000000-0000-0000-0000-000000000000",
    }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test(
  "scout-beat-execute: 400 when scout has no location, criteria, or topic",
  async () => {
    if (!hasServiceAuth) {
      console.warn("skipping: service auth not set");
      return;
    }
    const user = await createTestUser();
    const db = adminDb();
    try {
      const { data: scout, error } = await db
        .from("scouts")
        .insert({
          user_id: user.id,
          name: "Beat Test (missing inputs)",
          type: "beat",
          regularity: "weekly",
          schedule_cron: "0 6 * * 1",
          baseline_established_at: new Date().toISOString(),
          priority_sources: [],
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);

      const res = await fetch(functionUrl("scout-beat-execute"), {
        method: "POST",
        headers: svcHeaders(),
        body: JSON.stringify({ scout_id: scout.id }),
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.code, "validation_error");
      assertEquals(
        body.error,
        "beat scout requires location, criteria, or topic",
      );

      await db.from("scouts").delete().eq("id", scout.id);
    } finally {
      await user.cleanup();
    }
  },
);

Deno.test("scout-beat-execute: 404 when scout missing", async () => {
  if (!hasServiceAuth) {
    console.warn("skipping: service auth not set");
    return;
  }
  const res = await fetch(functionUrl("scout-beat-execute"), {
    method: "POST",
    headers: svcHeaders(),
    body: JSON.stringify({
      scout_id: "00000000-0000-0000-0000-000000000000",
    }),
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test({
  name:
    "scout-beat-execute: happy path scrapes + extracts (live firecrawl+openrouter)",
  ignore: !liveKeys,
  fn: async () => {
    const user = await createTestUser();
    const db = adminDb();
    try {
      const { data: scout, error } = await db
        .from("scouts")
        .insert({
          user_id: user.id,
          name: "Beat Test (live)",
          type: "beat",
          regularity: "weekly",
          schedule_cron: "0 6 * * 1",
          criteria: "any newsworthy development",
          baseline_established_at: new Date().toISOString(),
          priority_sources: [
            "https://example.com",
            "https://www.iana.org/help/example-domains",
          ],
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);

      const res = await fetch(functionUrl("scout-beat-execute"), {
        method: "POST",
        headers: svcHeaders(),
        body: JSON.stringify({ scout_id: scout.id }),
      });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(body.status, "ok");
      assertExists(body.run_id);
      // sources_scraped could be <2 if one fails; just assert it's a number.
      assertEquals(typeof body.sources_scraped, "number");

      await db.from("scouts").delete().eq("id", scout.id);
    } finally {
      await user.cleanup();
    }
  },
});

Deno.test({
  name:
    "scout-beat-execute: location-only scout runs without criteria validation failure",
  ignore: !liveKeys,
  fn: async () => {
    const user = await createTestUser();
    const db = adminDb();
    try {
      const { data: scout, error } = await db
        .from("scouts")
        .insert({
          user_id: user.id,
          name: "Beat Test (location only)",
          type: "beat",
          regularity: "weekly",
          schedule_cron: "0 6 * * 1",
          baseline_established_at: new Date().toISOString(),
          location: {
            displayName: "London, United Kingdom",
            city: "London",
            country: "GB",
            locationType: "city",
          },
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);

      const res = await fetch(functionUrl("scout-beat-execute"), {
        method: "POST",
        headers: svcHeaders(),
        body: JSON.stringify({ scout_id: scout.id }),
      });
      const body = await res.json();
      assertEquals(res.status, 200, JSON.stringify(body));
      assertEquals(typeof body.status, "string");

      await db.from("scouts").delete().eq("id", scout.id);
    } finally {
      await user.cleanup();
    }
  },
});
