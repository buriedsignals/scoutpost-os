import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "./supabase.ts";
import { sha256Hex } from "./unit_dedup.ts";
import { loadCivicBackfillSnapshot } from "./civic_backfill_snapshot.ts";

Deno.test("backfill consumes only the tenant/scout/run/source matched pinned capture", async () => {
  const hash = await sha256Hex("Reviewed minutes");
  const filters: Record<string, unknown> = {};
  const capture = {
    id: "capture",
    content_md: "Reviewed minutes",
    content_sha256: hash,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const query = {
    select() {
      return this;
    },
    eq(k: string, v: unknown) {
      filters[k] = v;
      return this;
    },
    maybeSingle() {
      return Promise.resolve({ data: capture, error: null });
    },
  };
  const db = { from: () => query } as unknown as SupabaseClient;
  const snapshot = {
    tracked_urls: ["https://council.test/list"],
    criteria: null,
    preferred_language: "de",
    project_id: null,
  };
  const input = {
    userId: "user",
    scoutId: "scout",
    runId: "run",
    sourceUrl: "https://council.test/minutes",
    semantics: {
      scout_snapshot: snapshot,
      raw_capture_id: "capture",
      content_sha256: hash,
      title: "Minutes",
    },
    scout: { ...snapshot, user_id: "user", type: "civic", is_active: true },
  };
  assertEquals(await loadCivicBackfillSnapshot(db, input), {
    rawCaptureId: "capture",
    markdown: "Reviewed minutes",
    title: "Minutes",
  });
  assertEquals(filters, {
    id: "capture",
    user_id: "user",
    scout_id: "scout",
    scout_run_id: "run",
    source_url: input.sourceUrl,
  });
  await assertRejects(
    () =>
      loadCivicBackfillSnapshot(db, {
        ...input,
        scout: { ...input.scout, is_active: false },
      }),
    Error,
    "paused",
  );
  await assertRejects(
    () =>
      loadCivicBackfillSnapshot(db, {
        ...input,
        scout: { ...input.scout, user_id: "foreign" },
      }),
    Error,
    "foreign",
  );
  await assertRejects(
    () =>
      loadCivicBackfillSnapshot(db, {
        ...input,
        scout: { ...input.scout, criteria: "Changed" },
      }),
    Error,
    "configuration changed",
  );
  capture.content_md = "Tampered";
  await assertRejects(
    () => loadCivicBackfillSnapshot(db, input),
    Error,
    "hash mismatched",
  );
  capture.content_md = "Reviewed minutes";
  capture.expires_at = new Date(Date.now() - 1000).toISOString();
  await assertRejects(
    () => loadCivicBackfillSnapshot(db, input),
    Error,
    "expired",
  );
});
