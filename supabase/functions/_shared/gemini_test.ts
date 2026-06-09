import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatGeminiEmbedText, geminiEmbed, geminiExtract } from "./gemini.ts";

Deno.test("formatGeminiEmbedText prefixes retrieval query text", () => {
  assertEquals(
    formatGeminiEmbedText("housing policy", "RETRIEVAL_QUERY"),
    "task: search result | query: housing policy",
  );
});

Deno.test("formatGeminiEmbedText prefixes retrieval document text with title", () => {
  assertEquals(
    formatGeminiEmbedText("body", "RETRIEVAL_DOCUMENT", "Council Minutes"),
    "title: Council Minutes | text: body",
  );
  assertEquals(
    formatGeminiEmbedText("body", "RETRIEVAL_DOCUMENT", null),
    "title: none | text: body",
  );
});

Deno.test("geminiEmbed sends prefixed text without taskType", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("GEMINI_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "test-key");

  let capturedBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        embedding: {
          values: new Array(1536).fill(0).map((_v, i) => (i === 0 ? 1 : 0)),
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const result = await geminiEmbed("body", "RETRIEVAL_DOCUMENT", {
      title: "Weekly digest",
    });
    assertEquals(result.length, 1536);
    const payload = JSON.parse(capturedBody);
    assertEquals(
      payload.content.parts[0].text,
      "title: Weekly digest | text: body",
    );
    assertEquals("taskType" in payload, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", originalKey);
  }
});

Deno.test("geminiEmbed rejects malformed embedding responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("GEMINI_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "test-key");

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ embedding: { values: [1, 2, 3] } }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    await assertRejects(
      () => geminiEmbed("body", "RETRIEVAL_QUERY"),
      Error,
      "unexpected embedding shape",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", originalKey);
  }
});

Deno.test("geminiExtract records provider usage metadata when context is supplied", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("GEMINI_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "test-key");

  const inserted: Record<string, unknown>[] = [];
  const fakeDb = {
    from(table: string) {
      assertEquals(table, "ai_usage_records");
      return {
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 4,
          totalTokenCount: 16,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const result = await geminiExtract<{ ok: boolean }>(
      "prompt",
      {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      {
        usage: {
          db: fakeDb as never,
          userId: "00000000-0000-0000-0000-000000000001",
          orgId: null,
          scoutId: "00000000-0000-0000-0000-000000000002",
          runId: "00000000-0000-0000-0000-000000000003",
          functionName: "test-fn",
          operation: "test_operation",
        },
      },
    );
    assertEquals(result.ok, true);
    assertEquals(inserted.length, 1);
    assertEquals(inserted[0].provider, "gemini");
    assertEquals(inserted[0].operation, "test_operation");
    assertEquals(inserted[0].prompt_tokens, 12);
    assertEquals(inserted[0].completion_tokens, 4);
    assertEquals(inserted[0].total_tokens, 16);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", originalKey);
  }
});

Deno.test("geminiExtract uses active org fallback when orgId is omitted", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("GEMINI_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "test-key");

  const inserted: Record<string, unknown>[] = [];
  const fakeDb = {
    from(table: string) {
      if (table === "user_preferences") {
        return {
          select(_columns: string) {
            return {
              eq(_column: string, _value: string) {
                return {
                  maybeSingle() {
                    return Promise.resolve({
                      data: {
                        active_org_id: "00000000-0000-0000-0000-000000000099",
                      },
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }
      assertEquals(table, "ai_usage_records");
      return {
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    await geminiExtract<{ ok: boolean }>(
      "prompt",
      {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      {
        usage: {
          db: fakeDb as never,
          userId: "00000000-0000-0000-0000-000000000001",
        },
      },
    );
    assertEquals(inserted[0].org_id, "00000000-0000-0000-0000-000000000099");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", originalKey);
  }
});

Deno.test("geminiExtract swallows usage insert failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("GEMINI_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "test-key");

  const fakeDb = {
    from(table: string) {
      if (table === "user_preferences") {
        return {
          select(_columns: string) {
            return {
              eq(_column: string, _value: string) {
                return {
                  maybeSingle() {
                    return Promise.resolve({
                      data: { active_org_id: null },
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }
      assertEquals(table, "ai_usage_records");
      return {
        insert(_row: Record<string, unknown>) {
          return Promise.resolve({ error: { message: "insert failed" } });
        },
      };
    },
  };

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const result = await geminiExtract<{ ok: boolean }>(
      "prompt",
      {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      {
        usage: {
          db: fakeDb as never,
          userId: "00000000-0000-0000-0000-000000000001",
        },
      },
    );
    assertEquals(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("GEMINI_API_KEY");
    else Deno.env.set("GEMINI_API_KEY", originalKey);
  }
});
