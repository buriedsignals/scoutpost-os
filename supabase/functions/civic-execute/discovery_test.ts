import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
let handle: (request: Request) => Promise<Response>;
const originalServe = Deno.serve;
Deno.serve = ((handler: typeof handle) => {
  handle = handler;
  return {};
}) as typeof Deno.serve;
try {
  await import("./index.ts");
} finally {
  Deno.serve = originalServe;
}
const owner = "00000000-0000-4000-8000-000000000001";
const scoutId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
async function run(mode: "failed" | "overflow" | "success") {
  const settings: Record<string, string> = {
    SUPABASE_URL: "https://db.test",
    SUPABASE_SERVICE_ROLE_KEY: "fixture",
    INTERNAL_SERVICE_KEY: "fixture",
    SCRAPE_PROVIDER: "crawl4ai",
    SCRAPE_SERVICE_URL: "https://scrape.test",
    SCRAPE_SERVICE_TOKEN: "fixture",
    COJO_CREDITS_ENABLED: "false",
  };
  const previous = new Map(
    Object.keys(settings).map((key) => [key, Deno.env.get(key)]),
  );
  const originalFetch = globalThis.fetch;
  const captures: Record<string, unknown>[] = [];
  const queued: Record<string, unknown>[] = [];
  const runRow: Record<string, unknown> = {
    id: runId,
    status: "running",
    metadata: {},
  };
  const listings = mode === "overflow" ? [1, 2] : [1];
  const tracked = listings.map((i) =>
    `https://democracy.leeds.gov.uk/ieListMeetings.aspx?CommitteeId=${i}`
  );
  let wrappers = 0;
  let membershipWrites = 0;
  try {
    for (const [key, value] of Object.entries(settings)) {
      Deno.env.set(key, value);
    }
    globalThis.fetch = ((raw: unknown, init?: RequestInit) => {
      const url = new URL(String(raw));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      let result: unknown = [];
      if (url.hostname === "scrape.test") {
        const source = new URL(body.url);
        const listing = source.pathname.includes("ieListMeetings");
        if (!listing) wrappers++;
        const committee = Number(source.searchParams.get("CommitteeId") ?? "1");
        const html = listing
          ? Array.from(
            { length: mode === "overflow" ? 9 : 1 },
            (_, i) =>
              `<a href="/ieListDocuments.aspx?MId=${
                committee * 100 + i
              }">Meeting</a>`,
          ).join("")
          : mode === "success"
          ? '<a href="/documents/minutes.pdf?T=0">Minutes</a>'
          : "<p>No documents yet</p>";
        result = {
          source_url: body.url,
          markdown: "listing evidence",
          rawHtml: html,
          status_code: !listing && mode === "failed" ? 404 : 200,
        };
      } else if (url.pathname === "/rest/v1/scouts") {
        result = {
          id: scoutId,
          user_id: owner,
          name: "Fixture",
          type: "civic",
          regularity: "monthly",
          tracked_urls: tracked,
          baseline_established_at: "2026-08-01",
        };
      } else if (url.pathname === "/rest/v1/scout_runs") {
        if (method === "PATCH") Object.assign(runRow, body);
        result = runRow;
      } else if (url.pathname === "/rest/v1/raw_captures") {
        if (method === "POST") {
          captures.push(body);
        }
      } else if (url.pathname === "/rest/v1/civic_extraction_queue") {
        if (method === "POST") {
          queued.push(body);
        }
      } else if (url.pathname === "/rest/v1/civic_document_baselines") {
        if (method !== "GET") {
          membershipWrites++;
        }
      } else if (url.pathname === "/rest/v1/scout_run_events") result = [];
      else if (url.pathname.includes("/rpc/")) result = [];
      else throw new Error(`Unexpected network ${url}`);
      return Promise.resolve(
        Response.json(result, { headers: { "content-range": "0-0/0" } }),
      );
    }) as typeof fetch;
    const response = await handle(
      new Request("https://db.test/civic-execute", {
        method: "POST",
        headers: {
          "X-Service-Key": "fixture",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scout_id: scoutId, run_id: runId }),
      }),
    );
    return { response, captures, queued, runRow, wrappers, membershipWrites };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
    }
  }
}
Deno.test("scheduled wrapper failure preserves evidence without authoritative baseline or membership", async () => {
  const result = await run("failed");
  assertEquals(result.response.status, 500);
  assertEquals(result.captures.length, 1);
  assertEquals(result.captures[0].canonical_content_sha256, null);
  assertEquals(result.captures[0].content_md, "listing evidence");
  assertEquals(result.membershipWrites, 0);
  assertEquals(result.queued.length, 0);
  const metadata = result.runRow.metadata as {
    tracked_url_status: { status: string }[];
  };
  assertEquals(metadata.tracked_url_status[0].status, "scrape_failed");
});
Deno.test("scheduled multi-listing overflow fetches eight wrappers and reports incomplete inspection", async () => {
  const result = await run("overflow");
  assertEquals(result.response.status, 200);
  assertEquals(result.wrappers, 8);
  const metadata = result.runRow.metadata as {
    tracked_url_status: {
      meeting_budget_exceeded: boolean;
      meeting_pages_fetched: number;
    }[];
  };
  assertEquals(
    metadata.tracked_url_status.map((r) => r.meeting_budget_exceeded),
    [true, true],
  );
  assertEquals(
    metadata.tracked_url_status.map((r) => r.meeting_pages_fetched),
    [8, 0],
  );
});
Deno.test("scheduled successful wrapper queues query-string PDF with PDF document kind", async () => {
  const result = await run("success");
  assertEquals(result.response.status, 200);
  assertEquals(result.queued.length, 1);
  assertEquals(result.queued[0].doc_kind, "pdf");
  assertEquals(
    result.queued[0].source_url,
    "https://democracy.leeds.gov.uk/documents/minutes.pdf?T=0",
  );
  assertEquals(typeof result.captures[0].canonical_content_sha256, "string");
});
