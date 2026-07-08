import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "./supabase.ts";
import type { ScrapeResult } from "./scrape_types.ts";
import {
  sha256HexBytes,
  SnapshotIntegrityError,
  SnapshotStorageError,
} from "./snapshot_store.ts";
import {
  decodeBase64Capped,
  degradeClass,
  downloadScreenshot,
  isAllowedScreenshotUrl,
  MAX_ARTIFACT_BYTES,
  performArchiveCapture,
  resolveArchiveGate,
  runSnapshotInBackground,
  storeCaptureResult,
} from "./snapshot_capture.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Minimal fake supabase client: records storage uploads/lists/removes and
 * page_snapshots inserts; answers user_preferences reads from a fixed tier. */
function fakeSvc(opts: {
  tier?: string | null;
  prefsError?: string;
  insertError?: string;
  uploadError?: string;
} = {}) {
  const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  const rows: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const SNAP_ID = "44444444-4444-4444-4444-444444444444";
  const svc = {
    storage: {
      from() {
        return {
          upload(path: string, bytes: Uint8Array) {
            uploads.push({ path, bytes });
            return Promise.resolve(
              opts.uploadError
                ? { error: { message: opts.uploadError } }
                : { error: null },
            );
          },
        };
      },
    },
    from(table: string) {
      if (table === "user_preferences") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve(
                      opts.prefsError
                        ? { data: null, error: { message: opts.prefsError } }
                        : { data: { tier: opts.tier ?? null }, error: null },
                    );
                  },
                };
              },
            };
          },
        };
      }
      // page_snapshots
      return {
        insert(row: Record<string, unknown>) {
          rows.push(row);
          return {
            select() {
              return {
                single() {
                  return Promise.resolve(
                    opts.insertError
                      ? { data: null, error: { message: opts.insertError } }
                      : { data: { id: SNAP_ID }, error: null },
                  );
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          return { eq() { return Promise.resolve({ error: null }); } };
        },
      };
    },
  };
  return { svc: svc as unknown as SupabaseClient, uploads, rows, updates };
}

function baseResult(over: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    markdown: "detection body",
    source_url: "https://example.com/final",
    fetched_at: "2026-07-07T00:00:00Z",
    status_code: 200,
    served_by: "crawl4ai",
    ...over,
  };
}

const ctx = () => ({
  scoutId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  scoutRunId: "33333333-3333-3333-3333-333333333333",
  rawCaptureId: null,
  captureKind: "change" as const,
  requestedUrl: "https://example.com",
  fallbackMarkdown: "detection body",
  contentSha256: "abc",
  canonicalContentSha256: "def",
});

// --------------------------------------------------------------------------
// decodeBase64Capped
// --------------------------------------------------------------------------
Deno.test("decodeBase64Capped round-trips bytes", () => {
  const out = decodeBase64Capped(b64(PNG), MAX_ARTIFACT_BYTES, "png");
  assertEquals(Array.from(out), Array.from(PNG));
});

Deno.test("decodeBase64Capped rejects over-cap before decoding", () => {
  let threw = false;
  try {
    decodeBase64Capped(b64(PNG), 4, "png");
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "artifact_too_large:png");
  }
  assert(threw);
});

Deno.test("decodeBase64Capped rejects undecodable input", () => {
  let threw = false;
  try {
    decodeBase64Capped("!!!!not base64!!!!", MAX_ARTIFACT_BYTES, "png");
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "artifact_decode_failed:png");
  }
  assert(threw);
});

// --------------------------------------------------------------------------
// isAllowedScreenshotUrl
// --------------------------------------------------------------------------
Deno.test("isAllowedScreenshotUrl enforces https + host allowlist", () => {
  assert(isAllowedScreenshotUrl("https://cdn.firecrawl.dev/shot.png"));
  assert(isAllowedScreenshotUrl("https://foo.s3.amazonaws.com/x.png"));
  assert(!isAllowedScreenshotUrl("http://cdn.firecrawl.dev/x.png")); // not https
  assert(!isAllowedScreenshotUrl("https://evil.example.com/x.png")); // off-host
  assert(!isAllowedScreenshotUrl("not a url"));
});

