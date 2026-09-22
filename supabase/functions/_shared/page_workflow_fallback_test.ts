import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.224.0/testing/time.ts";
import {
  childStage,
  isHostPolicyRouted,
  PageWorkflowPending,
  PageWorkflowTransport,
} from "./page_workflow_transport.ts";
import fixture from "./fixtures/page_baselland_timeout.json" with {
  type: "json",
};

const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";
const RESULT_URL = "https://storage.example.test/";
const CONTENT =
  "# Regierungsrat\nDie beschlossenen Vorlagen werden veröffentlicht.";

// Stateful durable jobs: resumes read real gzip results through their manifests.
function fallbackJobs(urls: string[], timeoutExhausted = false) {
  const rows = urls.map((url, index) => ({
    id: `job-${index}`,
    dedupe_key: `key-${index}`,
    status: "fallback_required",
    request_kind: "scout_run",
    continuation_key: fixture.scout_run_id,
    url,
    attempts: timeoutExhausted ? 3 : 1,
    max_attempts: 3,
    error_class: timeoutExhausted ? "timeout" : "anti_bot",
    error_message: "primary failed",
    lease_token: null as string | null,
    result_manifest: null as Record<string, unknown> | null,
  }));
  const stored = new Map<string, Uint8Array>();
  const claims: string[] = [];
  let rejectCompletion = false;
  const svc = {
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "enqueue_crawler_job") {
        const row = rows.find((row) => row.url === args.p_url);
        if (!row) throw new Error("unexpected enqueue URL");
        return Promise.resolve({ data: row, error: null });
      }
      const row = rows.find((row) => row.id === args.p_job_id);
      if (!row) throw new Error("unexpected job ID");
      if (fn === "claim_page_crawler_fallback") {
        if (row.status !== "fallback_required" || row.lease_token) {
          return Promise.resolve({ data: null, error: null });
        }
        claims.push(row.url);
        row.lease_token = "fallback-lease";
        return Promise.resolve({ data: row.lease_token, error: null });
      }
      if (fn === "complete_crawler_fallback") {
        if (rejectCompletion) {
          return Promise.resolve({ data: false, error: null });
        }
        row.status = args.p_ok ? "succeeded" : "terminal_failed";
        row.error_message = String(args.p_error ?? "");
        row.result_manifest = args.p_manifest as Record<string, unknown> | null;
        row.lease_token = null;
        return Promise.resolve({ data: true, error: null });
      }
      throw new Error(`unexpected RPC ${fn}`);
    },
    from() {
      let id: unknown;
      return {
        select() {
          return this;
        },
        eq(_column: string, value: unknown) {
          id = value;
          return this;
        },
        single() {
          return Promise.resolve({
            data: rows.find((row) => row.id === id),
            error: null,
          });
        },
      };
    },
    storage: {
      from() {
        return {
          upload(path: string, bytes: Uint8Array) {
            stored.set(path, bytes);
            return Promise.resolve({ error: null });
          },
          createSignedUrl(path: string) {
            return Promise.resolve({
              data: { signedUrl: `${RESULT_URL}${path}` },
              error: null,
            });
          },
          remove(paths: string[]) {
            for (const path of paths) stored.delete(path);
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
  const run = {
    id: fixture.scout_run_id,
    scoutId: fixture.event.scout_id,
    userId: "benchmark-user",
    tenantKey: "benchmark-user",
  };
  return {
    rows,
    claims,
    transport: () => new PageWorkflowTransport(svc as never, run),
    transportWith: (
      deps: ConstructorParameters<typeof PageWorkflowTransport>[3],
    ) => new PageWorkflowTransport(svc as never, run, Date.now(), deps),
    rejectCompletion() {
      rejectCompletion = true;
    },
    resultResponse(url: string) {
      const bytes = stored.get(url.slice(RESULT_URL.length));
      if (!bytes) throw new Error("no persisted fallback result");
      return new Response(bytes.slice().buffer);
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

function renderer(
  jobs: { resultResponse(url: string): Response },
  durations: number[],
) {
  const starts = durations.map(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => resolve = done);
    return { promise, resolve };
  });
  const requests: string[] = [];
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith(RESULT_URL)) {
      return Promise.resolve(jobs.resultResponse(String(input)));
    }
    assertEquals(String(input), FIRECRAWL_URL);
    const request = init as RequestInit;
    const body = JSON.parse(String(request.body));
    const index = requests.length;
    const duration = durations[index];
    requests.push(body.url);
    starts[index].resolve();
    return new Promise<Response>((resolve, reject) => {
      const timer = Number.isFinite(duration)
        ? setTimeout(() => {
          const timedOut = body.timeout < duration;
          resolve(
            new Response(
              JSON.stringify(
                timedOut ? fixture.response : {
                  data: {
                    markdown: body.maxAge === 0 && body.storeInCache === false
                      ? CONTENT
                      : "Stale cached content",
                    screenshot: body.formats.some((format: unknown) =>
                        typeof format === "object" && format !== null &&
                        "type" in format && format.type === "screenshot"
                      )
                      ? "https://storage.example.test/screenshot.png"
                      : undefined,
                    metadata: { sourceURL: body.url, statusCode: 200 },
                  },
                },
              ),
              { status: timedOut ? 408 : 200 },
            ),
          );
        }, Math.min(body.timeout, duration))
        : undefined;
      request.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("deadline", "AbortError"));
      }, { once: true });
    });
  };
  return { requests, starts };
}

