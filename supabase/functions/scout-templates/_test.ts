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

Deno.test("scout-templates: unauthenticated returns 401", async () => {
  const res = await fetch(functionUrl("scout-templates"), { method: "GET" });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("scout-templates: GET / returns the template catalog", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("scout-templates"), {
      headers: headers(user.token),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.templates);
    assertEquals(Array.isArray(body.templates), true);
    assertEquals(body.templates.length > 0, true);
    // Sanity: each has a slug + name + type + fields
    for (const tpl of body.templates) {
      assertExists(tpl.slug);
      assertExists(tpl.name);
      assertExists(tpl.type);
      assertEquals(Array.isArray(tpl.fields), true);
    }
  } finally {
    await user.cleanup();
  }
});

Deno.test("scout-templates: GET /:slug returns one template", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(
      functionUrl("scout-templates", "/city-council-minutes"),
      { headers: headers(user.token) },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.slug, "city-council-minutes");
    assertEquals(body.type, "civic");
    assertEquals(Array.isArray(body.fields), true);
  } finally {
    await user.cleanup();
  }
});

Deno.test("scout-templates: GET /:slug returns 404 for unknown slug", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(
      functionUrl("scout-templates", "/does-not-exist"),
      { headers: headers(user.token) },
    );
    await res.body?.cancel();
    assertEquals(res.status, 404);
  } finally {
    await user.cleanup();
  }
});
