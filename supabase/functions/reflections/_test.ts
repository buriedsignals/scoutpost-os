import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createTestUser, functionUrl } from "../_shared/_testing.ts";

function headers(token: string): HeadersInit {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

Deno.test("reflections: unauthenticated request returns 401", async () => {
  const res = await fetch(functionUrl("reflections"), { method: "GET" });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("reflections: create + list + get + delete round-trip", async () => {
  const user = await createTestUser();
  try {
    // Create
    const createRes = await fetch(functionUrl("reflections"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        scope_description: "Housing beat weekly synthesis",
        content: "Rents in Zurich rose 3% this week across tracked listings.",
        generated_by: "synthesis_agent_v1",
      }),
    });
    assertEquals(createRes.status, 201);
    const created = await createRes.json();
    assertExists(created.id);
    assertEquals(created.scope_description, "Housing beat weekly synthesis");
    assertEquals(created.generated_by, "synthesis_agent_v1");

    // Get
    const getRes = await fetch(functionUrl("reflections", `/${created.id}`), {
      headers: headers(user.token),
    });
    assertEquals(getRes.status, 200);
    const fetched = await getRes.json();
    assertEquals(fetched.id, created.id);

    // List
    const listRes = await fetch(functionUrl("reflections"), {
      headers: headers(user.token),
    });
    assertEquals(listRes.status, 200);
    const listed = await listRes.json();
    assertEquals(listed.pagination.total, 1);
    assertEquals(listed.items.length, 1);
    assertEquals(listed.items[0].id, created.id);

    // Delete
    const delRes = await fetch(functionUrl("reflections", `/${created.id}`), {
      method: "DELETE",
      headers: headers(user.token),
    });
    await delRes.body?.cancel();
    assertEquals(delRes.status, 204);

    // Confirm gone
    const gone = await fetch(functionUrl("reflections", `/${created.id}`), {
      headers: headers(user.token),
    });
    await gone.body?.cancel();
    assertEquals(gone.status, 404);
  } finally {
    await user.cleanup();
  }
});

Deno.test("reflections: invalid body (missing generated_by) returns 400", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("reflections"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        scope_description: "Weekly synth",
        content: "Some synthesized content.",
      }),
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

Deno.test("reflections: delete of unknown id returns 404", async () => {
  const user = await createTestUser();
  try {
    const bogusId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(functionUrl("reflections", `/${bogusId}`), {
      method: "DELETE",
      headers: headers(user.token),
    });
    await res.body?.cancel();
    assertEquals(res.status, 404);
  } finally {
    await user.cleanup();
  }
});

const hasOpenRouter = !!Deno.env.get("OPENROUTER_API_KEY");
const semanticSearchTest = hasOpenRouter ? Deno.test : Deno.test.ignore;

semanticSearchTest(
  "reflections: semantic search returns items array",
  async () => {
    const user = await createTestUser();
    try {
      const res = await fetch(functionUrl("reflections", "/search"), {
        method: "POST",
        headers: headers(user.token),
        body: JSON.stringify({ query_text: "housing rent prices" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(Array.isArray(body.items), true);
      assertEquals(body.items.length, 0);
    } finally {
      await user.cleanup();
    }
  },
);
