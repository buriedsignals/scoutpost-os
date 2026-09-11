import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  manifestHash,
  selectDocumentText,
  validateManifest,
  validateTargets,
} from "./civic-backfill.ts";

const targets = {
  user_id: "c6ac7e0c-35fd-48d0-9b76-7eb7acd48f2c",
  scout_id: "08d5e2f7-e238-44cd-bf89-01b8b7dd6946",
  date_from: "2026-01-01",
  date_to: "2026-09-11",
  documents: [{
    source_url: "https://council.example/minutes.pdf",
    listing_url: "https://council.example/meetings",
    document_date: "2026-02-04",
  }],
};
Deno.test("backfill targets reject unbounded, duplicate and invalid-date selections", () => {
  assertEquals(validateTargets(targets).documents.length, 1);
  for (
    const documents of [
      [],
      Array(11).fill(targets.documents[0]),
      Array(2).fill(targets.documents[0]),
      [{ ...targets.documents[0], document_date: "2026-02-30" }],
      [{ ...targets.documents[0], document_date: "2025-12-01" }],
      [{ ...targets.documents[0], source_url: "http://127.0.0.1/private" }],
    ]
  ) {
    assertThrows(() => validateTargets({ ...targets, documents }));
  }
});
Deno.test("backfill manifest detects tampered captured content and target deployment", async () => {
  const markdown = "Council adopted the published budget.";
  const digest = async (s: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
      ),
    ].map((b) => b.toString(16).padStart(2, "0")).join("");
  const manifest = {
    ...targets,
    version: 1,
    run_id: crypto.randomUUID(),
    supabase_url: "https://example.supabase.co",
    created_at: new Date().toISOString(),
    scout_snapshot: {
      tracked_urls: [targets.documents[0].listing_url],
      criteria: null,
      preferred_language: "en",
      project_id: null,
    },
    documents: [{
      ...targets.documents[0],
      markdown,
      content_sha256: await digest(markdown),
      title: null,
      doc_kind: "pdf",
    }],
  };
  const hash = await manifestHash(manifest);
  assertEquals(
    (await validateManifest(
      { ...manifest, manifest_hash: hash },
      manifest.supabase_url,
    )).run_id,
    manifest.run_id,
  );
  await assertRejects(() =>
    validateManifest(
      { ...manifest, manifest_hash: hash },
      "https://other.supabase.co",
    )
  );
  await assertRejects(() =>
    validateManifest({
      ...manifest,
      documents: [{ ...manifest.documents[0], markdown: "tampered" }],
      manifest_hash: hash,
    }, manifest.supabase_url)
  );
});

Deno.test("backfill refuses implicit leading-text truncation and records an exact excerpt", () => {
  const text = "index".repeat(10000) + "Council approved the bridge.";
  assertThrows(() => selectDocumentText(text));
  assertEquals(
    selectDocumentText(text, {
      start_character: 50000,
      end_character: text.length,
      label: "Bridge decision",
    }),
    "Council approved the bridge.",
  );
  assertThrows(() =>
    selectDocumentText(text, {
      start_character: 50000,
      end_character: text.length + 1,
      label: "Out of bounds",
    })
  );
});

Deno.test("backfill status verifies real revision links and refuses truncated evidence", async () => {
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2"
  );
  const { status } = await import("./civic-backfill.ts");
  let revisions: unknown[] = [];
  let truncated = false;
  const runId = crypto.randomUUID();
  const unitId = crypto.randomUUID();
  const queueId = crypto.randomUUID();
  const data: Record<string, unknown[]> = {
    civic_extraction_queue: [{
      id: queueId,
      source_url: targets.documents[0].source_url,
      status: "done",
      semantics_snapshot: {
        content_sha256: "hash",
        backfill_diagnostics: { persisted_count: 1 },
      },
    }],
    civic_queue_item_results: [{
      queue_id: queueId,
      unit_id: unitId,
      created_canonical: true,
      merged_existing: false,
      occurrence_created: true,
      request_identity: { p_type: "promise" },
    }],
    information_units: [{ id: unitId, type: "promise", deleted_at: null }],
    promises: [{
      id: "tracker",
      unit_id: unitId,
      active_revision_id: "revision",
      status: "new",
    }],
    unit_occurrences: [{
      id: "occurrence",
      unit_id: unitId,
      source_url: targets.documents[0].source_url,
      scout_id: targets.scout_id,
      scout_run_id: runId,
      scout_type: "civic",
      content_sha256: "hash",
    }],
    civic_run_alert_items: [],
  };
  const db = createClient("https://example.supabase.co", "test", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input.url,
        );
        const table = url.pathname.split("/").at(-1)!;
        assertEquals(url.searchParams.get("user_id"), `eq.${targets.user_id}`);
        if (table === "scout_runs") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: runId,
                status: "success",
                units_created_count: 1,
                units_merged_count: 0,
                notification_status: "not_applicable",
                metadata: {
                  ingestion_mode: "backfill",
                  manifest_hash: "manifest",
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        const rows = table === "promise_revisions" ? revisions : data[table];
        const count = rows.length +
          (truncated && table === "information_units" ? 1 : 0);
        return Promise.resolve(
          new Response(JSON.stringify(rows), {
            headers: {
              "Content-Type": "application/json",
              "Content-Range": `0-${Math.max(0, rows.length - 1)}/${count}`,
            },
          }),
        );
      },
    },
  });
  const m = {
    ...targets,
    version: 1 as const,
    run_id: runId,
    supabase_url: "https://example.supabase.co",
    created_at: new Date().toISOString(),
    scout_snapshot: {},
    manifest_hash: "manifest",
    documents: [{
      ...targets.documents[0],
      markdown: "text",
      content_sha256: "hash",
      source_content_sha256: "hash",
      source_characters: 4,
      title: null,
      doc_kind: "pdf" as const,
    }],
  };
  assertEquals((await status(db, m)).database_verified, false);
  revisions = [{ id: "revision", promise_id: "tracker" }];
  assertEquals((await status(db, m)).database_verified, true);
  const retainedLedger = data.civic_queue_item_results;
  data.civic_queue_item_results = [];
  assertEquals((await status(db, m)).database_verified, false);
  data.civic_queue_item_results = retainedLedger;
  truncated = true;
  await assertRejects(() => status(db, m), Error, "incomplete verification");
});