Deno.test("isAllowedScreenshotUrl honors env override", () => {
  Deno.env.set("SNAPSHOT_SCREENSHOT_HOST_SUFFIXES", "storage.example.com");
  try {
    assert(isAllowedScreenshotUrl("https://storage.example.com/x.png"));
    assert(!isAllowedScreenshotUrl("https://cdn.firecrawl.dev/x.png"));
  } finally {
    Deno.env.delete("SNAPSHOT_SCREENSHOT_HOST_SUFFIXES");
  }
});

// --------------------------------------------------------------------------
// downloadScreenshot
// --------------------------------------------------------------------------
function fetchReturning(body: Uint8Array, headers: Record<string, string> = {}) {
  return () =>
    Promise.resolve(
      new Response(body as unknown as BodyInit, { status: 200, headers }),
    );
}

Deno.test("downloadScreenshot returns verified PNG bytes", async () => {
  const bytes = await downloadScreenshot(
    "https://cdn.firecrawl.dev/s.png",
    fetchReturning(PNG) as unknown as typeof fetch,
  );
  assertEquals(Array.from(bytes), Array.from(PNG));
});

Deno.test("downloadScreenshot rejects a disallowed url before fetching", async () => {
  let threw = false;
  try {
    await downloadScreenshot("https://evil.example.com/s.png");
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "screenshot_url_rejected");
  }
  assert(threw);
});

Deno.test("downloadScreenshot rejects a non-PNG payload (error card)", async () => {
  let threw = false;
  try {
    await downloadScreenshot(
      "https://cdn.firecrawl.dev/s.png",
      fetchReturning(JPEG) as unknown as typeof fetch,
    );
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "screenshot_not_png");
  }
  assert(threw);
});

Deno.test("downloadScreenshot rejects an over-cap Content-Length", async () => {
  let threw = false;
  try {
    await downloadScreenshot(
      "https://cdn.firecrawl.dev/s.png",
      fetchReturning(PNG, {
        "content-length": String(MAX_ARTIFACT_BYTES + 1),
      }) as unknown as typeof fetch,
    );
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "artifact_too_large:screenshot");
  }
  assert(threw);
});

Deno.test("downloadScreenshot maps a non-OK response", async () => {
  const badFetch = () => Promise.resolve(new Response("nope", { status: 404 }));
  let threw = false;
  try {
    await downloadScreenshot(
      "https://cdn.firecrawl.dev/s.png",
      badFetch as unknown as typeof fetch,
    );
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "screenshot_download_http_404");
  }
  assert(threw);
});

Deno.test("downloadScreenshot maps a non-abort network error to download_failed", async () => {
  const netFail = () => Promise.reject(new Error("connection reset"));
  let threw = false;
  try {
    await downloadScreenshot(
      "https://cdn.firecrawl.dev/s.png",
      netFail as unknown as typeof fetch,
    );
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "screenshot_download_failed");
  }
  assert(threw);
});

Deno.test("downloadScreenshot maps an aborted fetch to a timeout", async () => {
  const abortFetch = () => {
    const err = new Error("aborted");
    (err as { name: string }).name = "AbortError";
    return Promise.reject(err);
  };
  let threw = false;
  try {
    await downloadScreenshot(
      "https://cdn.firecrawl.dev/s.png",
      abortFetch as unknown as typeof fetch,
    );
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "screenshot_download_timeout");
  }
  assert(threw);
});

Deno.test("downloadScreenshot rejects a null body", async () => {
  const nullBody = () => Promise.resolve(new Response(null, { status: 200 }));
  let threw = false;
  try {
    await downloadScreenshot(
      "https://cdn.firecrawl.dev/s.png",
      nullBody as unknown as typeof fetch,
    );
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "screenshot_download_no_body");
  }
  assert(threw);
});

Deno.test("downloadScreenshot enforces the streamed byte ceiling (no content-length)", async () => {
  // A ReadableStream body has no content-length, so the ceiling is enforced
  // mid-stream. Two PNG-prefixed chunks exceed a tiny cap.
  const streamFetch = () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(PNG);
        controller.enqueue(PNG);
        controller.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  let threw = false;
  try {
    await downloadScreenshot(
      "https://cdn.firecrawl.dev/s.png",
      streamFetch as unknown as typeof fetch,
      PNG.length + 1, // cap between one and two chunks
    );
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "artifact_too_large:screenshot");
  }
  assert(threw);
});

