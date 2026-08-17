import {
  assertEquals,
  assertMatch,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sha256Hex } from "../../supabase/functions/_shared/unit_dedup.ts";
import { webCanonicalHash } from "../../supabase/functions/_shared/web_content_canonical.ts";
import { BenchCtx } from "./_bench_shared.ts";
import { seedChangedBaseline } from "./benchmark-web.ts";

const CTX: BenchCtx = {
  supabaseUrl: "https://example.test",
  serviceKey: "service",
  anonKey: "anon",
  apiKey: "api",
  ownerEmail: "test@example.test",
  userId: "user-1",
};

Deno.test("Page benchmark seeds a stale baseline for the established comparison strategy", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    method?: string;
    body?: BodyInit | null;
  }> = [];
  let comparisonStrategy = "main";
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init && "method" in init ? init.method : undefined;
    const body = init && "body" in init ? init.body : undefined;
    requests.push({ url, method, body });
    if (method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify([JSON.parse(String(body))]), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify([{ comparison_strategy: comparisonStrategy }]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };

  try {
    await seedChangedBaseline(CTX, "scout-1", "https://example.test/page");
    assertEquals(requests.length, 2);
    const focused = JSON.parse(String(requests[1].body));
    assertEquals(focused.comparison_strategy, "main");
    assertEquals(focused.comparison_md, focused.content_md);
    assertEquals(focused.scout_run_id, null);
    assertMatch(focused.content_md, /^# stale benchmark baseline/);
    assertEquals(
      focused.content_sha256,
      await sha256Hex(focused.content_md),
    );
    assertEquals(
      focused.canonical_content_sha256,
      await webCanonicalHash(focused.comparison_md),
    );

    requests.length = 0;
    comparisonStrategy = "full";
    await seedChangedBaseline(CTX, "scout-2", "https://example.test/page");
    const full = JSON.parse(String(requests[1].body));
    assertEquals(full.comparison_strategy, "full");
    assertEquals(full.comparison_md, null);
    assertEquals(
      full.canonical_content_sha256,
      await webCanonicalHash(full.content_md),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Page benchmark bounds the baseline strategy lookup with the benchmark timeout", async () => {
  const originalFetch = globalThis.fetch;
  const timeoutEnv = "SCOUT_BENCH_FETCH_TIMEOUT_MS";
  const originalTimeout = Deno.env.get(timeoutEnv);
  Deno.env.set(timeoutEnv, "5");
  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      if (!signal) {
        reject(new Error("baseline lookup did not provide an abort signal"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(signal.reason),
        { once: true },
      );
    });

  try {
    await assertRejects(
      () =>
        seedChangedBaseline(
          CTX,
          "scout-timeout",
          "https://example.test/page",
        ),
      Error,
      "benchmark fetch timed out after 5ms",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTimeout === undefined) Deno.env.delete(timeoutEnv);
    else Deno.env.set(timeoutEnv, originalTimeout);
  }
});

Deno.test("Page benchmark reports a failed baseline strategy lookup", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("database unavailable", { status: 503 }));

  try {
    await assertRejects(
      () =>
        seedChangedBaseline(
          CTX,
          "scout-error",
          "https://example.test/page",
        ),
      Error,
      "baseline strategy lookup failed: 503 database unavailable",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Page benchmark reports a missing creation baseline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  try {
    await assertRejects(
      () =>
        seedChangedBaseline(
          CTX,
          "scout-missing",
          "https://example.test/page",
        ),
      Error,
      "creation baseline raw capture is missing for https://example.test/page",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
