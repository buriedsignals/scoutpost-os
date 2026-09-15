import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "./supabase.ts";
import {
  buildCanonicalBaselineRow,
  compareCanonicalContentForUrl,
  hasCurrentCanonicalBaselineForUrl,
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
  comparison_md?: string | null;
  comparison_strategy?: string | null;
  canonical_content_sha256: string | null;
  canonicalizer_version: string | null;
  source_url?: string;
  page_response_status?: number | null;
  page_validation_version?: string | null;
  page_validation_outcome?:
    | "valid"
    | "error_page"
    | "target_http_error"
    | "empty_content";
}

function fakeSvc(opts: {
  captures?: Capture[];
  runs?: Array<{ id: string; status: string }>;
  captureDataNull?: boolean;
  runsDataNull?: boolean;
  captureError?: boolean;
  runsError?: boolean;
  insertError?: boolean;
  updateError?: boolean;
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
              range(start: number, end: number) {
                return this.limit(end - start + 1, start);
              },
              limit(count = 50, offset = 0) {
                if (opts.captureError) {
                  return Promise.resolve({
                    data: null,
                    error: { message: "boom" },
                  });
                }
                // apply source_url filter if present
                let rows = opts.captures ?? [];
                if (this._eq.source_url) {
                  rows = rows.filter((c) =>
                    c.source_url === this._eq.source_url
                  );
                }
                if (this._eq.canonicalizer_version) {
                  rows = rows.filter((c) =>
                    c.canonicalizer_version ===
                      this._eq.canonicalizer_version
                  );
                }
                for (const col of this._notNull) {
                  rows = rows.filter(
                    (c) =>
                      (c as unknown as Record<string, unknown>)[col] != null,
                  );
                }
                return Promise.resolve({
                  data: opts.captureDataNull
                    ? null
                    : rows.slice(offset, offset + count),
                  error: null,
                });
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
                return Promise.resolve({
                  error: opts.updateError
                    ? { message: "classification write failed" }
                    : null,
                });
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
                  return Promise.resolve({
                    data: null,
                    error: { message: "runs boom" },
                  });
                }
                return Promise.resolve({
                  data: opts.runsDataNull ? null : opts.runs ?? [],
                  error: null,
                });
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

Deno.test("current canonical baseline accepts a schedule-time capture", async () => {
  const { svc } = fakeSvc({
    captures: [{
      id: "baseline",
      scout_run_id: null,
      content_sha256: null,
      content_md: "baseline",
      canonical_content_sha256: "hash",
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
      source_url: "https://example.test/page",
    }],
  });
  assertEquals(
    await hasCurrentCanonicalBaselineForUrl(
      svc,
      "s1",
      "https://example.test/page",
    ),
    true,
  );
});

Deno.test("current canonical baseline rejects a missing capture", async () => {
  assertEquals(
    await hasCurrentCanonicalBaselineForUrl(
      fakeSvc({ captures: [] }).svc,
      "s1",
      "https://example.test/page",
    ),
    false,
  );
  assertEquals(
    await hasCurrentCanonicalBaselineForUrl(
      fakeSvc({ captureDataNull: true }).svc,
      "s1",
      "https://example.test/page",
    ),
    false,
  );
});

Deno.test("current canonical baseline requires a successful linked run", async () => {
  const capture: Capture = {
    id: "baseline",
    scout_run_id: "run-1",
    content_sha256: null,
    content_md: "baseline",
    canonical_content_sha256: "hash",
    canonicalizer_version: WEB_CANONICALIZER_VERSION,
    source_url: "https://example.test/page",
  };
  const successful = fakeSvc({
    captures: [capture],
    runs: [{ id: "run-1", status: "success" }],
  });
  assertEquals(
    await hasCurrentCanonicalBaselineForUrl(
      successful.svc,
      "s1",
      "https://example.test/page",
    ),
    true,
  );

  const failed = fakeSvc({
    captures: [capture],
    runs: [{ id: "run-1", status: "error" }],
  });
  assertEquals(
    await hasCurrentCanonicalBaselineForUrl(
      failed.svc,
      "s1",
      "https://example.test/page",
    ),
    false,
  );
  const missingRuns = fakeSvc({ captures: [capture], runsDataNull: true });
  assertEquals(
    await hasCurrentCanonicalBaselineForUrl(
      missingRuns.svc,
      "s1",
      "https://example.test/page",
    ),
    false,
  );
});

Deno.test("current canonical baseline fails closed on lookup errors", async () => {
  const capture: Capture = {
    id: "baseline",
    scout_run_id: "run-1",
    content_sha256: null,
    content_md: "baseline",
    canonical_content_sha256: "hash",
    canonicalizer_version: WEB_CANONICALIZER_VERSION,
    source_url: "https://example.test/page",
  };
  await assertRejects(
    () =>
      hasCurrentCanonicalBaselineForUrl(
        fakeSvc({ captureError: true }).svc,
        "s1",
        "https://example.test/page",
      ),
    Error,
    "canonical baseline lookup failed",
  );
  await assertRejects(
    () =>
      hasCurrentCanonicalBaselineForUrl(
        fakeSvc({ captures: [capture], runsError: true }).svc,
        "s1",
        "https://example.test/page",
      ),
    Error,
    "canonical baseline run-status lookup failed",
  );
});

Deno.test("hashChangeStatusForUrl returns new when no baseline exists", async () => {
  const { svc } = fakeSvc({ captures: [] });
  assertEquals(await hashChangeStatusForUrl(svc, "s1", "hello world"), "new");
});

Deno.test("hashChangeStatusForUrl fails closed on capture query error", async () => {
  const { svc } = fakeSvc({ captureError: true });
  await assertRejects(
    () => hashChangeStatusForUrl(svc, "s1", "hello world"),
    Error,
    "canonical baseline lookup failed",
  );
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
  assertEquals(
    await hashChangeStatusForUrl(svc, "s1", "new content"),
    "changed",
  );
});

Deno.test("compareCanonicalContentForUrl returns the exact successful prior content", async () => {
  const previous = "Registration opens 1 August";
  const { svc } = fakeSvc({
    captures: [{
      id: "baseline",
      scout_run_id: "run-ok",
      content_sha256: null,
      content_md: previous,
      canonical_content_sha256: await canonicalOf(previous),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
      source_url: "https://example.test/event",
    }],
    runs: [{ id: "run-ok", status: "success" }],
  });
  assertEquals(
    await compareCanonicalContentForUrl(
      svc,
      "s1",
      "Registration opens 15 August",
      { sourceUrl: "https://example.test/event" },
    ),
    {
      status: "changed",
      previousMarkdown: previous,
      previousFullMarkdown: previous,
      previousCaptureId: "baseline",
      comparisonStrategyChanged: false,
      successfulMarkdownHistory: [previous],
    },
  );
});

Deno.test("compareCanonicalContentForUrl compares the focused document but retains the full capture", async () => {
  const previousFull = "Navigation\nPolicy before\nFooter";
  const previousComparison = "Policy before";
  const { svc } = fakeSvc({
    captures: [{
      id: "focused-baseline",
      scout_run_id: null,
      content_sha256: null,
      content_md: previousFull,
      comparison_md: previousComparison,
      comparison_strategy: "main",
      canonical_content_sha256: await canonicalOf(previousComparison),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
    }],
  });

  assertEquals(
    await compareCanonicalContentForUrl(svc, "s1", "Policy after", {
      comparisonStrategy: "main",
    }),
    {
      status: "changed",
      previousMarkdown: previousComparison,
      previousFullMarkdown: previousFull,
      previousCaptureId: "focused-baseline",
      comparisonStrategyChanged: false,
      successfulMarkdownHistory: [previousComparison],
    },
  );
});

Deno.test("a full-to-focused strategy switch silently establishes a comparable baseline", async () => {
  const previousFull = "Navigation before\nPolicy before\nFooter before";
  const { svc } = fakeSvc({
    captures: [{
      id: "full-baseline",
      scout_run_id: null,
      content_sha256: null,
      content_md: previousFull,
      comparison_md: null,
      comparison_strategy: "full",
      canonical_content_sha256: await canonicalOf(previousFull),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
    }],
  });

  const comparison = await compareCanonicalContentForUrl(
    svc,
    "s1",
    "Policy after",
    { comparisonStrategy: "main" },
  );
  assertEquals(comparison.status, "same");
  assertEquals(comparison.comparisonStrategyChanged, true);
  assertEquals(comparison.previousFullMarkdown, previousFull);
});

Deno.test("alternating main and provider_main captures keep later changes on same-strategy history", async () => {
  const mainBefore = "Main policy before";
  const providerBefore = "Provider policy before";
  const { svc } = fakeSvc({
    captures: [
      {
        id: "provider-newest",
        scout_run_id: "run-provider",
        content_sha256: null,
        content_md: "provider full",
        comparison_md: providerBefore,
        comparison_strategy: "provider_main",
        canonical_content_sha256: await canonicalOf(providerBefore),
        canonicalizer_version: WEB_CANONICALIZER_VERSION,
      },
      {
        id: "main-prior",
        scout_run_id: "run-main",
        content_sha256: null,
        content_md: "main full",
        comparison_md: mainBefore,
        comparison_strategy: "main",
        canonical_content_sha256: await canonicalOf(mainBefore),
        canonicalizer_version: WEB_CANONICALIZER_VERSION,
      },
    ],
    runs: [
      { id: "run-provider", status: "success" },
      { id: "run-main", status: "success" },
    ],
  });

  const comparison = await compareCanonicalContentForUrl(
    svc,
    "s1",
    "Main policy after",
    { comparisonStrategy: "main" },
  );
  assertEquals(comparison.status, "changed");
  assertEquals(comparison.previousCaptureId, "main-prior");
  assertEquals(comparison.previousMarkdown, mainBefore);
  assertEquals(comparison.comparisonStrategyChanged, false);
});

Deno.test("a v1-to-focused cutover is silent because the old semantic document cannot be reconstructed", async () => {
  const { svc, updates } = fakeSvc({
    captures: [{
      id: "v1-baseline",
      scout_run_id: null,
      content_sha256: null,
      content_md: "Navigation before\nPolicy before\nFooter before",
      comparison_md: null,
      comparison_strategy: null,
      canonical_content_sha256: await canonicalOf("old v1 document"),
      canonicalizer_version: "web-md-v1",
    }],
  });

  const comparison = await compareCanonicalContentForUrl(
    svc,
    "s1",
    "Policy after",
    { comparisonStrategy: "main" },
  );
  assertEquals(comparison.status, "same");
  assertEquals(comparison.comparisonStrategyChanged, true);
  assertEquals(updates, []);
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

Deno.test("hashChangeStatusForUrl fails closed when run-status lookup errors", async () => {
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
  await assertRejects(
    () => hashChangeStatusForUrl(svc, "s1", "x"),
    Error,
    "canonical baseline run-status lookup failed",
  );
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
  assertEquals(
    await hashChangeStatusForUrl(svc, "s1", "brand new body"),
    "changed",
  );
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
  assertEquals(row.comparison_md, null);
  assertEquals(row.comparison_strategy, "full");
});

Deno.test("buildCanonicalBaselineRow returns the canonical focused row shape", async () => {
  const row = await buildCanonicalBaselineRow({
    userId: "u1",
    scoutId: "s1",
    sourceUrl: "https://Example.Test/policy",
    markdown: "Navigation\nPolicy body\nFooter",
    comparisonMarkdown: "Policy body",
    comparisonStrategy: "main",
    now: "2026-08-17T12:00:00.000Z",
  });

  assertEquals(row.source_domain, "example.test");
  assertEquals(row.scout_run_id, null);
  assertEquals(row.comparison_md, "Policy body");
  assertEquals(row.comparison_strategy, "main");
  assertEquals(row.canonical_content_sha256, await canonicalOf("Policy body"));
  assertEquals(row.canonicalizer_version, WEB_CANONICALIZER_VERSION);
  assertEquals(row.captured_at, "2026-08-17T12:00:00.000Z");
  assertEquals(row.expires_at, "2026-09-16T12:00:00.000Z");
});

Deno.test("writeCanonicalBaseline stores full evidence separately from focused comparison content", async () => {
  const { svc, inserts } = fakeSvc({});
  await writeCanonicalBaseline(svc, {
    userId: "u1",
    scoutId: "s1",
    sourceUrl: "https://example.test/policy",
    markdown: "Navigation\nPolicy body\nFooter",
    comparisonMarkdown: "Policy body",
    comparisonStrategy: "main",
  });

  const row = inserts[0];
  assertEquals(row.content_md, "Navigation\nPolicy body\nFooter");
  assertEquals(row.comparison_md, "Policy body");
  assertEquals(row.comparison_strategy, "main");
  assertEquals(row.canonical_content_sha256, await canonicalOf("Policy body"));
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

Deno.test("Page readiness and comparison skip invalid legacy captures without erasing evidence", async () => {
  const url = "https://transparency.meta.com/policies/brandedcontent/";
  const errorBody =
    "[![Meta](https://static.xx.fbcdn.net/rsrc.php/y9/r/tL_v571NdZ0.svg)](https://transparency.meta.com/)\nThis page isn't available\nThe link may be broken, or the page may have been removed. Check to see if the link you're trying to open is correct.\n[Back to Transparency Center](https://transparency.meta.com/)\n";
  const good: Capture = {
    id: "previous-valid",
    scout_run_id: null,
    source_url: url,
    content_md: "Policy remains in effect.",
    content_sha256: null,
    canonical_content_sha256: await canonicalOf("Policy remains in effect."),
    canonicalizer_version: WEB_CANONICALIZER_VERSION,
  };
  // More than a query page of invalid newer rows cannot mask the older page.
  const invalid = Array.from({ length: 51 }, (_, index) => ({
    ...good,
    id: `invalid-${index}`,
    content_md: errorBody,
    canonical_content_sha256: "error-hash",
  }));
  const { svc, updates } = fakeSvc({ captures: [...invalid, good] });
  assertEquals(await hasCurrentCanonicalBaselineForUrl(svc, "s1", url), true);
  const comparison = await compareCanonicalContentForUrl(
    svc,
    "s1",
    good.content_md!,
    { sourceUrl: url, validityMode: "page" },
  );
  assertEquals(comparison.status, "same");
  assertEquals(comparison.previousCaptureId, good.id);
  assertEquals(comparison.successfulMarkdownHistory, [good.content_md]);
  assertEquals(
    updates.filter((update) => update.id === "invalid-0")
      .every((update) =>
        update.payload.page_validation_outcome === "error_page"
      ),
    true,
  );
  assertEquals(invalid[0].content_md, errorBody);
});

Deno.test("Page legacy body without status is validated instead of trusting its hash", async () => {
  const url = "https://example.test/page";
  const capture: Capture = {
    id: "empty-legacy",
    scout_run_id: null,
    source_url: url,
    content_md: null,
    content_sha256: await canonicalOf("OK"),
    canonical_content_sha256: await canonicalOf("OK"),
    canonicalizer_version: WEB_CANONICALIZER_VERSION,
  };
  const { svc } = fakeSvc({ captures: [capture] });
  assertEquals(await hasCurrentCanonicalBaselineForUrl(svc, "s1", url), false);
  assertEquals(
    (await compareCanonicalContentForUrl(svc, "s1", "OK", {
      sourceUrl: url,
      validityMode: "page",
    })).status,
    "new",
  );
  // Default Civic consumers still use the stored canonical hash.
  assertEquals(
    await hashChangeStatusForUrl(svc, "s1", "OK", { sourceUrl: url }),
    "same",
  );
});

Deno.test("Page writes reject target failures even with a legitimate focused projection", async () => {
  const { svc, inserts } = fakeSvc({});
  await assertRejects(() =>
    writeCanonicalBaseline(svc, {
      userId: "u1",
      scoutId: "s1",
      sourceUrl: "https://example.test/page",
      markdown: "Not found",
      comparisonMarkdown: "Valid looking projection",
      comparisonStrategy: "main",
      validityMode: "page",
      pageResponse: { status_code: 404 },
    })
  );
  assertEquals(inserts, []);
  await assertRejects(() =>
    compareCanonicalContentForUrl(svc, "s1", "Projection", {
      validityMode: "page",
      pageResponse: { markdown: "Not found", status_code: 404 },
    })
  );
});

Deno.test("Page valid short capture persists reusable validation and unknown status", async () => {
  const { svc, inserts } = fakeSvc({});
  await writeCanonicalBaseline(svc, {
    userId: "u1",
    scoutId: "s1",
    sourceUrl: "https://example.test/page",
    markdown: "OK",
    validityMode: "page",
  });
  const stored = inserts[0];
  const reader = fakeSvc({
    captures: [{ ...stored, id: "written" } as unknown as Capture],
  });
  assertEquals(
    await hasCurrentCanonicalBaselineForUrl(
      reader.svc,
      "s1",
      "https://example.test/page",
    ),
    true,
  );
  assertEquals(reader.updates, []);
});

Deno.test("Page readiness reuses validated legacy content while comparison migrates its canonicalizer", async () => {
  const url = "https://example.test/policy";
  const legacy: Capture = {
    id: "legacy",
    scout_run_id: null,
    source_url: url,
    content_md: "Navigation\nPolicy is in force.\nFooter",
    content_sha256: null,
    comparison_md: "Policy is in force.",
    comparison_strategy: "main",
    canonical_content_sha256: "old-canonical-hash",
    canonicalizer_version: "web-md-v1",
  };
  const { svc } = fakeSvc({ captures: [legacy] });
  assertEquals(await hasCurrentCanonicalBaselineForUrl(svc, "s1", url), true);
  const comparison = await compareCanonicalContentForUrl(
    svc,
    "s1",
    "Policy is in force.",
    { sourceUrl: url, validityMode: "page", comparisonStrategy: "main" },
  );
  assertEquals(comparison.status, "same");
  assertEquals(comparison.previousCaptureId, "legacy");
  assertEquals(comparison.comparisonStrategyChanged, false);
});

Deno.test("Page comparison excludes failed-run content even when it already passed validation", async () => {
  const { svc } = fakeSvc({
    captures: [{
      id: "failed",
      scout_run_id: "run-failed",
      content_md: "Policy changed",
      content_sha256: null,
      canonical_content_sha256: await canonicalOf("Policy changed"),
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
      page_validation_version: "page-response-v1",
      page_validation_outcome: "valid",
    }],
    runs: [{ id: "run-failed", status: "error" }],
  });
  const comparison = await compareCanonicalContentForUrl(
    svc,
    "s1",
    "Policy changed",
    {
      validityMode: "page",
    },
  );
  assertEquals(comparison.status, "new");
  assertEquals(comparison.previousCaptureId, null);
  assertEquals(comparison.successfulMarkdownHistory, []);
});

Deno.test("Page classification storage failure cannot establish readiness or comparison", async () => {
  const { svc } = fakeSvc({
    updateError: true,
    captures: [{
      id: "legacy",
      scout_run_id: null,
      content_md: "A valid policy.",
      source_url: "https://example.test",
      content_sha256: null,
      canonical_content_sha256: "old",
      canonicalizer_version: WEB_CANONICALIZER_VERSION,
    }],
  });
  await assertRejects(() =>
    hasCurrentCanonicalBaselineForUrl(svc, "s1", "https://example.test")
  );
  await assertRejects(() =>
    compareCanonicalContentForUrl(svc, "s1", "A new policy.", {
      validityMode: "page",
    })
  );
});

Deno.test("an HTTP error cannot replace a validated Page baseline", async () => {
  const { svc, inserts } = fakeSvc({});
  const args = {
    userId: "u1",
    scoutId: "s1",
    sourceUrl: "https://example.test/policy",
    markdown: "Applications open in June.",
    validityMode: "page" as const,
    pageResponse: { status_code: 200 },
  };
  await writeCanonicalBaseline(svc, args);
  await assertRejects(() =>
    writeCanonicalBaseline(svc, {
      ...args,
      markdown: "Not found",
      pageResponse: { status_code: 404 },
    })
  );
  const captures = inserts.map((
    row,
    index,
  ) => ({ ...row, id: `capture-${index}` } as unknown as Capture));
  const comparison = await compareCanonicalContentForUrl(
    fakeSvc({ captures }).svc,
    "s1",
    "Applications open in July.",
    { sourceUrl: args.sourceUrl, validityMode: "page" },
  );
  assertEquals(comparison.status, "changed");
  assertEquals(comparison.previousMarkdown, args.markdown);
});
