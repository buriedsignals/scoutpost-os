import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "./supabase.ts";
import {
  captureWebBaselineSnapshot,
  ensureWebBaseline,
  maybeInitializeMissingWebBaselineRun,
} from "./web_scout_baseline.ts";
import type { CaptureStoreContext } from "./snapshot_capture.ts";

function createFakeSvc() {
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{
    table: string;
    payload: unknown;
    column: string;
    value: unknown;
  }> = [];
  const rpcs: Array<{ name: string; args: unknown }> = [];

  const svc = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          inserts.push({ table, payload });
          return Promise.resolve({ error: null });
        },
        update(payload: unknown) {
          return {
            eq(column: string, value: unknown) {
              updates.push({ table, payload, column, value });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
    rpc(name: string, args: unknown) {
      rpcs.push({ name, args });
      return Promise.resolve({ error: null });
    },
  };

  return {
    svc,
    inserts,
    updates,
    rpcs,
  };
}

Deno.test("ensureWebBaseline stores canonical baseline state through the scrape port", async () => {
  const { svc, inserts, updates, rpcs } = createFakeSvc();

  const changed = await ensureWebBaseline(
    svc as unknown as SupabaseClient,
    {
      id: "scout-1",
      user_id: "user-1",
      url: "https://example.com",
      baseline_established_at: null,
    },
    {
      scrape: async () => ({
        markdown:
          "Initial baseline body\n\n[Existing child](https://example.com/news/existing)",
        source_url: "https://example.com",
        fetched_at: "2026-04-24T00:00:00Z",
        served_by: "crawl4ai" as const,
      }),
      hasCurrentCanonicalBaseline: async () => false,
      now: () => "2026-04-24T00:00:00Z",
    },
  );

  assertEquals(changed, true);
  assertEquals(inserts.map((entry) => entry.table), ["raw_captures"]);
  assertEquals(
    (inserts[0].payload as Record<string, unknown>).canonicalizer_version,
    "web-md-v1",
  );
  assertEquals(
    typeof (inserts[0].payload as Record<string, unknown>)
      .canonical_content_sha256,
    "string",
  );
  assertEquals(updates.map((entry) => entry.table), ["scouts"]);
  assertEquals(rpcs.map((entry) => entry.name), [
    "set_page_scout_initial_candidates_if_absent",
  ]);
  assertEquals(
    (rpcs[0].args as { p_candidates: string[] }).p_candidates,
    ["https://example.com/news/existing"],
  );
});

Deno.test("ensureWebBaseline no-ops when the scout already has a baseline", async () => {
  const { svc, inserts, updates } = createFakeSvc();

  const changed = await ensureWebBaseline(
    svc as unknown as SupabaseClient,
    {
      id: "scout-1",
      user_id: "user-1",
      url: "https://example.com",
      baseline_established_at: "2026-04-20T00:00:00Z",
    },
    {
      scrape: async () => {
        throw new Error("scrape must not run");
      },
      hasCurrentCanonicalBaseline: async () => true,
      now: () => "2026-04-24T00:00:00Z",
    },
  );

  assertEquals(changed, false);
  assertEquals(inserts.length, 0);
  assertEquals(updates.length, 0);
});

Deno.test("ensureWebBaseline reuses a valid capture when readiness timestamp is missing", async () => {
  const { svc, inserts, updates } = createFakeSvc();
  const changed = await ensureWebBaseline(
    svc as unknown as SupabaseClient,
    {
      id: "scout-ready",
      user_id: "user-1",
      url: "https://example.com",
      baseline_established_at: null,
    },
    {
      scrape: async () => {
        throw new Error("valid capture must not trigger a network fetch");
      },
      hasCurrentCanonicalBaseline: async () => true,
      now: () => "2026-04-24T00:00:00Z",
    },
  );

  assertEquals(changed, false);
  assertEquals(inserts.length, 0);
  assertEquals(updates.map((entry) => entry.table), ["scouts"]);
  assertEquals(
    (updates[0].payload as Record<string, unknown>).baseline_established_at,
    "2026-04-24T00:00:00Z",
  );
});

Deno.test("ensureWebBaseline repairs a timestamp without a valid canonical capture", async () => {
  const { svc, inserts, updates } = createFakeSvc();
  const changed = await ensureWebBaseline(
    svc as unknown as SupabaseClient,
    {
      id: "scout-stale",
      user_id: "user-1",
      url: "https://example.com",
      baseline_established_at: "2026-04-20T00:00:00Z",
    },
    {
      scrape: async () => ({
        markdown: "Repaired baseline",
        source_url: "https://example.com",
        fetched_at: "2026-04-24T00:00:00Z",
        served_by: "crawl4ai" as const,
      }),
      hasCurrentCanonicalBaseline: async () => false,
      now: () => "2026-04-24T00:00:00Z",
    },
  );
  assertEquals(changed, true);
  assertEquals(inserts.map((entry) => entry.table), ["raw_captures"]);
  assertEquals(updates.map((entry) => entry.table), ["scouts"]);
});

Deno.test("maybeInitializeMissingWebBaselineRun short-circuits first run to baseline-only", async () => {
  const { svc, inserts, updates, rpcs } = createFakeSvc();

  const result = await maybeInitializeMissingWebBaselineRun(
    svc as unknown as SupabaseClient,
    {
      id: "scout-1",
      user_id: "user-1",
      url: "https://example.com",
      baseline_established_at: null,
      name: "Planning Board",
    },
    "run-1",
    {
      scrape: async () => ({
        markdown: "Fresh canonical baseline",
        source_url: "https://example.com",
        fetched_at: "2026-04-24T00:00:00Z",
        served_by: "crawl4ai" as const,
      }),
      hasCurrentCanonicalBaseline: async () => false,
      now: () => "2026-04-24T00:00:00Z",
    },
  );

  assertEquals(result?.articles_count, 0);
  assertEquals(result?.merged_existing_count, 0);
  assertEquals(result?.criteria_ran, false);
  assertEquals(result?.baseline_initialized, true);
  assertEquals(result?.served_by, "crawl4ai");
  assertEquals(inserts.map((entry) => entry.table), ["raw_captures"]);
  assertEquals(updates.map((entry) => entry.table), ["scouts"]);
  assertEquals(
    (inserts[0].payload as Record<string, unknown>).scout_run_id,
    "run-1",
  );
  assertEquals(rpcs.map((entry) => entry.name), [
    "set_page_scout_initial_candidates_if_absent",
    "reset_scout_failures",
  ]);
});

Deno.test("PA-ROOT-001 archive-enabled creation snapshot keeps baseline kind and null run/capture provenance", async () => {
  const { svc } = createFakeSvc();
  const captured: CaptureStoreContext[] = [];
  const result = await captureWebBaselineSnapshot(
    svc as unknown as SupabaseClient,
    {
      id: "scout-archive",
      user_id: "user-archive",
      url: "https://example.com/news/",
      archive_enabled: true,
    },
    {
      scrape: async () => ({
        markdown: "Initial archived baseline",
        source_url: "https://example.com/news/",
        fetched_at: "2026-07-24T00:00:00Z",
        served_by: "crawl4ai" as const,
      }),
      now: () => "2026-07-24T00:00:00Z",
      resolveArchiveGate: async () => true,
      performArchiveCapture: async (_svc, ctx) => {
        captured.push(ctx);
        return { status: "stored:markdown_only" };
      },
      applyTrustLayer: async () => {
        throw new Error("no stored row means trust must not run");
      },
    },
  );
  assertEquals(result?.status, "stored:markdown_only");
  assertEquals(captured[0]?.captureKind, "baseline");
  assertEquals(captured[0]?.scoutRunId, null);
  assertEquals(captured[0]?.rawCaptureId, null);
  assertEquals(captured[0]?.requestedUrl, "https://example.com/news/");
  assertEquals(captured[0]?.allowedExactUrl, "https://example.com/news/");
});

Deno.test("baseline creation rejects an effective URL outside the configured page before persistence", async () => {
  const { svc, inserts, updates } = createFakeSvc();
  await assertRejects(
    () =>
      ensureWebBaseline(
        svc as unknown as SupabaseClient,
        {
          id: "scout-redirect",
          user_id: "user-redirect",
          url: "https://example.com/news/",
        },
        {
          scrape: async () => ({
            markdown: "Sibling content",
            source_url: "https://example.com/events/",
            fetched_at: "2026-07-24T00:00:00Z",
            served_by: "crawl4ai" as const,
          }),
          hasCurrentCanonicalBaseline: async () => false,
          now: () => "2026-07-24T00:00:00Z",
        },
      ),
    Error,
    "outside the configured URL",
  );
  assertEquals(inserts, []);
  assertEquals(updates, []);
});

Deno.test("baseline archive detection outside the configured page stores and trusts nothing", async () => {
  const { svc } = createFakeSvc();
  let captures = 0;
  let trusts = 0;
  const result = await captureWebBaselineSnapshot(
    svc as unknown as SupabaseClient,
    {
      id: "scout-redirect",
      user_id: "user-redirect",
      url: "https://example.com/news/",
      archive_enabled: true,
    },
    {
      scrape: async () => ({
        markdown: "Sibling content",
        source_url: "https://example.com/events/",
        fetched_at: "2026-07-24T00:00:00Z",
        served_by: "crawl4ai" as const,
      }),
      now: () => "2026-07-24T00:00:00Z",
      resolveArchiveGate: async () => true,
      performArchiveCapture: async () => {
        captures++;
        return { status: "stored" };
      },
      applyTrustLayer: async () => {
        trusts++;
        return {
          manifestPath: null,
          tsaStatus: "skipped",
          tsaPath: null,
          waybackStatus: "skipped",
          waybackUrl: null,
        };
      },
    },
  );
  assertEquals(result, null);
  assertEquals(captures, 0);
  assertEquals(trusts, 0);
});

Deno.test("baseline archive capture failure remains non-fatal", async () => {
  const { svc } = createFakeSvc();
  const result = await captureWebBaselineSnapshot(
    svc as unknown as SupabaseClient,
    {
      id: "scout-archive",
      user_id: "user-archive",
      url: "https://example.com/news/",
      archive_enabled: true,
    },
    {
      scrape: async () => ({
        markdown: "Initial archived baseline",
        source_url: "https://example.com/news/",
        fetched_at: "2026-07-24T00:00:00Z",
        served_by: "crawl4ai" as const,
      }),
      now: () => "2026-07-24T00:00:00Z",
      resolveArchiveGate: async () => true,
      performArchiveCapture: () => Promise.reject(new Error("archive down")),
    },
  );
  assertEquals(result, null);
});
