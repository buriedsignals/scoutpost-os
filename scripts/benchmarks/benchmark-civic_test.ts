import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  benchmarkWeeklyCron,
  calendarSemanticFailure,
  CivicAuditRecordExt,
  civicCriticalFailures,
  classifyCivicQueueRows,
  renderCivicAuditReport,
  requireDataApiArray,
  resetCivicDocumentMembership,
  summarizeOutstandingCivicRows,
  unscheduleBenchmarkScout,
} from "./benchmark-civic.ts";
import {
  CIVIC_ACCOUNTABILITY_FIXTURES,
  CIVIC_FIXTURE_REFERENCE_DATE,
} from "./civic-accountability-fixtures.ts";
import { classifyCivicCandidate } from "../../supabase/functions/_shared/civic_accountability.ts";

Deno.test("civic benchmark reports the exact non-terminal queue lease", () => {
  assertEquals(
    summarizeOutstandingCivicRows([
      {
        id: "done-id",
        status: "done",
        attempts: 1,
        updated_at: "2026-07-20T09:40:00Z",
        last_error: null,
      },
      {
        id: "stuck-id",
        status: "processing",
        attempts: 2,
        updated_at: "2026-07-20T09:41:00Z",
        last_error: "provider timeout",
      },
    ]),
    [
      "stuck-id:processing:attempts=2:updated=2026-07-20T09:41:00Z:error=provider timeout",
    ],
  );
});

Deno.test("Zurich calendar is a semantic-zero hard negative", () => {
  assertEquals(calendarSemanticFailure(0), null);
  assertEquals(
    calendarSemanticFailure(1),
    "calendar hard-negative produced 1 promise tracker row(s)",
  );
});

Deno.test("Civic queue classification distinguishes no-op, terminal, and pending rows", () => {
  assertEquals(classifyCivicQueueRows([]), {
    totalRows: 0,
    terminalRows: 0,
    timedOut: false,
    outstanding: [],
    failed: [],
  });

  const terminal = [
    {
      id: "done-id",
      status: "done",
      attempts: 1,
      updated_at: "2026-08-10T10:00:00Z",
      last_error: null,
    },
    {
      id: "failed-id",
      status: "failed",
      attempts: 2,
      updated_at: "2026-08-10T10:01:00Z",
      last_error: "parse failed",
    },
  ];
  assertEquals(classifyCivicQueueRows(terminal), {
    totalRows: 2,
    terminalRows: 2,
    timedOut: false,
    outstanding: [],
    failed: [
      "failed-id:failed:attempts=2:updated=2026-08-10T10:01:00Z:error=parse failed",
    ],
  });
  assertEquals(
    classifyCivicQueueRows([{ ...terminal[0], status: "processing" }]),
    null,
  );
});

Deno.test("Civic Data API errors cannot masquerade as empty evidence", async () => {
  await assertRejects(
    () =>
      requireDataApiArray(
        new Response("database unavailable", { status: 503 }),
        "civic queue read",
      ),
    Error,
    "civic queue read 503",
  );
  await assertRejects(
    () =>
      requireDataApiArray(
        new Response('{"not":"an array"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "civic queue read",
      ),
    Error,
    "expected a JSON array",
  );
  await assertRejects(
    () =>
      requireDataApiArray(
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "civic queue read",
      ),
    Error,
    "returned invalid JSON",
  );
});

Deno.test("Civic benchmark resets only its disposable scout document membership", async () => {
  const calls: Array<{
    table: string;
    filter: Record<string, string>;
  }> = [];
  await resetCivicDocumentMembership(
    {} as never,
    "11111111-1111-4111-8111-111111111111",
    (_ctx, table, filter) => {
      calls.push({ table, filter });
      return Promise.resolve();
    },
  );
  assertEquals(calls, [{
    table: "civic_document_baselines",
    filter: { scout_id: "11111111-1111-4111-8111-111111111111" },
  }]);
});

Deno.test("Civic benchmark unschedules its disposable production Scout", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  await unscheduleBenchmarkScout(
    {
      supabaseUrl: "https://project.supabase.co",
      serviceKey: "service-key",
    } as never,
    "11111111-1111-4111-8111-111111111111",
    (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://project.supabase.co/rest/v1/rpc/unschedule_scout",
  );
  assertEquals(calls[0].init.method, "POST");
  assertEquals(
    new Headers(calls[0].init.headers).get("content-type"),
    "application/json",
  );
  assertEquals(
    calls[0].init.body,
    '{"p_scout_id":"11111111-1111-4111-8111-111111111111"}',
  );
});

Deno.test("Civic benchmark weekly cron cannot fire during creation", () => {
  assertEquals(
    benchmarkWeeklyCron(new Date("2026-08-10T08:00:00Z")),
    "0 8 * * TUE",
  );
});

Deno.test("Civic benchmark surfaces unschedule RPC failures", async () => {
  await assertRejects(
    () =>
      unscheduleBenchmarkScout(
        {
          supabaseUrl: "https://project.supabase.co",
          serviceKey: "service-key",
        } as never,
        "11111111-1111-4111-8111-111111111111",
        () =>
          Promise.resolve(
            new Response("missing function", { status: 404 }),
          ),
      ),
    Error,
    "unschedule benchmark Scout 404: missing function",
  );
});

Deno.test("Civic audit accepts queued semantic-zero and rejects zero queue", () => {
  const record: CivicAuditRecordExt = {
    permutation: "Zurich",
    category: "civic",
    source_mode: "reliable",
    scope: "location",
    queries_generated: 2,
    raw_results: 2,
    final_articles: 0,
    articles: [],
    summary: "",
    processing_time_ms: 1,
    error: null,
    quality_checks: [],
    discovery_count: 5,
    preview_documents: 5,
  };
  assertEquals(civicCriticalFailures([record]), []);
  assertEquals(civicCriticalFailures([{ ...record, queries_generated: 0 }]), [
    "Zurich: civic run queued zero documents from selected URL",
  ]);
  const report = renderCivicAuditReport([record], [], 1);
  assertStringIncludes(report, "# Civic Scout Audit Results");
  assertStringIncludes(
    report,
    "| Zurich | civic | reliable | 2 | 2 | 0 | 1 | OK (semantic zero) |",
  );
});

Deno.test("versioned Civic corpus meets minimum labels and policy outcomes", () => {
  const expectedCounts = { promise: 20, decision: 10, rejected: 30 };
  const actual = { promise: 0, decision: 0, rejected: 0 };
  for (const fixture of CIVIC_ACCOUNTABILITY_FIXTURES) {
    const result = classifyCivicCandidate(fixture.candidate, {
      today: CIVIC_FIXTURE_REFERENCE_DATE,
    });
    const actualKind = result.outcome === "eligible"
      ? result.item.kind
      : "rejected";
    assertEquals(actualKind, fixture.expected, fixture.id);
    actual[fixture.expected]++;
  }
  assertEquals(actual, expectedCounts);
  assertEquals(
    new Set(CIVIC_ACCOUNTABILITY_FIXTURES.map((fixture) => fixture.language)),
    new Set(["en", "de", "fr"]),
  );
});