// --------------------------------------------------------------------------
// degradeClass
// --------------------------------------------------------------------------
Deno.test("degradeClass maps failure shapes", () => {
  assertEquals(degradeClass(new Error("Blocked by anti-bot protection")), "antibot");
  assertEquals(degradeClass(new Error("artifact_too_large:mhtml:99")), "oversize");
  assertEquals(degradeClass(new Error("screenshot_url_rejected")), "bad_cdn_url");
  assertEquals(degradeClass(new Error("screenshot_not_png")), "screenshot_format");
  assertEquals(degradeClass(new Error("screenshot_download_http_500")), "artifact_download");
  assertEquals(degradeClass(new Error("artifact_decode_failed:mhtml")), "artifact_decode");
  assertEquals(degradeClass(new Error("aborted after 40000ms")), "capture_timeout");
  assertEquals(degradeClass(new SnapshotIntegrityError("weird")), "integrity");
  assertEquals(degradeClass(new SnapshotStorageError("weird")), "storage");
  assertEquals(degradeClass("a bare string"), "capture_fetch");
  assertEquals(degradeClass(new Error("mystery")), "capture_fetch");
});

// --------------------------------------------------------------------------
// resolveArchiveGate
// --------------------------------------------------------------------------
Deno.test("resolveArchiveGate: off when toggle off", async () => {
  const { svc } = fakeSvc({ tier: "pro" });
  assertEquals(
    await resolveArchiveGate(svc, { user_id: "u", archive_enabled: false }),
    false,
  );
});

Deno.test("resolveArchiveGate: OSS (credits disabled) allows any tier", async () => {
  Deno.env.delete("COJO_CREDITS_ENABLED");
  const { svc } = fakeSvc({ tier: null });
  assertEquals(
    await resolveArchiveGate(svc, { user_id: "u", archive_enabled: true }),
    true,
  );
});

Deno.test("resolveArchiveGate: SaaS pro passes, free fails, read-error fails closed", async () => {
  Deno.env.set("COJO_CREDITS_ENABLED", "true");
  try {
    const pro = fakeSvc({ tier: "pro" });
    assertEquals(
      await resolveArchiveGate(pro.svc, { user_id: "u", archive_enabled: true }),
      true,
    );
    const free = fakeSvc({ tier: "free" });
    assertEquals(
      await resolveArchiveGate(free.svc, { user_id: "u", archive_enabled: true }),
      false,
    );
    const err = fakeSvc({ prefsError: "boom" });
    assertEquals(
      await resolveArchiveGate(err.svc, { user_id: "u", archive_enabled: true }),
      false,
    );
  } finally {
    Deno.env.delete("COJO_CREDITS_ENABLED");
  }
});

// --------------------------------------------------------------------------
// storeCaptureResult
// --------------------------------------------------------------------------
Deno.test("storeCaptureResult stores fidelity=full from an inline payload", async () => {
  const { svc, uploads, rows } = fakeSvc();
  const mhtml = new TextEncoder().encode("From: <snapshot>\r\n\r\nbody");
  const capture = baseResult({
    markdown: "capture body",
    snapshot: {
      mhtml_b64: b64(mhtml),
      mhtml_sha256: await sha256HexBytes(mhtml),
      screenshot_b64: b64(PNG),
      screenshot_sha256: await sha256HexBytes(PNG),
    },
  });
  const out = await storeCaptureResult(svc, ctx(), capture);
  assertEquals(out.status, "stored");
  assertEquals(out.fidelity, "full");
  // mhtml + screenshot + markdown = 3 objects
  assertEquals(uploads.length, 3);
  assertEquals(rows[0].fidelity, "full");
  // Decision 10: the .md record is the CAPTURE markdown, not detection.
  assertEquals(rows[0].markdown_bytes, new TextEncoder().encode("capture body").byteLength);
});

