import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  artifactPath,
  benchmarkFaults,
  gunzipLimited,
  readStreamLimited,
  rejectedBundleIsLosing,
  timingSafeEqual,
  validateResultSchema,
  verifyCompletionBundle,
  workerTokenAccepted,
} from "./index.ts";

Deno.test("benchmark faults are fixed and only exposed on attempt one", () => {
  const job = {
    request_kind: "benchmark",
    attempt: 1,
    options: {
      inject_task_exit_after: 5,
      inject_callback_timeout: true,
    },
  };
  assertEquals(benchmarkFaults(job as never), {
    fault_exit_after: 5,
    fault_callback_timeout: true,
  });
  assertEquals(benchmarkFaults({ ...job, attempt: 2 } as never), {});
  assertEquals(
    benchmarkFaults({
      ...job,
      request_kind: "scout_run",
    } as never),
    {},
  );
});

Deno.test("duplicate callback never deletes the accepted execution bundle", () => {
  const job = { result_manifest: { execution_id: "winner" } };
  assertEquals(
    rejectedBundleIsLosing(job as never, { execution_id: "winner" } as never),
    false,
  );
  assertEquals(
    rejectedBundleIsLosing(job as never, { execution_id: "loser" } as never),
    true,
  );
});

Deno.test("worker token accepts current and bounded previous token", () => {
  const now = new Date("2026-08-04T10:00:00Z");
  const env = {
    WORKFLOW_WORKER_TOKEN: "current-secret",
    WORKFLOW_WORKER_TOKEN_PREVIOUS: "previous-secret",
    WORKFLOW_WORKER_TOKEN_PREVIOUS_EXPIRES_AT: "2026-08-04T20:00:00Z",
  };
  assert(workerTokenAccepted("current-secret", env, now));
  assert(workerTokenAccepted("previous-secret", env, now));
  assertEquals(workerTokenAccepted("wrong", env, now), false);
});

Deno.test("previous token rejects absent, expired, invalid, and overlong expiry", () => {
  const now = new Date("2026-08-04T10:00:00Z");
  const base = {
    WORKFLOW_WORKER_TOKEN: "current",
    WORKFLOW_WORKER_TOKEN_PREVIOUS: "previous",
  };
  for (
    const expiry of [
      undefined,
      "invalid",
      "2026-08-04T09:59:59Z",
      "2026-08-05T10:00:01Z",
    ]
  ) {
    assertEquals(
      workerTokenAccepted("previous", {
        ...base,
        WORKFLOW_WORKER_TOKEN_PREVIOUS_EXPIRES_AT: expiry,
      }, now),
      false,
    );
  }
});

Deno.test("timing-safe comparison handles different lengths", () => {
  assert(timingSafeEqual("same", "same"));
  assertEquals(timingSafeEqual("same", "same-longer"), false);
  assertEquals(timingSafeEqual("", ""), false);
});

Deno.test("artifact paths are fully derived from opaque identifiers", () => {
  const path = artifactPath(
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "result",
  );
  assertEquals(
    path,
    "results/00000000-0000-4000-8000-000000000001/" +
      "00000000-0000-4000-8000-000000000002/" +
      "00000000-0000-4000-8000-000000000003.json.gz",
  );
});

Deno.test("stream cap accepts minus-one and exact, rejects plus-one", async () => {
  for (const size of [9, 10]) {
    const body = new Response(new Uint8Array(size)).body;
    assertEquals((await readStreamLimited(body, 10)).byteLength, size);
  }
  await assertRejects(
    () => readStreamLimited(new Response(new Uint8Array(11)).body, 10),
    Error,
    "artifact exceeds limit",
  );
});

Deno.test("gzip expansion is capped before full bomb materialization", async () => {
  const compressed = await gzip(new Uint8Array(1024));
  await assertRejects(
    () => gunzipLimited(compressed, 100),
    Error,
    "artifact exceeds limit",
  );
});

Deno.test("result schema is operation-specific", async () => {
  validateResultSchema("scrape", {
    markdown: "ok",
    source_url: "https://example.test",
  });
  await assertRejects(
    async () =>
      validateResultSchema("parse_pdf", {
        markdown: "ok",
        source_url: "https://example.test/doc.pdf",
      }),
    Error,
    "invalid PDF result schema",
  );
});

Deno.test("snapshot completion requires all three artifacts", async () => {
  const completion = {
    job_id: "00000000-0000-4000-8000-000000000001",
    attempt_id: "00000000-0000-4000-8000-000000000002",
    execution_id: "00000000-0000-4000-8000-000000000003",
    ok: true as const,
    artifacts: [{ kind: "result" as const, sha256: "0".repeat(64), bytes: 1 }],
  };
  await assertRejects(
    () =>
      verifyCompletionBundle({} as never, {
        id: completion.job_id,
        batch_id: "batch",
        lease_token: completion.attempt_id,
        operation: "snapshot",
        status: "running",
        request_kind: "benchmark",
        continuation_key: "benchmark",
      }, completion),
    Error,
    "snapshot artifacts missing",
  );
});

Deno.test("result bundle rejects hash mismatch", async () => {
  const result = await gzip(new TextEncoder().encode(JSON.stringify({
    markdown: "ok",
    source_url: "https://example.test",
  })));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(result.slice().buffer));
  const svc = {
    storage: {
      from: () => ({
        createSignedUrl: () =>
          Promise.resolve({
            data: { signedUrl: "https://storage.test/signed?token=secret" },
            error: null,
          }),
      }),
    },
  };
  try {
    await assertRejects(
      () =>
        verifyCompletionBundle(svc as never, {
          id: "00000000-0000-4000-8000-000000000001",
          batch_id: "batch",
          lease_token: "00000000-0000-4000-8000-000000000002",
          operation: "scrape",
          status: "running",
          request_kind: "benchmark",
          continuation_key: "benchmark",
        }, {
          job_id: "00000000-0000-4000-8000-000000000001",
          attempt_id: "00000000-0000-4000-8000-000000000002",
          execution_id: "00000000-0000-4000-8000-000000000003",
          ok: true,
          artifacts: [{
            kind: "result",
            sha256: "0".repeat(64),
            bytes: result.byteLength,
          }],
        }),
      Error,
      "artifact hash mismatch",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
