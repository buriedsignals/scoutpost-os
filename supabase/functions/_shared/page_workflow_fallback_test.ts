import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.224.0/testing/time.ts";
import {
  childStage,
  PageWorkflowTransport,
} from "./page_workflow_transport.ts";
import fixture from "./fixtures/page_baselland_timeout.json" with {
  type: "json",
};

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const RESULT_URL = "https://storage.example.test/result";
const CONTENT =
  "# Regierungsrat\nDie beschlossenen Vorlagen werden veröffentlicht.";

// A stateful durable-job boundary: fallback completion is loaded on the next
// scrape, including real gzip, manifest integrity checking and result decoding.
function fallbackJob() {
  const row = {
    id: "child-job",
    dedupe_key: "child-key",
    status: "fallback_required",
    request_kind: "scout_run",
    continuation_key: fixture.scout_run_id,
    url: fixture.event.url,
    attempts: 1,
    max_attempts: 3,
    error_class: "anti_bot",
    error_message: "primary challenge",
    lease_token: null as string | null,
    result_manifest: null as Record<string, unknown> | null,
  };
  let stored: Uint8Array | null = null;
  const svc = {
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "enqueue_crawler_job") {
        return Promise.resolve({ data: row, error: null });
      }
      if (fn === "claim_page_crawler_fallback") {
        row.lease_token = "fallback-lease";
        return Promise.resolve({ data: row.lease_token, error: null });
      }
      if (fn === "complete_crawler_fallback") {
        row.status = args.p_ok ? "succeeded" : "terminal_failed";
        row.error_message = String(args.p_error ?? "");
        row.result_manifest = args.p_manifest as Record<string, unknown> | null;
        row.lease_token = null;
        return Promise.resolve({ data: true, error: null });
      }
      throw new Error(`unexpected RPC ${fn}`);
    },
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        single() {
          return Promise.resolve({ data: row, error: null });
        },
      };
    },
    storage: {
      from() {
        return {
          upload(_path: string, bytes: Uint8Array) {
            stored = bytes;
            return Promise.resolve({ error: null });
          },
          createSignedUrl() {
            return Promise.resolve({
              data: { signedUrl: RESULT_URL },
              error: null,
            });
          },
          remove() {
            stored = null;
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
  return {
    transport: new PageWorkflowTransport(svc as never, {
      id: fixture.scout_run_id,
      scoutId: fixture.event.scout_id,
      userId: "benchmark-user",
      tenantKey: "benchmark-user",
    }),
    resultResponse() {
      if (!stored) throw new Error("no persisted fallback result");
      return new Response(stored.slice().buffer);
    },
  };
}

function withFallbackClock(test: (clock: FakeTime) => Promise<void>) {
  return async () => {
    const clock = new FakeTime(1_800_000_000_000);
    const fetcher = globalThis.fetch;
    const key = Deno.env.get("FIRECRAWL_API_KEY");
    Deno.env.set("FIRECRAWL_API_KEY", "test-only-key");
    try {
      await test(clock);
    } finally {
      globalThis.fetch = fetcher;
      if (key === undefined) Deno.env.delete("FIRECRAWL_API_KEY");
      else Deno.env.set("FIRECRAWL_API_KEY", key);
      clock.restore();
    }
  };
}

Deno.test(
  "native Page fallback can render beyond the primary navigation cap within Phase B",
  withFallbackClock(async (clock) => {
    const job = fallbackJob();
    let requests = 0;
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    globalThis.fetch = (input, init) => {
      if (String(input) === RESULT_URL) {
        return Promise.resolve(job.resultResponse());
      }
      assertEquals(String(input), FIRECRAWL_URL);
      requests++;
      const request = init as RequestInit;
      const timeout = JSON.parse(String(request.body)).timeout as number;
      admitted();
      // The historical 408 is replayed when a synthetic 20s render cannot fit.
      // This duration tests budget separation; it is not a measured site latency.
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() =>
          resolve(
            new Response(
              JSON.stringify(
                timeout < 20_000 ? fixture.response : {
                  data: {
                    markdown: CONTENT,
                    metadata: { sourceURL: fixture.event.url, statusCode: 200 },
                  },
                },
              ),
              { status: timeout < 20_000 ? 408 : 200 },
            ),
          ), Math.min(timeout, 20_000));
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("deadline", "AbortError"));
        }, { once: true });
      });
    };
    await job.transport.prepareChildren([fixture.event.url], 12_000);
    const deadlineMs = Date.now() + 35_000;
    const result = job.transport.scrape({
      url: fixture.event.url,
      timeoutMs: 12_000,
      abortAfterMs: 15_000,
      deadlineMs,
    }, childStage(fixture.event.url));
    // Attach a rejection handler before advancing a pre-fix timeout.
    const observed = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await started;
    await clock.tickAsync(20_000);
    const outcome = await observed;
    if ("error" in outcome) throw outcome.error;
    assertEquals(outcome.value.markdown, CONTENT);
    assertEquals(outcome.value.source_url, fixture.event.url);
    assertEquals(outcome.value.served_by, "firecrawl");
    assertEquals(requests, 1);
  }),
);

Deno.test(
  "native Page fallback cannot renew an exhausted Phase B deadline",
  withFallbackClock(async (clock) => {
    const job = fallbackJob();
    let requests = 0;
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    globalThis.fetch = (input, init) => {
      assertEquals(String(input), FIRECRAWL_URL);
      requests++;
      admitted();
      return new Promise<Response>((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => {
          reject(new DOMException("deadline", "AbortError"));
        }, { once: true });
      });
    };
    const options = {
      url: fixture.event.url,
      timeoutMs: 12_000,
      abortAfterMs: 15_000,
      deadlineMs: Date.now() + 35_000,
    };
    await clock.tickAsync(30_000);
    const failure = assertRejects(() =>
      job.transport.scrape(options, childStage(options.url))
    );
    await started;
    await clock.tickAsync(5_000);
    await failure;
    // A failed paid attempt stays terminal even if another caller offers more time.
    await assertRejects(() =>
      job.transport.scrape(
        { ...options, deadlineMs: Date.now() + 35_000 },
        childStage(options.url),
      )
    );
    assertEquals(requests, 1);
  }),
);

Deno.test(
  "native Page fallback rejects an already expired budget before provider admission",
  withFallbackClock(async () => {
    const job = fallbackJob();
    let requests = 0;
    globalThis.fetch = () => {
      requests++;
      throw new Error("provider must not be called");
    };
    await assertRejects(() =>
      job.transport.scrape({
        url: fixture.event.url,
        timeoutMs: 12_000,
        abortAfterMs: 15_000,
        deadlineMs: Date.now() - 1,
      }, childStage(fixture.event.url))
    );
    assertEquals(requests, 0);
  }),
);
