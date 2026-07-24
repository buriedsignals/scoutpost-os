import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPageScoutSnapshotMetadata,
  pageScoutChildCaptureKind,
  pageScoutTrustDiagnostics,
  runPageScoutArchiveBatch,
  shouldShowPageScoutArchiveCta,
} from "./page_scout_archive.ts";

Deno.test("archive CTA remains root-only until child-specific targets exist", () => {
  assertEquals(shouldShowPageScoutArchiveCta(false, true), true);
  assertEquals(shouldShowPageScoutArchiveCta(true, true), false);
  assertEquals(shouldShowPageScoutArchiveCta(true, false), false);
});

Deno.test("archive trust still runs when the pre-trust diagnostics write fails", async () => {
  let writes = 0;
  let trusts = 0;
  const [result] = await runPageScoutArchiveBatch(["root"], {
    capture: async () => ({ status: "stored" }),
    failureOutcome: () => ({ status: "failed" }),
    persistDiagnostics: async () => {
      writes++;
      if (writes === 1) throw new Error("metadata temporarily unavailable");
    },
    trust: async () => {
      trusts++;
      return { snapshot_tsa_status: "stored" };
    },
  });
  assertEquals(trusts, 1);
  assertEquals(writes, 2);
  assertEquals(result.diagnosticsError, null);
  assertEquals(result.trustDiagnostics.snapshot_tsa_status, "stored");
});

Deno.test("PA-FAILURE-001 archive batch isolates source failures and persists capture then trust diagnostics", async () => {
  const events: string[] = [];
  const results = await runPageScoutArchiveBatch(
    ["root", "child-a", "child-b"],
    {
      capture: async (source) => {
        events.push(`capture:${source}`);
        if (source === "child-a") throw new Error("capture failed");
        return { status: "stored", source };
      },
      failureOutcome: () => ({ status: "failed", source: "child-a" }),
      persistDiagnostics: async (items) => {
        events.push(
          `diagnostics:${items.map((item) => item.outcome.status).join(",")}`,
        );
      },
      trust: async (source) => {
        events.push(`trust:${source}`);
        if (source === "child-b") throw new Error("trust failed");
        return { snapshot_tsa_status: "stored" };
      },
    },
  );
  assertEquals(
    events.indexOf("diagnostics:stored,failed,stored") <
      events.indexOf("trust:root"),
    true,
  );
  assertEquals(
    events.lastIndexOf("diagnostics:stored,failed,stored") >
      events.indexOf("trust:child-b"),
    true,
  );
  assertEquals(results[0].captureError, null);
  assertEquals(results[1].captureError instanceof Error, true);
  assertEquals(results[2].trustError instanceof Error, true);
  assertEquals(pageScoutTrustDiagnostics(results[2].trustError), {
    snapshot_trust_status: "failed",
    snapshot_trust_error: "trust failed",
  });
  assertEquals(results[0].trustDiagnostics, {
    snapshot_tsa_status: "stored",
  });
});

Deno.test("child archive lifecycle distinguishes initial, addition, change, same, and enable-later", () => {
  assertEquals(
    pageScoutChildCaptureKind({
      status: "new",
      initialBaseline: true,
      alreadyArchived: false,
    }),
    "baseline",
  );
  assertEquals(
    pageScoutChildCaptureKind({
      status: "new",
      initialBaseline: false,
      alreadyArchived: false,
    }),
    "change",
  );
  assertEquals(
    pageScoutChildCaptureKind({
      status: "changed",
      initialBaseline: false,
      alreadyArchived: false,
    }),
    "change",
  );
  assertEquals(
    pageScoutChildCaptureKind({
      status: "same",
      initialBaseline: false,
      alreadyArchived: false,
    }),
    "baseline",
  );
  assertEquals(
    pageScoutChildCaptureKind({
      status: "same",
      initialBaseline: false,
      alreadyArchived: true,
    }),
    null,
  );
});

Deno.test("PA-MULTI-001 root plus two children retain isolated diagnostics without overwriting root scalars", () => {
  const metadata = buildPageScoutSnapshotMetadata([
    {
      sourceUrl: "https://example.test/news/",
      isRoot: true,
      diagnostics: { snapshot_status: "stored", snapshot_id: "root" },
    },
    {
      sourceUrl: "https://example.test/news/a",
      isRoot: false,
      diagnostics: { snapshot_status: "degraded", snapshot_id: "a" },
    },
    {
      sourceUrl: "https://example.test/news/b",
      isRoot: false,
      diagnostics: { snapshot_status: "stored", snapshot_id: "b" },
    },
  ], (url) => url);
  assertEquals(metadata.snapshot_id, "root");
  assertEquals(metadata.page_snapshot_sources, {
    "https://example.test/news/": {
      snapshot_status: "stored",
      snapshot_id: "root",
    },
    "https://example.test/news/a": {
      snapshot_status: "degraded",
      snapshot_id: "a",
    },
    "https://example.test/news/b": {
      snapshot_status: "stored",
      snapshot_id: "b",
    },
  });
});
