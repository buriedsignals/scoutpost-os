import {
  assertEquals,
  assertExists,
  assertMatch,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestUser,
  functionUrl,
  getTestingServiceRoleKey,
  SUPABASE_URL,
} from "../_shared/_testing.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function headers(token: string): HeadersInit {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function serviceKey(): string {
  return getTestingServiceRoleKey();
}

function svc() {
  return createClient(SUPABASE_URL, serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.test("scouts: unauthenticated request returns 401", async () => {
  const res = await fetch(functionUrl("scouts"), { method: "GET" });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("scouts: create + get + list + patch + delete round-trip", async () => {
  const user = await createTestUser();
  try {
    // Create
    const createRes = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Test Scout",
        type: "web",
        url: "https://example.com",
        topic: "council, agenda",
        description: "Watch the council agenda page.",
      }),
    });
    assertEquals(createRes.status, 201);
    const created = await createRes.json();
    assertExists(created.id);
    assertMatch(created.id, UUID_RE);
    assertEquals(created.name, "Test Scout");
    assertEquals(created.type, "web");
    assertEquals(created.topic, "council, agenda");
    assertEquals(created.description, "Watch the council agenda page.");
    assertEquals(created.url, "https://example.com");
    assertEquals(created.is_active, false); // no schedule_cron -> inactive
    assertEquals(created.last_run, null);

    // Get
    const getRes = await fetch(
      functionUrl("scouts", `/${created.id}`),
      { headers: headers(user.token) },
    );
    assertEquals(getRes.status, 200);
    const fetched = await getRes.json();
    assertEquals(fetched.id, created.id);
    assertEquals(fetched.name, "Test Scout");

    // List
    const listRes = await fetch(functionUrl("scouts"), {
      headers: headers(user.token),
    });
    assertEquals(listRes.status, 200);
    const listed = await listRes.json();
    assertEquals(listed.pagination.total, 1);
    assertEquals(listed.items.length, 1);
    assertEquals(listed.items[0].id, created.id);

    // Patch
    const patchRes = await fetch(
      functionUrl("scouts", `/${created.id}`),
      {
        method: "PATCH",
        headers: headers(user.token),
        body: JSON.stringify({ criteria: "housing evictions" }),
      },
    );
    assertEquals(patchRes.status, 200);
    const patched = await patchRes.json();
    assertEquals(patched.criteria, "housing evictions");

    // Delete
    const delRes = await fetch(
      functionUrl("scouts", `/${created.id}`),
      {
        method: "DELETE",
        headers: headers(user.token),
      },
    );
    await delRes.body?.cancel();
    assertEquals(delRes.status, 204);

    // Confirm gone
    const gone = await fetch(
      functionUrl("scouts", `/${created.id}`),
      { headers: headers(user.token) },
    );
    await gone.body?.cancel();
    assertEquals(gone.status, 404);
  } finally {
    await user.cleanup();
  }
});

Deno.test("scouts: POST /:id/run returns 202 with run_id UUID", async () => {
  const user = await createTestUser();
  try {
    const createRes = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Runnable Scout",
        type: "web",
        url: "https://example.com",
        topic: "run test",
      }),
    });
    assertEquals(createRes.status, 201);
    const created = await createRes.json();

    const { error: activateErr } = await svc()
      .from("scouts")
      .update({
        is_active: true,
        schedule_cron: "0 6 * * 1",
        baseline_established_at: new Date().toISOString(),
      })
      .eq("id", created.id);
    if (activateErr) throw new Error(activateErr.message);

    const runRes = await fetch(
      functionUrl("scouts", `/${created.id}/run`),
      {
        method: "POST",
        headers: headers(user.token),
      },
    );
    assertEquals(runRes.status, 202);
    const runBody = await runRes.json();
    assertEquals(runBody.scout_id, created.id);
    assertExists(runBody.run_id);
    assertMatch(runBody.run_id, UUID_RE);

    // Cleanup
    await fetch(functionUrl("scouts", `/${created.id}`), {
      method: "DELETE",
      headers: headers(user.token),
    }).then((r) => r.body?.cancel());
  } finally {
    await user.cleanup();
  }
});

