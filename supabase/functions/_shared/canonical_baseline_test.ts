import {
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "./supabase.ts";
import {
  hashChangeStatusForUrl,
  writeCanonicalBaseline,
} from "./canonical_baseline.ts";
import {
  WEB_CANONICALIZER_VERSION,
  webCanonicalHash,
} from "./web_content_canonical.ts";

interface Capture {
  id: string;
  scout_run_id: string | null;
  content_sha256: string | null;
  content_md: string | null;
  canonical_content_sha256: string | null;
  canonicalizer_version: string | null;
  source_url?: string;
}

function fakeSvc(opts: {
  captures?: Capture[];
  runs?: Array<{ id: string; status: string }>;
  captureError?: boolean;
  runsError?: boolean;
  insertError?: boolean;
}) {
  const eqFilters: Record<string, unknown> = {};
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: unknown; payload: Record<string, unknown> }> = [];

  const svc = {
    from(table: string) {
      if (table === "raw_captures") {
        return {
          select() {
            const builder = {
              _eq: {} as Record<string, unknown>,
              _notNull: [] as string[],
              eq(col: string, val: unknown) {
                this._eq[col] = val;
                eqFilters[col] = val;
                return this;
              },
              not(col: string, op: string, val: unknown) {
                // Only the "<col> IS NOT NULL" form is used by the code.
                if (op === "is" && val === null) this._notNull.push(col);
                return this;
              },
              order() {
                return this;
              },
              limit() {
                if (opts.captureError) {
                  return Promise.resolve({ data: null, error: { message: "boom" } });
                }
                // apply source_url filter if present
                let rows = opts.captures ?? [];
                if (this._eq.source_url) {
                  rows = rows.filter((c) => c.source_url === this._eq.source_url);
                }
                for (const col of this._notNull) {
                  rows = rows.filter(
                    (c) => (c as unknown as Record<string, unknown>)[col] != null,
                  );
                }
                return Promise.resolve({ data: rows, error: null });
              },
            };
            return builder;
          },
          insert(payload: Record<string, unknown>) {
            inserts.push(payload);
            return Promise.resolve({
              error: opts.insertError ? { message: "insert failed" } : null,
            });
          },
          update(payload: Record<string, unknown>) {
            return {
              eq(_col: string, val: unknown) {
                updates.push({ id: val, payload });
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      if (table === "scout_runs") {
        return {
          select() {
            return {
              in() {
                if (opts.runsError) {
                  return Promise.resolve({ data: null, error: { message: "runs boom" } });
                }
                return Promise.resolve({ data: opts.runs ?? [], error: null });
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { svc: svc as unknown as SupabaseClient, eqFilters, inserts, updates };
}

async function canonicalOf(md: string): Promise<string> {
  return await webCanonicalHash(md);
}

Deno.test("hashChangeStatusForUrl returns new on empty markdown", async () => {
  const { svc } = fakeSvc({});
  assertEquals(await hashChangeStatusForUrl(svc, "s1", "   "), "new");
});

Deno.test("hashChangeStatusForUrl returns new when no baseline exists", async () => {
  const { svc } = fakeSvc({ captures: [] });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", "hello world"), "new");
});

Deno.test("hashChangeStatusForUrl returns new on capture query error", async () => {
  const { svc } = fakeSvc({ captureError: true });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", "hello world"), "new");
});

Deno.test("hashChangeStatusForUrl returns same on canonical match", async () => {
  const md = "Council agenda item one";
  const { svc } = fakeSvc({
    captures: [{
      id: "c1",
      scout_run_id: null,
      content_sha256: null,
      content_md: null,
      canonical_content_sha256: await canonicalOf(md),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
    }],
  });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", md), "same");
});

Deno.test("hashChangeStatusForUrl returns changed on canonical mismatch", async () => {
  const { svc } = fakeSvc({
    captures: [{
      id: "c1",
      scout_run_id: null,
      content_sha256: null,
      content_md: null,
      canonical_content_sha256: await canonicalOf("old content"),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
    }],
  });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", "new content"), "changed");
});

Deno.test("hashChangeStatusForUrl only counts baselines from successful runs", async () => {
  const md = "same text";
  const { svc } = fakeSvc({
    captures: [
      // newest is from a FAILED run → must be ignored
      {
        id: "c2",
        scout_run_id: "run-fail",
        content_sha256: null,
        content_md: null,
        canonical_content_sha256: await canonicalOf("different"),
        canonicalizer_version: WEB_CANONICALIZER_VERSION,
      },
      // older is from a SUCCESSFUL run → the usable baseline
      {
        id: "c1",
        scout_run_id: "run-ok",
        content_sha256: null,
        content_md: null,
        canonical_content_sha256: await canonicalOf(md),
        canonicalizer_version: WEB_CANONICALIZER_VERSION,
      },
    ],
    runs: [
      { id: "run-fail", status: "error" },
      { id: "run-ok", status: "success" },
    ],
  });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", md), "same");
});

Deno.test("hashChangeStatusForUrl filters baselines by source_url (civic)", async () => {
  const mdA = "page A content";
  const { svc, eqFilters } = fakeSvc({
    captures: [
      {
        id: "cB",
        scout_run_id: null,
        content_sha256: null,
        content_md: null,
        canonical_content_sha256: await canonicalOf("page B content"),
        canonicalizer_version: WEB_CANONICALIZER_VERSION,
        source_url: "https://gov.example/B",
      },
      {
        id: "cA",
        scout_run_id: null,
        content_sha256: null,
        content_md: null,
        canonical_content_sha256: await canonicalOf(mdA),
        canonicalizer_version: WEB_CANONICALIZER_VERSION,
        source_url: "https://gov.example/A",
      },
    ],
  });
  // Only the same-URL baseline (cA) is compared → "same" for A's content,
  // proving B's baseline did not leak into A's comparison.
  const status = await hashChangeStatusForUrl(svc, "s1", mdA, {
    sourceUrl: "https://gov.example/A",
  });
  assertEquals(status, "same");
  assertEquals(eqFilters.source_url, "https://gov.example/A");
});

Deno.test("hashChangeStatusForUrl (civic) ignores non-canonical worker captures", async () => {
  // civic-extract-worker inserts a truncated document capture into the SAME
  // (scout_id, source_url) namespace with no canonical hash. It sorts newest
  // by captured_at but MUST NOT shadow the real per-URL baseline.
  const md = "council page current content";
  const { svc } = fakeSvc({
    captures: [
      // Newest row: a worker capture — truncated content_md, NO canonical hash.
      {
        id: "worker",
        scout_run_id: null,
        content_sha256: null,
        content_md: "truncated extracted document text…",
        canonical_content_sha256: null,
        canonicalizer_version: null,
        source_url: "https://gov.example/page",
      },
      // Older row: the real baseline written by writeCanonicalBaseline.
      {
        id: "baseline",
        scout_run_id: null,
        content_sha256: null,
        content_md: null,
        canonical_content_sha256: await canonicalOf(md),
        canonicalizer_version: WEB_CANONICALIZER_VERSION,
        source_url: "https://gov.example/page",
      },
    ],
  });
  // Same content as the real baseline → "same"; the worker row is filtered out
  // by the canonical-only predicate, so it can't force a spurious "changed".
  const status = await hashChangeStatusForUrl(svc, "s1", md, {
    sourceUrl: "https://gov.example/page",
  });
  assertEquals(status, "same");
});

Deno.test("hashChangeStatusForUrl migrates an old content_md baseline on read", async () => {
  const md = "legacy body";
  const { svc, updates } = fakeSvc({
    captures: [{
      id: "c1",
      scout_run_id: null,
      content_sha256: null,
      content_md: md, // only raw content, no canonical hash yet
      canonical_content_sha256: null,
      canonicalizer_version: null,
    }],
  });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", md), "same");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].id, "c1");
  assertEquals(
    (updates[0].payload as Record<string, unknown>).canonicalizer_version,
    WEB_CANONICALIZER_VERSION,
  );
});

Deno.test("hashChangeStatusForUrl falls back to raw hash for ancient captures", async () => {
  const { sha256Hex } = await import("./unit_dedup.ts");
  const md = "ancient";
  const { svc } = fakeSvc({
    captures: [{
      id: "c1",
      scout_run_id: null,
      content_sha256: await sha256Hex(md),
      content_md: "", // blank → skips the migrate-on-read branch
      canonical_content_sha256: null,
      canonicalizer_version: null,
    }],
  });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", md), "same");
});

Deno.test("hashChangeStatusForUrl returns new when the only baseline is from a failed run", async () => {
  const { svc } = fakeSvc({
    captures: [{
      id: "c1",
      scout_run_id: "run-x",
      content_sha256: null,
      content_md: null,
      canonical_content_sha256: await canonicalOf("x"),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
    }],
    runs: [{ id: "run-x", status: "error" }],
  });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", "x"), "new");
});

Deno.test("hashChangeStatusForUrl treats content as new baseline when run-status lookup errors", async () => {
  // scout_runs query fails → successfulRunIds stays empty → a capture from a
  // run is not usable → "new" (logs a warning, does not throw).
  const { svc } = fakeSvc({
    captures: [{
      id: "c1",
      scout_run_id: "run-x",
      content_sha256: null,
      content_md: null,
      canonical_content_sha256: await canonicalOf("x"),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
    }],
    runsError: true,
  });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", "x"), "new");
});

Deno.test("hashChangeStatusForUrl migrate-on-read returns changed on mismatch", async () => {
  const { svc, updates } = fakeSvc({
    captures: [{
      id: "c1",
      scout_run_id: null,
      content_sha256: null,
      content_md: "old legacy body",
      canonical_content_sha256: null,
      canonicalizer_version: null,
    }],
  });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", "brand new body"), "changed");
  assertEquals(updates.length, 1); // still migrates the old row
});

Deno.test("hashChangeStatusForUrl raw-hash fallback returns changed on mismatch", async () => {
  const { sha256Hex } = await import("./unit_dedup.ts");
  const { svc } = fakeSvc({
    captures: [{
      id: "c1",
      scout_run_id: null,
      content_sha256: await sha256Hex("old"),
      content_md: "",
      canonical_content_sha256: null,
      canonicalizer_version: null,
    }],
  });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", "new"), "changed");
});

Deno.test("writeCanonicalBaseline inserts a canonical capture", async () => {
  const { svc, inserts } = fakeSvc({});
  await writeCanonicalBaseline(svc, {
    userId: "u1",
    scoutId: "s1",
    sourceUrl: "https://gov.example/page",
    markdown: "meeting minutes",
    scoutRunId: "run-1",
  });
  assertEquals(inserts.length, 1);
  const row = inserts[0];
  assertEquals(row.scout_id, "s1");
  assertEquals(row.source_url, "https://gov.example/page");
  assertEquals(row.scout_run_id, "run-1");
  assertEquals(row.canonicalizer_version, WEB_CANONICALIZER_VERSION);
  assertEquals(
    row.canonical_content_sha256,
    await canonicalOf("meeting minutes"),
  );
});

Deno.test("writeCanonicalBaseline defaults run id to null and tolerates an odd now", async () => {
  const { svc, inserts } = fakeSvc({});
  await writeCanonicalBaseline(svc, {
    userId: "u1",
    scoutId: "s1",
    sourceUrl: "https://gov.example/p",
    markdown: "x",
    now: "not-a-real-date", // exercises the NaN → Date.now() expiry fallback
  });
  assertEquals(inserts[0].scout_run_id, null);
  assertEquals(typeof inserts[0].expires_at, "string");
});

Deno.test("writeCanonicalBaseline throws on insert error", async () => {
  const { svc } = fakeSvc({ insertError: true });
  let threw = false;
  try {
    await writeCanonicalBaseline(svc, {
      userId: "u1",
      scoutId: "s1",
      sourceUrl: "https://gov.example/p",
      markdown: "x",
    });
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message, "insert failed");
  }
  assertEquals(threw, true);
});
