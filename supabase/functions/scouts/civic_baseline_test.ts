import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Exercise the creation-time baseline caller, including its final baseline
// stamp, without starting a server or bypassing the shared scrape/resolver.
const serve = Deno.serve;
Deno.serve = (() => ({})) as unknown as typeof Deno.serve;
let baseline: typeof import("./index.ts").ensureScheduledBaseline;
try {
  baseline = (await import("./index.ts")).ensureScheduledBaseline;
} finally {
  Deno.serve = serve;
}

async function exercise(mode: "failed" | "overflow" | "success") {
  const writes: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  const db = createClient("https://db.test", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (raw, init) => {
        const request = init as { method?: string; body?: unknown };
        writes.push({
          path: new URL(String(raw)).pathname,
          method: request.method ?? "GET",
          body: JSON.parse(String(request.body ?? "null")),
        });
        return Promise.resolve(Response.json([]));
      },
    },
  });
  const settings = {
    SCRAPE_PROVIDER: "crawl4ai",
    SCRAPE_SERVICE_URL: "https://scrape.test",
    SCRAPE_SERVICE_TOKEN: "fixture",
  };
  const previous = new Map(
    Object.keys(settings).map((key) => [key, Deno.env.get(key)]),
  );
  const original = globalThis.fetch;
  let wrapperCalls = 0;
  let failure: unknown;
  try {
    for (const [key, value] of Object.entries(settings)) {
      Deno.env.set(key, value);
    }
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const url = new URL(body.url);
      const committee = url.searchParams.get("CommitteeId");
      if (!committee) wrapperCalls++;
      return Promise.resolve(
        Response.json({
          source_url: body.url,
          markdown: "Fetched listing evidence",
          status_code: !committee && mode === "failed" ? 404 : 200,
          rawHtml: committee
            ? Array.from(
              { length: mode === "overflow" ? 5 : 1 },
              (_, i) =>
                `<a href="/ieListDocuments.aspx?MId=${
                  Number(committee) * 100 + i
                }">Meeting</a>`,
            ).join("")
            : '<a href="/documents/Minutes.pdf">Minutes</a>',
        }),
      );
    }) as typeof fetch;
    try {
      await baseline(db, {
        id: "scout",
        user_id: "owner",
        type: "civic",
        baseline_established_at: null,
        tracked_urls: (mode === "overflow" ? [1, 2] : [1]).map((i) =>
          `https://democracy.leeds.gov.uk/ieListMeetings.aspx?CommitteeId=${i}`
        ),
      });
    } catch (error) {
      failure = error;
    }
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of previous) {
      value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
    }
  }
  return { writes, wrapperCalls, failure };
}

for (const mode of ["failed", "overflow"] as const) {
  Deno.test(`creation baseline ${mode} refuses membership and readiness stamp`, async () => {
    const result = await exercise(mode);
    await assertRejects(
      () => Promise.reject(result.failure),
      Error,
      mode === "failed"
        ? "could not read civic meeting documents"
        : "budget exceeded",
    );
    assertEquals(result.wrapperCalls, mode === "failed" ? 1 : 0);
    assertEquals(
      result.writes.filter((write) =>
        write.path === "/rest/v1/civic_document_baselines"
      ),
      [],
    );
    assertEquals(
      result.writes.filter((write) => write.path === "/rest/v1/scouts"),
      [],
    );
    // Listing evidence is allowed, but an unsuccessful baseline is never
    // stamped ready for the caller's subsequent schedule_scout step.
    assertEquals(
      result.writes.every((write) => write.path === "/rest/v1/raw_captures"),
      true,
    );
  });
}
Deno.test("creation baseline success records discovered membership before readiness stamp", async () => {
  const result = await exercise("success");
  assertEquals(result.failure, undefined);
  assertEquals(result.wrapperCalls, 1);
  assertEquals(result.writes.map((write) => write.path), [
    "/rest/v1/raw_captures",
    "/rest/v1/civic_document_baselines",
    "/rest/v1/scouts",
  ]);
  assertEquals(
    typeof result.writes.at(-1)?.body.baseline_established_at,
    "string",
  );
});