Deno.test(
  "a root fallback can finish after 30s and resume from its single durable result",
  withFallbackClock(async (clock) => {
    const url = "https://wohnraumverteidigen.org/";
    const jobs = fallbackJobs([url], true);
    const provider = renderer(jobs, [40_000]);
    const pending = assertRejects(
      () =>
        jobs.transport().scrape({
          url,
          timeoutMs: 25_000,
          abortAfterMs: 30_000,
          maxAgeMs: 0,
          storeInCache: false,
        }, "root"),
      PageWorkflowPending,
    );
    await provider.starts[0].promise;
    await clock.tickAsync(40_000);
    assertEquals((await pending).stage, "waiting_root");
    const resumed = await jobs.transport().scrape({ url }, "root");
    assertEquals(resumed.markdown, CONTENT);
    assertEquals(resumed.fallback_reason, "timeout_exhausted");
    assertEquals(resumed.served_by, "firecrawl");
    assertEquals(provider.requests, [url]);
    assertEquals(jobs.claims, [url]);
  }),
);

Deno.test(
  "later children get a full fallback window while unadmitted children wait for resume",
  withFallbackClock(async (clock) => {
    const urls = ["first", "second", "third"].map((name) =>
      `https://example.test/notices/${name}`
    );
    const jobs = fallbackJobs(urls);
    const provider = renderer(jobs, [30_000, 40_000, 2_000]);
    const options = {
      timeoutMs: 12_000,
      maxAgeMs: 0,
      storeInCache: false,
      snapshot: "on_fallback" as const,
    };
    const pending = assertRejects(
      () => jobs.transport().prepareChildren(urls, options),
      PageWorkflowPending,
    );
    await provider.starts[0].promise;
    await clock.tickAsync(30_000);
    await provider.starts[1].promise;
    await clock.tickAsync(40_000);
    assertEquals((await pending).stage, "waiting_children");
    assertEquals(jobs.rows.map((row) => row.status), [
      "succeeded",
      "succeeded",
      "fallback_required",
    ]);
    assertEquals(jobs.rows[2].lease_token, null);
    assertEquals(jobs.claims, urls.slice(0, 2));

    const resumed = assertRejects(
      () => jobs.transport().prepareChildren(urls, options),
      PageWorkflowPending,
    );
    await provider.starts[2].promise;
    await clock.tickAsync(2_000);
    await resumed;
    const ready = jobs.transport();
    await ready.prepareChildren(urls, options);
    for (const url of urls) {
      const result = await ready.scrape({ ...options, url }, childStage(url));
      assertEquals(result.markdown, CONTENT);
      assertEquals(result.source_url, url);
      assertEquals(
        result.screenshot_url,
        "https://storage.example.test/screenshot.png",
      );
    }
    assertEquals(provider.requests, urls);
    assertEquals(jobs.claims, urls);
  }),
);

Deno.test(
  "a stalled fallback exhausts its own request window and cannot spend again on resume",
  withFallbackClock(async (clock) => {
    const url = fixture.event.url;
    const jobs = fallbackJobs([url]);
    const transport = jobs.transport();
    const provider = renderer(jobs, [Infinity]);
    await clock.tickAsync(30_000);
    let settled = false;
    const pending = assertRejects(
      () => transport.prepareChildren([url], { timeoutMs: 12_000 }),
      PageWorkflowPending,
    ).then((error) => {
      settled = true;
      return error;
    });
    await provider.starts[0].promise;
    await clock.tickAsync(60_000);
    assertEquals(settled, false);
    await clock.tickAsync(5_000);
    await pending;
    assertEquals(jobs.rows[0].status, "terminal_failed");
    const resumed = jobs.transport();
    await resumed.prepareChildren([url], { timeoutMs: 12_000 });
    await assertRejects(
      () => resumed.scrape({ url }, childStage(url)),
      Error,
      "firecrawl scrape aborted",
    );
    assertEquals(provider.requests, [url]);
    assertEquals(jobs.claims, [url]);
  }),
);

