import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  embedBatch,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_TAG,
  embedText,
  OPENROUTER_EMBEDDING_MODEL,
} from "./embedding.ts";

function vector(value = 0): number[] {
  return new Array(EMBEDDING_DIMENSIONS).fill(value);
}

function markerVector(value: number): number[] {
  return [value + 1, 1, ...new Array(EMBEDDING_DIMENSIONS - 2).fill(0)];
}

function response(
  data: Array<{ index: number; embedding: number[] }> = [{
    index: 0,
    embedding: vector(),
  }],
  extras: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      model: "gemini-embedding-001",
      data,
      usage: { prompt_tokens: 4, total_tokens: 4, cost: 0.0000006 },
      ...extras,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}

Deno.test("embedding client sends Gemini 768d to Google Vertex with ZDR", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "openrouter-secret");
  let capturedUrl = "";
  let capturedHeaders = new Headers();
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: globalThis.RequestInit,
  ) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    capturedBody = JSON.parse(String(init?.body));
    return response([{ index: 0, embedding: vector(0.25) }]);
  }) as typeof fetch;
  try {
    const result = await embedText("body", "RETRIEVAL_DOCUMENT", {
      title: "Council minutes",
    });
    assertEquals(result.length, 768);
    assertEquals(
      Math.abs(result.reduce((sum, value) => sum + value * value, 0) - 1) <
        1e-12,
      true,
    );
    assertEquals(capturedUrl, "https://openrouter.ai/api/v1/embeddings");
    assertEquals(
      capturedHeaders.get("Authorization"),
      "Bearer openrouter-secret",
    );
    assertEquals(capturedHeaders.get("X-OpenRouter-Cache"), "false");
    assertEquals(capturedBody, {
      model: OPENROUTER_EMBEDDING_MODEL,
      input: ["title: Council minutes | text: body"],
      dimensions: 768,
      input_type: "search_document",
      provider: {
        only: ["google-vertex"],
        allow_fallbacks: false,
        zdr: true,
        data_collection: "deny",
      },
    });
    assertEquals(EMBEDDING_MODEL_TAG.includes("768-zdr"), true);
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("embedding client restores response order and validates 768d", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "token");
  try {
    globalThis.fetch = (async () =>
      response([
        { index: 1, embedding: markerVector(1) },
        { index: 0, embedding: markerVector(0) },
      ])) as typeof fetch;
    const values = await embedBatch([{ text: "one" }, { text: "two" }]);
    assertEquals(values[0][0] < values[1][0], true);

    for (
      const bad of [
        response([{ index: 0, embedding: [1, 2] }]),
        response([{ index: 2, embedding: vector() }]),
        response([]),
      ]
    ) {
      globalThis.fetch = (async () => bad) as typeof fetch;
      await assertRejects(() => embedText("x"), Error, "OpenRouter embedding");
    }
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("embedding client preserves order across task and size batches", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "token");
  const batchTypes: string[] = [];
  const batchSizes: number[] = [];
  let offset = 0;
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: globalThis.RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as {
      input: string[];
      input_type: string;
    };
    batchTypes.push(body.input_type);
    batchSizes.push(body.input.length);
    const start = offset;
    offset += body.input.length;
    return response(body.input.map((_, index) => ({
      index,
      embedding: markerVector(start + index),
    })));
  }) as typeof fetch;
  try {
    const inputs = [
      ...Array.from({ length: 33 }, (_, index) => ({
        text: `doc-${index}`,
        taskType: "RETRIEVAL_DOCUMENT" as const,
      })),
      { text: "query", taskType: "RETRIEVAL_QUERY" as const },
    ];
    const values = await embedBatch(inputs);
    assertEquals(batchSizes, [32, 1, 1]);
    assertEquals(batchTypes, [
      "search_document",
      "search_document",
      "search_query",
    ]);
    assertEquals(
      values.map((value) => value[0]),
      Array.from(
        { length: 34 },
        (_, index) => (index + 1) / Math.sqrt((index + 1) ** 2 + 1),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("embedding client bisects count-mismatched batches with a bounded depth", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "token");
  const batchSizes: number[] = [];
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: globalThis.RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    batchSizes.push(body.input.length);
    if (body.input.length === 4) {
      return response([{ index: 0, embedding: markerVector(0) }]);
    }
    return response(body.input.map((text, index) => ({
      index,
      embedding: markerVector(Number(text.slice(-1))),
    })));
  }) as typeof fetch;
  try {
    const values = await embedBatch([
      { text: "item-0" },
      { text: "item-1" },
      { text: "item-2" },
      { text: "item-3" },
    ]);
    assertEquals(batchSizes, [4, 2, 2]);
    assertEquals(values.length, 4);
    assertEquals(values[0][0] < values[3][0], true);
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("embedding client stops bisection after two count-mismatch levels", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "token");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return response([]);
  }) as typeof fetch;
  try {
    const error = await assertRejects(
      () =>
        embedBatch(Array.from({ length: 8 }, (_, index) => ({
          text: `item-${index}`,
        }))),
      Error,
      "unexpected count",
    );
    assertEquals(
      (error as { code?: string }).code,
      "openrouter_embedding_count_mismatch",
    );
    // Initial 8, then the failing left branch at 4 and 2. The right branches
    // are not attempted once bounded recovery has conclusively failed.
    assertEquals(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("embedding client fails closed without exposing key or text", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.delete("OPENROUTER_API_KEY");
  try {
    await assertRejects(
      () => embedText("private text"),
      Error,
      "OPENROUTER_API_KEY not configured",
    );
    Deno.env.set("OPENROUTER_API_KEY", "openrouter-secret");
    globalThis.fetch = (async () =>
      new Response("openrouter-secret private text", {
        status: 503,
      })) as typeof fetch;
    const error = await assertRejects(
      () =>
        embedText("private text"),
      Error,
      "status 503",
    );
    assert(!error.message.includes("openrouter-secret"));
    assert(!error.message.includes("private text"));
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENROUTER_API_KEY", originalKey);
  }
});

Deno.test("embedding client maps aborts to 504", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "token");
  globalThis.fetch =
    ((_input: RequestInfo | URL, init?: globalThis.RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
  try {
    const error = await assertRejects(
      () => embedText("x", "RETRIEVAL_QUERY", { abortAfterMs: 1 }),
      Error,
      "aborted after 1ms",
    );
    assertEquals((error as { status?: number }).status, 504);
  } finally {
    globalThis.fetch = originalFetch;
    restore("OPENROUTER_API_KEY", originalKey);
  }
});
