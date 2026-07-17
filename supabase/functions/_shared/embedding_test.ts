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
} from "./embedding.ts";

function vector(value = 0): number[] {
  return new Array(EMBEDDING_DIMENSIONS).fill(value);
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
      model: EMBEDDING_MODEL_TAG,
      dimensions: EMBEDDING_DIMENSIONS,
      data,
      ...extras,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}

Deno.test("embedding client sends raw typed inputs to the authenticated local service", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = Deno.env.get("EMBEDDING_SERVICE_URL");
  const originalToken = Deno.env.get("EMBEDDING_SERVICE_TOKEN");
  Deno.env.set("EMBEDDING_SERVICE_URL", "https://embedding.internal/");
  Deno.env.set("EMBEDDING_SERVICE_TOKEN", "internal-secret");
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
    assertEquals(capturedUrl, "https://embedding.internal/embed");
    assertEquals(
      capturedHeaders.get("Authorization"),
      "Bearer internal-secret",
    );
    assertEquals(capturedBody, {
      inputs: [{
        text: "body",
        task_type: "RETRIEVAL_DOCUMENT",
        title: "Council minutes",
      }],
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore("EMBEDDING_SERVICE_URL", originalUrl);
    restore("EMBEDDING_SERVICE_TOKEN", originalToken);
  }
});

Deno.test("embedding client restores response order and validates the exact model space", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = Deno.env.get("EMBEDDING_SERVICE_URL");
  const originalToken = Deno.env.get("EMBEDDING_SERVICE_TOKEN");
  Deno.env.set("EMBEDDING_SERVICE_URL", "https://embedding.internal");
  Deno.env.set("EMBEDDING_SERVICE_TOKEN", "token");
  try {
    globalThis.fetch = (async () =>
      response([
        { index: 1, embedding: vector(2) },
        { index: 0, embedding: vector(1) },
      ])) as typeof fetch;
    const values = await embedBatch([{ text: "one" }, { text: "two" }]);
    assertEquals(values[0][0], 1);
    assertEquals(values[1][0], 2);

    for (
      const bad of [
        response([{ index: 0, embedding: [1, 2] }]),
        response([{ index: 2, embedding: vector() }]),
        response([{ index: 0, embedding: vector() }], { model: "wrong" }),
        response([{ index: 0, embedding: vector() }], { dimensions: 1536 }),
      ]
    ) {
      globalThis.fetch = (async () => bad) as typeof fetch;
      await assertRejects(() => embedText("x"), Error, "Embedding service");
    }
  } finally {
    globalThis.fetch = originalFetch;
    restore("EMBEDDING_SERVICE_URL", originalUrl);
    restore("EMBEDDING_SERVICE_TOKEN", originalToken);
  }
});

Deno.test("embedding client chunks broad batches without changing order", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = Deno.env.get("EMBEDDING_SERVICE_URL");
  const originalToken = Deno.env.get("EMBEDDING_SERVICE_TOKEN");
  Deno.env.set("EMBEDDING_SERVICE_URL", "https://embedding.internal");
  Deno.env.set("EMBEDDING_SERVICE_TOKEN", "token");
  const batchSizes: number[] = [];
  let offset = 0;
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: globalThis.RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as { inputs: unknown[] };
    batchSizes.push(body.inputs.length);
    const start = offset;
    offset += body.inputs.length;
    return response(body.inputs.map((_, index) => ({
      index,
      embedding: vector(start + index),
    })));
  }) as typeof fetch;
  try {
    const values = await embedBatch(
      Array.from({ length: 65 }, (_, index) => ({ text: `item-${index}` })),
    );
    assertEquals(batchSizes, [32, 32, 1]);
    assertEquals(
      values.map((value) => value[0]),
      Array.from({ length: 65 }, (_, index) => index),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore("EMBEDDING_SERVICE_URL", originalUrl);
    restore("EMBEDDING_SERVICE_TOKEN", originalToken);
  }
});

Deno.test("embedding client fails closed and never exposes the internal token", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = Deno.env.get("EMBEDDING_SERVICE_URL");
  const originalToken = Deno.env.get("EMBEDDING_SERVICE_TOKEN");
  Deno.env.delete("EMBEDDING_SERVICE_URL");
  Deno.env.set("EMBEDDING_SERVICE_TOKEN", "internal-secret");
  try {
    await assertRejects(
      () => embedText("private text"),
      Error,
      "EMBEDDING_SERVICE_URL not configured",
    );
    Deno.env.set("EMBEDDING_SERVICE_URL", "https://embedding.internal");
    globalThis.fetch = (async () =>
      new Response("internal-secret private text", {
        status: 503,
      })) as typeof fetch;
    const error = await assertRejects(
      () =>
        embedText("private text"),
      Error,
      "status 503",
    );
    assert(!error.message.includes("internal-secret"));
    assert(!error.message.includes("private text"));
  } finally {
    globalThis.fetch = originalFetch;
    restore("EMBEDDING_SERVICE_URL", originalUrl);
    restore("EMBEDDING_SERVICE_TOKEN", originalToken);
  }
});

Deno.test("embedding client maps aborts to 504", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = Deno.env.get("EMBEDDING_SERVICE_URL");
  const originalToken = Deno.env.get("EMBEDDING_SERVICE_TOKEN");
  Deno.env.set("EMBEDDING_SERVICE_URL", "https://embedding.internal");
  Deno.env.set("EMBEDDING_SERVICE_TOKEN", "token");
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
    restore("EMBEDDING_SERVICE_URL", originalUrl);
    restore("EMBEDDING_SERVICE_TOKEN", originalToken);
  }
});
