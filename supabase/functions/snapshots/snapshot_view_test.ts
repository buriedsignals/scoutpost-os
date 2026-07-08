import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ARTIFACT_KINDS,
  ARTIFACTS,
  artifactDownloadName,
  availableArtifacts,
  clampInt,
  isUuid,
  shapeSnapshot,
} from "./snapshot_view.ts";

const SNAP = "33333333-3333-3333-3333-333333333333";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SNAP,
    scout_id: "11111111-1111-1111-1111-111111111111",
    scout_run_id: "22222222-2222-2222-2222-222222222222",
    capture_kind: "change",
    fidelity: "full",
    served_by: "crawl4ai",
    captured_at: "2026-07-08T00:00:00Z",
    requested_url: "https://example.com",
    final_url: "https://example.com/final",
    http_status: 200,
    markdown_bytes: 100,
    markdown_path: `u/s/${"a".repeat(64)}.md`,
    mhtml_bytes: 900,
    mhtml_path: `u/s/${"b".repeat(64)}.mhtml`,
    screenshot_bytes: 500,
    screenshot_path: `u/s/${"c".repeat(64)}.png`,
    rawhtml_bytes: null,
    rawhtml_path: null,
    manifest_path: `u/s/manifest-${SNAP}.json`,
    tsa_status: "ok",
    tsa_path: `u/s/${SNAP}.tsr`,
    wayback_status: "success",
    wayback_url: "https://web.archive.org/web/20260708/https://example.com",
    created_at: "2026-07-08T00:00:00Z",
    ...over,
  };
}

Deno.test("ARTIFACTS maps all six kinds with download content types", () => {
  assertEquals(ARTIFACT_KINDS.length, 6);
  assertEquals(ARTIFACTS.mhtml.contentType, "multipart/related"); // opens in Chrome/Edge
  assertEquals(ARTIFACTS.screenshot.contentType, "image/png");
  assertEquals(ARTIFACTS.rawhtml.contentType, "text/html");
  assertEquals(ARTIFACTS.markdown.contentType, "text/markdown");
  assertEquals(ARTIFACTS.manifest.contentType, "application/json");
  assertEquals(ARTIFACTS.tsr.contentType, "application/timestamp-reply");
  assertEquals(ARTIFACTS.tsr.column, "tsa_path"); // tsr artifact reads tsa_path
});

Deno.test("availableArtifacts derives kinds from non-null path columns", () => {
  // full row (mhtml+screenshot+markdown) + manifest + tsr (rawhtml null)
  assertEquals(
    availableArtifacts(row()).sort(),
    ["manifest", "markdown", "mhtml", "screenshot", "tsr"].sort(),
  );
  // markdown_only degrade — only the .md record
  const md = availableArtifacts(row({
    fidelity: "markdown_only",
    mhtml_path: null,
    screenshot_path: null,
    manifest_path: null,
    tsa_path: null,
  }));
  assertEquals(md, ["markdown"]);
  // rendered_thirdparty — screenshot + rawhtml + markdown (no mhtml)
  const rtp = availableArtifacts(row({
    fidelity: "rendered_thirdparty",
    mhtml_path: null,
    rawhtml_path: `u/s/${"d".repeat(64)}.html`,
    manifest_path: null,
    tsa_path: null,
  })).sort();
  assertEquals(rtp, ["markdown", "rawhtml", "screenshot"].sort());
});

Deno.test("shapeSnapshot builds the retrieval envelope", () => {
  const s = shapeSnapshot(row());
  assertEquals(s.id, SNAP);
  assertEquals(s.fidelity, "full");
  assertEquals((s.sizes as Record<string, unknown>).mhtml, 900);
  assertEquals((s.trust as Record<string, unknown>).tsa_status, "ok");
  assertEquals((s.trust as Record<string, unknown>).wayback_status, "success");
  assert(Array.isArray(s.artifacts));
  assert((s.artifacts as string[]).includes("mhtml"));
  // no raw path/column leakage in the shaped output
  assert(!("mhtml_path" in s));
  assert(!("tsa_path" in s));
});

Deno.test("artifactDownloadName names the file by kind extension", () => {
  assertEquals(artifactDownloadName(SNAP, "mhtml"), `snapshot-${SNAP}.mhtml`);
  assertEquals(artifactDownloadName(SNAP, "tsr"), `snapshot-${SNAP}.tsr`);
  assertEquals(artifactDownloadName(SNAP, "markdown"), `snapshot-${SNAP}.md`);
});

Deno.test("isUuid accepts canonical UUIDs and rejects loose 36-char strings", () => {
  assert(isUuid(SNAP));
  assert(isUuid("11111111-1111-1111-1111-111111111111"));
  // the loose [0-9a-f-]{36} shape a naive guard would have accepted → 500 risk
  assert(!isUuid("-".repeat(36)));
  assert(!isUuid("g1111111-1111-1111-1111-111111111111")); // non-hex
  assert(!isUuid("1111111-1111-1111-1111-1111111111111")); // wrong grouping
  assert(!isUuid("")); // empty
  assert(!isUuid("11111111111111111111111111111111")); // no dashes
});

Deno.test("clampInt falls back on NaN and clamps to range", () => {
  assertEquals(clampInt("10", 50, 1, 100), 10);
  assertEquals(clampInt(null, 50, 1, 100), 50); // absent → fallback
  assertEquals(clampInt("foo", 50, 1, 100), 50); // NaN → fallback, not NaN
  assertEquals(clampInt("999", 50, 1, 100), 100); // above max
  assertEquals(clampInt("0", 50, 1, 100), 1); // below min
  assertEquals(clampInt("-5", 0, 0, Infinity), 0); // offset floor
});