Deno.test(
  "fallback completion rejection is a runtime failure, not a successful pause",
  withFallbackClock(async () => {
    const url = fixture.event.url;
    const jobs = fallbackJobs([url]);
    jobs.rejectCompletion();
    globalThis.fetch = () =>
      Promise.resolve(new Response("failed", { status: 504 }));
    await assertRejects(
      () => jobs.transport().prepareChildren([url], { timeoutMs: 12_000 }),
      Error,
      "fallback failure completion rejected",
    );
  }),
);

Deno.test("a blocked host enqueues its durable job already routed to fallback", async () => {
  const enqueues: Record<string, unknown>[] = [];
  const job = {
    id: "job-policy",
    dedupe_key: "key",
    status: "queued",
    request_kind: "scout_run",
    continuation_key: fixture.scout_run_id,
    lease_token: null,
  };
  const svc = {
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== "enqueue_crawler_job") throw new Error(`unexpected RPC ${fn}`);
      enqueues.push(args);
      return Promise.resolve({ data: job, error: null });
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
          return Promise.resolve({ data: job, error: null });
        },
      };
    },
  };
  const transport = new PageWorkflowTransport(
    svc as never,
    {
      id: fixture.scout_run_id,
      scoutId: fixture.event.scout_id,
      userId: "u",
      tenantKey: "u",
    },
    Date.now(),
    {
      resolvePlan: (url) =>
        Promise.resolve({
          host: new URL(url).hostname,
          providers: ["firecrawl"],
          policy: null,
          skipPrimary: url.includes("blocked"),
        }),
    },
  );
  // Both jobs are still active after enqueue, so the run parks as usual.
  await assertRejects(
    () =>
      transport.prepareChildren(
        ["https://blocked.example/a", "https://open.example/b"],
        { timeoutMs: 12_000 },
      ),
    PageWorkflowPending,
  );
  const byUrl = Object.fromEntries(enqueues.map((a) => [a.p_url, a]));
  assertEquals(
    byUrl["https://blocked.example/a"].p_fallback_reason,
    "anti_bot",
  );
  assertEquals(
    (byUrl["https://blocked.example/a"].p_options as Record<string, unknown>)
      .host_policy,
    "firecrawl",
  );
  assertEquals(byUrl["https://open.example/b"].p_fallback_reason, null);
  assertEquals(
    (byUrl["https://open.example/b"].p_options as Record<string, unknown>)
      .host_policy,
    undefined,
  );
  assertEquals(
    isHostPolicyRouted({
      error_message:
        "host policy: primary renderer blocked by anti-bot protection",
    }),
    true,
  );
  assertEquals(isHostPolicyRouted({ error_message: "primary failed" }), false);
  assertEquals(isHostPolicyRouted({ error_message: null }), false);
});

Deno.test(
  "worker-reported rescues record host evidence with their reason; a policy-routed one does not",
  withFallbackClock(async (clock) => {
    const url = "https://www.mardigras.org.au/";
    const jobs = fallbackJobs([url]);
    const rescued: string[] = [];
    const transport = jobs.transportWith({
      resolvePlan: (u) =>
        Promise.resolve({
          host: new URL(u).hostname,
          providers: ["crawl4ai", "firecrawl"],
          policy: null,
          skipPrimary: false,
        }),
      noteFallbackRescue: (host, reason) => {
        rescued.push(`${host}:${reason}`);
        return Promise.resolve();
      },
    });
    const provider = renderer(jobs, [1_000]);
    const first = transport.scrape({ url, timeoutMs: 25_000 }, childStage(url));
    await provider.starts[0].promise;
    await clock.tickAsync(1_100);
    await first;
    assertEquals(rescued, ["www.mardigras.org.au:anti_bot"]);

    jobs.rows[0].status = "fallback_required";
    jobs.rows[0].lease_token = null;
    jobs.rows[0].result_manifest = null;
    jobs.rows[0].error_message =
      "host policy: primary renderer blocked by anti-bot protection";
    const again = renderer(jobs, [1_000]);
    const second = transport.scrape(
      { url, timeoutMs: 25_000 },
      childStage(url),
    );
    await again.starts[0].promise;
    await clock.tickAsync(1_100);
    await second;
    assertEquals(rescued, ["www.mardigras.org.au:anti_bot"]);

    jobs.rows[0].status = "fallback_required";
    jobs.rows[0].lease_token = null;
    jobs.rows[0].result_manifest = null;
    jobs.rows[0].error_class = "timeout";
    jobs.rows[0].attempts = 3;
    jobs.rows[0].error_message = "primary failed";
    const third = renderer(jobs, [1_000]);
    const timeout = transport.scrape(
      { url, timeoutMs: 25_000 },
      childStage(url),
    );
    await third.starts[0].promise;
    await clock.tickAsync(1_100);
    await timeout;
    assertEquals(rescued, [
      "www.mardigras.org.au:anti_bot",
      "www.mardigras.org.au:timeout_exhausted",
    ]);
  }),
);
