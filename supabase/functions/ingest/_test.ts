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

Deno.test("ingest: unauthenticated request returns 401", async () => {
  const res = await fetch(functionUrl("ingest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "text", text: "x".repeat(60) }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("ingest: invalid body (missing url when kind=url) returns 400", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("ingest"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({ kind: "url" }),
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

Deno.test("ingest: short text body returns 400", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("ingest"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({ kind: "text", text: "too short" }),
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

// Full happy-path test requires live extraction, scraping, and local embedding
// services plus network access. We cannot reliably stub them in this
// integration harness, so only run when every dependency is configured.
const hasLiveKeys = !!Deno.env.get("OPENROUTER_API_KEY") &&
  !!Deno.env.get("FIRECRAWL_API_KEY") &&
  !!Deno.env.get("EMBEDDING_SERVICE_URL") &&
  !!Deno.env.get("EMBEDDING_SERVICE_TOKEN");

Deno.test(
  {
    name: "ingest: happy path extracts units (live keys required)",
    ignore: !hasLiveKeys,
  },
  async () => {
    const user = await createTestUser();
    try {
      const text =
        "The Zurich city council voted on 12 March 2025 to approve " +
        "a new affordable housing subsidy targeting low-income families. " +
        "Mayor Corine Mauch said the scheme will cost 40 million francs " +
        "annually and aims to create 2,000 new subsidised units by 2030.";
      const res = await fetch(functionUrl("ingest"), {
        method: "POST",
        headers: headers(user.token),
        body: JSON.stringify({
          kind: "text",
          text,
          title: "Test ingest",
        }),
      });
      assertEquals(res.status, 201);
      const body = await res.json();
      assertExists(body.ingest_id);
      assertExists(body.raw_capture_id);
      assertExists(body.units);
    } finally {
      await user.cleanup();
    }
  },
);