Deno.test("scouts: POST /:id/run rejects paused scout before creating run", async () => {
  const user = await createTestUser();
  try {
    const createRes = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Paused Runnable Scout",
        type: "web",
        url: "https://example.com",
        topic: "run test",
      }),
    });
    assertEquals(createRes.status, 201);
    const created = await createRes.json();
    assertEquals(created.is_active, false);

    const runRes = await fetch(
      functionUrl("scouts", `/${created.id}/run`),
      {
        method: "POST",
        headers: headers(user.token),
      },
    );
    assertEquals(runRes.status, 409);
    const runBody = await runRes.json();
    assertEquals(runBody.code, "conflict");
    assertEquals(runBody.error, "scout is paused");

    const { count, error: countErr } = await svc()
      .from("scout_runs")
      .select("id", { count: "exact", head: true })
      .eq("scout_id", created.id);
    if (countErr) throw new Error(countErr.message);
    assertEquals(count, 0);

    await fetch(functionUrl("scouts", `/${created.id}`), {
      method: "DELETE",
      headers: headers(user.token),
    }).then((r) => r.body?.cancel());
  } finally {
    await user.cleanup();
  }
});

Deno.test("scouts: beat fields round-trip and legacy pulse alias maps to beat", async () => {
  const user = await createTestUser();
  try {
    const createRes = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Beat Round Trip",
        scout_type: "pulse",
        criteria: "housing policy",
        location: {
          displayName: "London, United Kingdom",
          city: "London",
          country: "GB",
          locationType: "city",
        },
        source_mode: "reliable",
        excluded_domains: ["example.com"],
      }),
    });
    assertEquals(createRes.status, 201);
    const created = await createRes.json();
    assertEquals(created.type, "beat");
    assertEquals(created.source_mode, "reliable");
    assertEquals(created.excluded_domains, ["example.com"]);
    assertEquals(created.location.displayName, "London, United Kingdom");

    const patchRes = await fetch(
      functionUrl("scouts", `/${created.id}`),
      {
        method: "PATCH",
        headers: headers(user.token),
        body: JSON.stringify({
          source_mode: "niche",
          excluded_domains: ["example.org"],
        }),
      },
    );
    assertEquals(patchRes.status, 200);
    const patched = await patchRes.json();
    assertEquals(patched.source_mode, "niche");
    assertEquals(patched.excluded_domains, ["example.org"]);

    await fetch(functionUrl("scouts", `/${created.id}`), {
      method: "DELETE",
      headers: headers(user.token),
    }).then((r) => r.body?.cancel());
  } finally {
    await user.cleanup();
  }
});

Deno.test("scouts: beat scouts reject daily schedules", async () => {
  const user = await createTestUser();
  try {
    const createRes = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Daily Beat",
        scout_type: "pulse",
        criteria: "housing policy",
        topic: "housing",
        regularity: "daily",
        time: "08:00",
      }),
    });
    assertEquals(createRes.status, 400);
    const body = await createRes.json();
    assertMatch(body.error, /weekly or monthly/i);
  } finally {
    await user.cleanup();
  }
});

Deno.test("scouts: social fields persist and seed post snapshot baseline", async () => {
  const user = await createTestUser();
  try {
    const createRes = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Social Round Trip",
        scout_type: "social",
        regularity: "weekly",
        day_number: 2,
        time: "09:30",
        platform: "instagram",
        profile_handle: "@buriedsignals",
        monitor_mode: "criteria",
        track_removals: true,
        criteria: "housing and displacement",
        topic: "housing, social",
        baseline_posts: [
          {
            id: "post-1",
            url: "https://www.instagram.com/p/post-1/",
            text: "Sample post",
          },
        ],
      }),
    });
    assertEquals(createRes.status, 201);
    const created = await createRes.json();
    assertEquals(created.type, "social");
    assertEquals(created.platform, "instagram");
    assertEquals(created.profile_handle, "buriedsignals");
    assertEquals(created.monitor_mode, "criteria");
    assertEquals(created.track_removals, true);
    assertMatch(created.schedule_cron, /^\d+ \d+ \* \* \d$/);

    const { data: snapshot, error } = await svc()
      .from("post_snapshots")
      .select("handle, post_count, posts")
      .eq("scout_id", created.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    assertExists(snapshot);
    assertEquals(snapshot.handle, "buriedsignals");
    assertEquals(snapshot.post_count, 1);
    assertEquals(Array.isArray(snapshot.posts), true);
  } finally {
    await user.cleanup();
  }
});