Deno.test("storeCaptureResult degrades when capture markdown is empty", async () => {
  const { svc, rows } = fakeSvc();
  const mhtml = new TextEncoder().encode("x");
  const capture = baseResult({
    markdown: "   ",
    snapshot: {
      mhtml_b64: b64(mhtml),
      mhtml_sha256: await sha256HexBytes(mhtml),
      screenshot_b64: b64(PNG),
      screenshot_sha256: await sha256HexBytes(PNG),
    },
  });
  const out = await storeCaptureResult(svc, ctx(), capture);
  assertEquals(out.fidelity, "markdown_only");
  assertStringIncludes(out.status, "degraded:empty_capture_markdown");
  assertEquals(rows[0].fidelity, "markdown_only");
});

Deno.test("storeCaptureResult stores rendered_thirdparty from a firecrawl same-fetch", async () => {
  const { svc, rows } = fakeSvc();
  const capture = baseResult({
    served_by: "firecrawl",
    rawHtml: "<html>page</html>",
    screenshot_url: "https://cdn.firecrawl.dev/s.png",
  });
  const out = await storeCaptureResult(svc, ctx(), capture, {
    fetchImpl: fetchReturning(PNG) as unknown as typeof fetch,
  });
  assertEquals(out.status, "stored");
  assertEquals(out.fidelity, "rendered_thirdparty");
  assertEquals(rows[0].served_by, "firecrawl");
});

Deno.test("storeCaptureResult degrades a firecrawl same-fetch when the screenshot download fails", async () => {
  const { svc } = fakeSvc();
  const capture = baseResult({
    served_by: "firecrawl",
    rawHtml: "<html>page</html>",
    screenshot_url: "https://cdn.firecrawl.dev/s.png",
  });
  const out = await storeCaptureResult(svc, ctx(), capture, {
    fetchImpl: fetchReturning(JPEG) as unknown as typeof fetch, // not a PNG
  });
  assertEquals(out.fidelity, "markdown_only");
  assertStringIncludes(out.status, "degraded:screenshot_format");
});

Deno.test("storeCaptureResult degrades with the service error class when no artifacts", async () => {
  const { svc } = fakeSvc();
  const capture = baseResult({ snapshot_error: "artifact_too_large:mhtml:99" });
  const out = await storeCaptureResult(svc, ctx(), capture);
  assertEquals(out.fidelity, "markdown_only");
  assertStringIncludes(out.status, "degraded:service:artifact_too_large");
});

Deno.test("storeCaptureResult degrades as capture_unavailable when a result carries nothing", async () => {
  const { svc } = fakeSvc();
  // crawl4ai-served, no snapshot payload, no snapshot_error, no screenshot_url.
  const out = await storeCaptureResult(svc, ctx(), baseResult());
  assertEquals(out.fidelity, "markdown_only");
  assertStringIncludes(out.status, "degraded:capture_unavailable");
});

Deno.test("storeCaptureResult returns failed:<class> when even the degrade insert fails", async () => {
  const { svc } = fakeSvc({ insertError: "db down" });
  const capture = baseResult({ snapshot_error: "capture_incomplete" });
  const out = await storeCaptureResult(svc, ctx(), capture);
  assertStringIncludes(out.status, "failed:");
  assertEquals(out.snapshotId, undefined);
});

Deno.test("storeCaptureResult catches an upload failure and degrades (storage class)", async () => {
  const { svc } = fakeSvc({ uploadError: "bucket unavailable" });
  const mhtml = new TextEncoder().encode("m");
  const capture = baseResult({
    markdown: "capture body",
    snapshot: {
      mhtml_b64: b64(mhtml),
      mhtml_sha256: await sha256HexBytes(mhtml),
      screenshot_b64: b64(PNG),
      screenshot_sha256: await sha256HexBytes(PNG),
    },
  });
  // The full-fidelity upload throws; the outer catch degrades. The
  // markdown_only degrade also uploads (the .md record) and would hit the same
  // uploadError — so this ends at failed:storage, proving the run never throws.
  const out = await storeCaptureResult(svc, ctx(), capture);
  assertStringIncludes(out.status, "failed:");
});

