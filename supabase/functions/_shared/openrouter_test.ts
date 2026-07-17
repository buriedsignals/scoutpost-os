import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { openRouterExtract } from "./openrouter.ts";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}

Deno.test("openRouterExtract sends strict JSON Schema and maps normalized usage metadata", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  const originalModel = Deno.env.get("LLM_MODEL");
  Deno.env.set("OPENROUTER_API_KEY", "test-secret");
  Deno.env.delete("LLM_MODEL");
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
  let capturedUrl = "";
  let capturedHeaders = new Headers();
  let capturedBody: Record<string, any> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: "gen-123",
        model: "google/gemini-2.5-flash-lite",
        openrouter_metadata: {
          endpoints: {
            available: [
              {
                provider: "Google Vertex AI",
                model: "google/gemini-2.5-flash-lite",
                selected: true,
              },
            ],
          },
        },
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          cost: 0.00001,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  try {
    const result = await openRouterExtract<{ ok: boolean }>(
      "prompt",
      schema,
      {
        systemInstruction: "Follow the schema.",
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
    assertEquals(result, { ok: true });
    assertEquals(capturedUrl, "https://openrouter.ai/api/v1/chat/completions");
    assertEquals(capturedHeaders.get("Authorization"), "Bearer test-secret");
    assertEquals(capturedHeaders.get("X-OpenRouter-Cache"), "false");
    assertEquals(capturedHeaders.get("X-OpenRouter-Metadata"), "enabled");
    assertEquals(capturedBody.model, "google/gemini-2.5-flash-lite");
    assertEquals(capturedBody.messages, [
      { role: "system", content: "Follow the schema." },
      { role: "user", content: "prompt" },
    ]);
    assertEquals(capturedBody.response_format, {
      type: "json_schema",
      json_schema: {
        name: "structured_response",
        strict: true,
        schema,
      },
    });
    assertEquals(capturedBody.provider, {
      only: ["google-vertex"],
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
    });
    assertEquals(inserted.length, 1);
    assertEquals(inserted[0].provider, "openrouter");
    assertEquals(inserted[0].model, "google/gemini-2.5-flash-lite");
    assertEquals(inserted[0].operation, "test_operation");
    assertEquals(inserted[0].prompt_tokens, 12);
    assertEquals(inserted[0].completion_tokens, 4);
    assertEquals(inserted[0].total_tokens, 16);
    assertEquals(inserted[0].metadata, {
      upstream_provider: "Google Vertex AI",
      openrouter_response_id: "gen-123",
      usage_metadata: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        cost: 0.00001,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
    restoreEnv("LLM_MODEL", originalModel);
  }
});

Deno.test("openRouterExtract uses active org fallback when orgId is omitted", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-key");
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
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    await openRouterExtract("prompt", { type: "object" }, {
      usage: {
        db: fakeDb as never,
        userId: "00000000-0000-0000-0000-000000000001",
      },
    });
    assertEquals(inserted[0].org_id, "00000000-0000-0000-0000-000000000099");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("OpenRouter usage insert failures do not fail extraction", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  const fakeDb = {
    from(_table: string) {
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
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    const result = await openRouterExtract<{ ok: boolean }>(
      "prompt",
      { type: "object" },
      { usage: { db: fakeDb as never, orgId: null } },
    );
    assertEquals(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("OpenRouter client reads only OPENROUTER_API_KEY", async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  const originalGeminiKey = Deno.env.get("GEMINI_API_KEY");
  Deno.env.delete("OPENROUTER_API_KEY");
  Deno.env.set("GEMINI_API_KEY", "must-not-be-used");
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response();
  }) as typeof fetch;

  try {
    const error = await assertRejects(
      () => openRouterExtract("body", { type: "object" }),
      Error,
      "OPENROUTER_API_KEY not configured",
    );
    assertEquals((error as { status?: number }).status, 500);
    assertEquals(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalOpenRouterKey);
    restoreEnv("GEMINI_API_KEY", originalGeminiKey);
  }
});

Deno.test("OpenRouter provider statuses are normalized without reflecting response bodies", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-secret");

  try {
    for (const status of [401, 402, 429, 500, 503]) {
      globalThis.fetch = (async () =>
        new Response(`sensitive prompt and test-secret ${status}`, {
          status,
        })) as typeof fetch;
      const error = await assertRejects(
        () =>
          openRouterExtract("sensitive prompt", { type: "object" }),
        Error,
        `status ${status}`,
      );
      assertEquals((error as { status?: number }).status, 502);
      assertEquals((error as { code?: string }).code, `openrouter_${status}`);
      assert(!error.message.includes("test-secret"));
      assert(!error.message.includes("sensitive prompt"));
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("OpenRouter client maps aborts to a 504 without exposing the bearer token", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-secret");
  globalThis.fetch =
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;

  try {
    const error = await assertRejects(
      () => openRouterExtract("body", { type: "object" }, { abortAfterMs: 1 }),
      Error,
      "aborted after 1ms",
    );
    assertEquals((error as { status?: number }).status, 504);
    assert(!error.message.includes("test-secret"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("OpenRouter client rejects malformed and incomplete chat responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-key");

  try {
    const responses = [
      new Response("not-json", { status: 200 }),
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(
        JSON.stringify({ choices: [{ message: { content: "not-json" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ];
    for (const response of responses) {
      globalThis.fetch = (async () => response) as typeof fetch;
      await assertRejects(
        () => openRouterExtract("prompt", { type: "object" }),
        Error,
        "OpenRouter",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("OpenRouter extraction rejects non-Google model IDs before fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response();
  }) as typeof fetch;

  try {
    await assertRejects(
      () =>
        openRouterExtract(
          "prompt",
          { type: "object" },
          { model: "qwen/qwen3.5-flash-02-23" },
        ),
      Error,
      "google/ namespace",
    );
    assertEquals(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
  }
});
