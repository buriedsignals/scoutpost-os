/**
 * Tests for execute-scout dispatcher.
 *
 * These tests run against a local supabase (127.0.0.1:54321). Sibling worker
 * functions may not be deployed during parallel development — tests that
 * exercise dispatch tolerate either 202 (worker ran) or 502 (worker missing).
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

function serviceHeaders(): HeadersInit {
  const internal = Deno.env.get("INTERNAL_SERVICE_KEY");
  if (internal) {
    return {
      "X-Service-Key": internal,
      "Content-Type": "application/json",
    };
  }
  return authHeaders(serviceKey());
}

function internalHeaders(): HeadersInit {
  const k = Deno.env.get("INTERNAL_SERVICE_KEY");
  if (!k) throw new Error("INTERNAL_SERVICE_KEY required for this test");
  return {
    "X-Service-Key": k,
    "Content-Type": "application/json",
  };
}

async function insertScout(
  userId: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await svc()
    .from("scouts")
    .insert({
      user_id: userId,
      name: `test-scout-${crypto.randomUUID()}`,
      type: "web",
      url: "https://example.com",
      schedule_cron: "0 6 * * *",
      is_active: true,
      ...fields,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

Deno.test("execute-scout: unauthenticated request returns 401", async () => {
  const res = await fetch(functionUrl("execute-scout"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scout_id: crypto.randomUUID() }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("execute-scout: unknown scout_id returns 404", async () => {
  const res = await fetch(functionUrl("execute-scout"), {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify({ scout_id: crypto.randomUUID() }),
  });
  const body = await res.json();
  assertEquals(res.status, 404);
  assertEquals(body.code, "not_found");
});

Deno.test("execute-scout: X-Service-Key reaches scout lookup", async () => {
  if (!Deno.env.get("INTERNAL_SERVICE_KEY")) {
    console.warn("skipping: INTERNAL_SERVICE_KEY not set");
    return;
  }
  const res = await fetch(functionUrl("execute-scout"), {
    method: "POST",
    headers: internalHeaders(),
    body: JSON.stringify({ scout_id: crypto.randomUUID() }),
  });
  const body = await res.json();
  assertEquals(res.status, 404);
  assertEquals(body.code, "not_found");
});

Deno.test("execute-scout: paused scout returns 409", async () => {
  const user = await createTestUser();
  let scoutId: string | null = null;
  try {
    scoutId = await insertScout(user.id, {
      is_active: false,
      schedule_cron: null,
    });
    const res = await fetch(functionUrl("execute-scout"), {
      method: "POST",
      headers: serviceHeaders(),
      body: JSON.stringify({ scout_id: scoutId }),
    });
    const body = await res.json();
    assertEquals(res.status, 409);
    assertEquals(body.error, "scout is paused");
  } finally {
    if (scoutId) await svc().from("scouts").delete().eq("id", scoutId);
    await user.cleanup();
  }
});

Deno.test("execute-scout: user JWT cannot run another user's scout", async () => {
  const owner = await createTestUser();
  const other = await createTestUser();
  let scoutId: string | null = null;
  try {
    scoutId = await insertScout(owner.id, {});
    const res = await fetch(functionUrl("execute-scout"), {
      method: "POST",
      headers: authHeaders(other.token),
      body: JSON.stringify({ scout_id: scoutId }),
    });
    const body = await res.json();
    assertEquals(res.status, 404);
    assertEquals(body.code, "not_found");
  } finally {
    if (scoutId) await svc().from("scouts").delete().eq("id", scoutId);
    await owner.cleanup();
    await other.cleanup();
  }
});

Deno.test(
  "execute-scout: active scout dispatches (202 if worker ran, 502 if worker missing)",
  async () => {
    const user = await createTestUser();
    let scoutId: string | null = null;
    try {
      scoutId = await insertScout(user.id, {});
      const res = await fetch(functionUrl("execute-scout"), {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify({ scout_id: scoutId }),
      });
      const body = await res.json().catch(() => ({}));
      // 202 => worker answered OK. 502 => worker is missing or errored — both
      // prove that the dispatch logic reached the forward step.
      assert(
        res.status === 202 || res.status === 502,
        `expected 202 or 502, got ${res.status}: ${JSON.stringify(body)}`,
      );
      if (res.status === 202) {
        assertEquals(body.dispatched, "web");
        assertEquals(body.scout_id, scoutId);
      }
    } finally {
      if (scoutId) await svc().from("scouts").delete().eq("id", scoutId);
      await user.cleanup();
    }
  },
);
