import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  OPENROUTER_DEFAULT_CHAT_MODEL,
  OPENROUTER_DEFAULT_FALLBACK_MODEL,
  openRouterExtract,
  validateOpenRouterSchema,
} from "./openrouter.ts";

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
      extraction_attempt: 1,
      fallback_used: false,
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

Deno.test("OpenRouter schema validation rejects legacy nullable keywords", async () => {
  const error = await assertRejects(
    async () => {
      validateOpenRouterSchema({
        type: "object",
        properties: {
          occurred_at: { type: "string", nullable: true },
        },
      });
    },
    Error,
    "unsupported nullable keyword",
  );
  assertEquals((error as { code?: string }).code, "openrouter_invalid_schema");

  validateOpenRouterSchema({
    type: "object",
    properties: {
      occurred_at: { type: ["string", "null"] },
    },
    required: ["occurred_at"],
    additionalProperties: false,
  });
});

Deno.test("OpenRouter retries an HTTP-200 provider error on the fallback model", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  const requestedModels: string[] = [];
  const usageRows: Record<string, unknown>[] = [];
  const fakeDb = {
    from(table: string) {
      assertEquals(table, "ai_usage_records");
      return {
        insert(row: Record<string, unknown>) {
          usageRows.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = JSON.parse(String(init?.body));
    requestedModels.push(request.model);
    if (requestedModels.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: "must not be reflected",
            metadata: { error_type: "provider_overloaded" },
          },
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        model: "google/gemini-2.5-flash",
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await openRouterExtract<{ ok: boolean }>(
      "prompt",
      { type: "object", properties: { ok: { type: "boolean" } } },
      {
        retryDelayMs: 0,
        usage: { db: fakeDb as never, orgId: null },
      },
    );
    assertEquals(result, { ok: true });
    assertEquals(requestedModels, [
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-flash",
    ]);
    assertEquals(usageRows.length, 1);
    assertEquals(usageRows[0].model, "google/gemini-2.5-flash");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("OpenRouter retries a network failure without exposing its message", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("secret host detail");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await openRouterExtract<{ ok: boolean }>(
      "prompt",
      { type: "object" },
      { retryDelayMs: 0 },
    );
    assertEquals(result.ok, true);
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("OpenRouter reserves deadline for a fallback after primary timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  const requestedModels: string[] = [];
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { model: string };
    requestedModels.push(request.model);
    if (request.model === OPENROUTER_DEFAULT_CHAT_MODEL) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        );
      });
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          model: OPENROUTER_DEFAULT_FALLBACK_MODEL,
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await openRouterExtract<{ ok: boolean }>(
      "prompt",
      { type: "object" },
      { timeoutMs: 20, abortAfterMs: 60, retryDelayMs: 0 },
    );
    assertEquals(result, { ok: true });
    assertEquals(requestedModels, [
      OPENROUTER_DEFAULT_CHAT_MODEL,
      OPENROUTER_DEFAULT_FALLBACK_MODEL,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("OpenRouter does not fallback for non-retryable provider errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: {
          code: 402,
          message: "billing detail",
          metadata: { error_type: "payment_required" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const error = await assertRejects(
      () =>
        openRouterExtract("prompt", { type: "object" }, { retryDelayMs: 0 }),
      Error,
      "payment_required",
    );
    assertEquals(
      (error as { code?: string }).code,
      "openrouter_payment_required",
    );
    assertEquals(calls, 1);
    assert(!error.message.includes("billing detail"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("OPENROUTER_API_KEY", originalKey);
  }
});