Deno.test("storeCaptureResult degrades an oversize rawHtml (rendered_thirdparty path)", async () => {
  const { svc } = fakeSvc();
  const capture = baseResult({
    served_by: "firecrawl",
    rawHtml: "<html>a bit of html</html>",
    screenshot_url: "https://cdn.firecrawl.dev/s.png",
  });
  const out = await storeCaptureResult(svc, ctx(), capture, {
    fetchImpl: fetchReturning(PNG) as unknown as typeof fetch,
    maxArtifactBytes: 4, // rawHtml exceeds this → degrade before downloading
  });
  assertEquals(out.fidelity, "markdown_only");
  assertStringIncludes(out.status, "degraded:oversize");
});

// --------------------------------------------------------------------------
// runSnapshotInBackground
// --------------------------------------------------------------------------
Deno.test("runSnapshotInBackground swallows rejections without throwing", async () => {
  runSnapshotInBackground(Promise.reject(new Error("boom")));
  runSnapshotInBackground(Promise.resolve("ok"));
  // give the microtask queue a tick so the .catch runs
  await new Promise((r) => setTimeout(r, 0));
});

Deno.test("runSnapshotInBackground hands work to EdgeRuntime.waitUntil when present", async () => {
  let handed: Promise<unknown> | null = null;
  (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = {
    waitUntil(p: Promise<unknown>) {
      handed = p;
    },
  };
  try {
    runSnapshotInBackground(Promise.resolve("x"));
    assert(handed !== null);
    await handed;
  } finally {
    delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
  }
});

// --------------------------------------------------------------------------
// performArchiveCapture
// --------------------------------------------------------------------------
Deno.test("performArchiveCapture: firecrawl-served detection stores rendered_thirdparty without a second fetch", async () => {
  const { svc, rows } = fakeSvc();
  let scrapeCalls = 0;
  const detection = baseResult({
    served_by: "firecrawl",
    rawHtml: "<html>x</html>",
    screenshot_url: "https://cdn.firecrawl.dev/s.png",
  });
  const out = await performArchiveCapture(svc, ctx(), detection, {
    fetchImpl: fetchReturning(PNG) as unknown as typeof fetch,
    scrapeImpl: (() => {
      scrapeCalls++;
      return Promise.resolve(baseResult());
    }) as unknown as typeof import("./scrape.ts").scrape,
  });
  assertEquals(out.fidelity, "rendered_thirdparty");
  assertEquals(scrapeCalls, 0); // no capture fetch on the fallback path
  assertEquals(rows[0].capture_kind, "change");
});

Deno.test("performArchiveCapture: crawl4ai-served issues one pinned capture fetch → full", async () => {
  const { svc } = fakeSvc();
  const mhtml = new TextEncoder().encode("mhtml");
  const mhtmlSha = await sha256HexBytes(mhtml);
  const pngSha = await sha256HexBytes(PNG);
  let pinnedNoFallback = false;
  const detection = baseResult({ served_by: "crawl4ai" });
  const out = await performArchiveCapture(svc, ctx(), detection, {
    scrapeImpl: ((_url: string, o: { noAntibotFallback?: boolean; snapshot?: unknown }) => {
      pinnedNoFallback = o.noAntibotFallback === true && o.snapshot === true;
      return Promise.resolve(baseResult({
        markdown: "capture md",
        snapshot: {
          mhtml_b64: b64(mhtml),
          mhtml_sha256: mhtmlSha,
          screenshot_b64: b64(PNG),
          screenshot_sha256: pngSha,
        },
      }));
    }) as unknown as typeof import("./scrape.ts").scrape,
  });
  assert(pinnedNoFallback);
  assertEquals(out.fidelity, "full");
});

Deno.test("performArchiveCapture: capture-fetch failure degrades to markdown_only (pin holds)", async () => {
  const { svc } = fakeSvc();
  const detection = baseResult({ served_by: "crawl4ai" });
  const out = await performArchiveCapture(svc, ctx(), detection, {
    scrapeImpl: (() =>
      Promise.reject(
        new Error("Blocked by anti-bot protection: DataDome"),
      )) as unknown as typeof import("./scrape.ts").scrape,
  });
  assertEquals(out.fidelity, "markdown_only");
  assertStringIncludes(out.status, "degraded:antibot");
});