Deno.test("scouts: civic fields persist and seed initial promises", async () => {
  const user = await createTestUser();
  try {
    const createRes = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Civic Round Trip",
        scout_type: "civic",
        root_domain: "https://city.example.gov/",
        tracked_urls: ["https://city.example.gov/council/agendas"],
        criteria: "housing",
        topic: "housing, council",
        initial_promises: [
          {
            promise_text: "Build 100 affordable homes",
            context: "Budget hearing",
            source_url: "https://city.example.gov/council/agendas/1",
            source_date: "2026-04-01",
            due_date: "2026-09-01",
            date_confidence: "high",
            criteria_match: true,
          },
        ],
      }),
    });
    assertEquals(createRes.status, 201);
    const created = await createRes.json();
    assertEquals(created.type, "civic");
    assertEquals(created.root_domain, "city.example.gov");
    assertEquals(created.tracked_urls, [
      "https://city.example.gov/council/agendas",
    ]);

    const { data: promises, error } = await svc()
      .from("promises")
      .select("promise_text, due_date, date_confidence")
      .eq("scout_id", created.id);
    if (error) throw new Error(error.message);
    assertEquals(promises?.length ?? 0, 1);
    assertEquals(promises?.[0]?.promise_text, "Build 100 affordable homes");
    assertEquals(promises?.[0]?.due_date, "2026-09-01");
    assertEquals(promises?.[0]?.date_confidence, "high");
  } finally {
    await user.cleanup();
  }
});

const runDispatchConfigured = Deno.env.get("COJO_SCOUT_RUN_E2E") === "1";
const scoutRunE2eTest = runDispatchConfigured ? Deno.test : Deno.test.ignore;

scoutRunE2eTest(
  "scouts: POST /:id/run eventually leaves queued/running when local dispatch is configured",
  async () => {
    const user = await createTestUser();
    try {
      const createRes = await fetch(functionUrl("scouts"), {
        method: "POST",
        headers: headers(user.token),
        body: JSON.stringify({
          name: "Runnable Scout E2E",
          type: "web",
          url: "https://example.com",
          topic: "run test",
        }),
      });
      assertEquals(createRes.status, 201);
      const created = await createRes.json();

      const runRes = await fetch(
        functionUrl("scouts", `/${created.id}/run`),
        {
          method: "POST",
          headers: headers(user.token),
        },
      );
      assertEquals(runRes.status, 202);

      let terminalStatus: string | null = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const getRes = await fetch(
          functionUrl("scouts", `/${created.id}`),
          { headers: headers(user.token) },
        );
        assertEquals(getRes.status, 200);
        const body = await getRes.json();
        const status = body?.last_run?.status ?? null;
        if (status && status !== "queued" && status !== "running") {
          terminalStatus = status;
          break;
        }
      }

      assertExists(terminalStatus);

      await fetch(functionUrl("scouts", `/${created.id}`), {
        method: "DELETE",
        headers: headers(user.token),
      }).then((r) => r.body?.cancel());
    } finally {
      await user.cleanup();
    }
  },
);

Deno.test("scouts: 404 on unknown scout id", async () => {
  const user = await createTestUser();
  try {
    const missing = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(functionUrl("scouts", `/${missing}`), {
      headers: headers(user.token),
    });
    await res.body?.cancel();
    assertEquals(res.status, 404);
  } finally {
    await user.cleanup();
  }
});

Deno.test("scouts: 400 on invalid scout type", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Bad Type Scout",
        type: "not-a-real-type",
        url: "https://example.com",
      }),
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

Deno.test("scouts: create requires topic tags or location", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Unscoped Scout",
        type: "web",
        url: "https://example.com",
      }),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertMatch(body.error, /topic/i);
  } finally {
    await user.cleanup();
  }
});

Deno.test("scouts: topic tags are short and limited", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("scouts"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        name: "Too Many Tags",
        type: "web",
        url: "https://example.com",
        topic: "one, two, three, four",
      }),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertMatch(body.error, /at most 3/i);
  } finally {
    await user.cleanup();
  }
});
