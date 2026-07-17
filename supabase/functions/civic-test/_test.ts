/**
 * Tests for civic-test Edge Function.
 *
 * Happy path calls live Firecrawl + OpenRouter and is gated on
 * FIRECRAWL_API_KEY + OPENROUTER_API_KEY.
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createTestUser, functionUrl } from "../_shared/_testing.ts";

const FIRECRAWL_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";

function headers(token: string): HeadersInit {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

Deno.test("civic-test: unauthenticated returns 401", async () => {
  const res = await fetch(functionUrl("civic-test"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracked_urls: ["https://example.com"] }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("civic-test: 400 on missing tracked_urls", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("civic-test"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

Deno.test("civic-test: 400 on empty tracked_urls array", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("civic-test"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({ tracked_urls: [] }),
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

Deno.test({
  name: "civic-test: happy path returns results (live firecrawl + openrouter)",
  ignore: !FIRECRAWL_KEY || !OPENROUTER_KEY,
  fn: async () => {
    const user = await createTestUser();
    try {
      const res = await fetch(functionUrl("civic-test"), {
        method: "POST",
        headers: headers(user.token),
        body: JSON.stringify({
          tracked_urls: ["https://example.com"],
        }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertExists(body.results);
      assertEquals(Array.isArray(body.results), true);
      assertEquals(body.results.length, 1);
      assertEquals(body.results[0].url, "https://example.com");
    } finally {
      await user.cleanup();
    }
  },
});
