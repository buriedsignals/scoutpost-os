import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { loadCrawlerResult } from "./crawler_results.ts";
import { sha256HexBytes } from "./snapshot_store.ts";

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const response = new Response(
    new Blob([bytes.slice().buffer]).stream().pipeThrough(
      new CompressionStream("gzip"),
    ),
  );
  return new Uint8Array(await response.arrayBuffer());
}

Deno.test("crawler snapshot result is verified and reassembled inline", async () => {
  const mhtml = new TextEncoder().encode("MIME-Version: 1.0\n\npage");
  const screenshot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const result = await gzip(new TextEncoder().encode(JSON.stringify({
    markdown: "page",
    source_url: "https://example.test",
    snapshot: {
      mhtml_sha256: await sha256HexBytes(mhtml),
      screenshot_sha256: await sha256HexBytes(screenshot),
    },
  })));
  const mhtmlGzip = await gzip(mhtml);
  const byPath = new Map([
    ["result", result],
    ["mhtml", mhtmlGzip],
    ["screenshot", screenshot],
  ]);
  const manifest = {
    artifacts: await Promise.all([...byPath].map(async ([kind, bytes]) => ({
      kind,
      path: kind,
      bytes: bytes.byteLength,
      sha256: await sha256HexBytes(bytes),
    }))),
  };
  const svc = {
    storage: {
      from() {
        return {
          createSignedUrl(path: string) {
            return Promise.resolve({
              data: { signedUrl: `https://files/${path}` },
              error: null,
            });
          },
        };
      },
    },
  };
  const loaded = await loadCrawlerResult(
    svc as never,
    manifest,
    "snapshot",
    ((url: string | URL | Request) => {
      const bytes = byPath.get(new URL(String(url)).pathname.slice(1));
      return Promise.resolve(new Response(bytes?.slice().buffer));
    }) as typeof fetch,
  );
  const snapshot = loaded.snapshot as Record<string, string>;
  assertEquals(decodeBase64(snapshot.mhtml_b64), mhtml);
  assertEquals(decodeBase64(snapshot.screenshot_b64), screenshot);

  const corrupt = structuredClone(manifest);
  corrupt.artifacts[0].sha256 = "0".repeat(64);
  await assertRejects(
    () =>
      loadCrawlerResult(
        svc as never,
        corrupt,
        "snapshot",
        ((url: string | URL | Request) => {
          const bytes = byPath.get(new URL(String(url)).pathname.slice(1));
          return Promise.resolve(new Response(bytes?.slice().buffer));
        }) as typeof fetch,
      ),
    Error,
    "integrity failure",
  );
});

Deno.test("snapshot_error preserves a successful result without binary artifacts", async () => {
  const result = await gzip(new TextEncoder().encode(JSON.stringify({
    markdown: "page",
    source_url: "https://example.test",
    snapshot_error: "capture_incomplete",
  })));
  const manifest = {
    artifacts: [{
      kind: "result",
      path: "result",
      bytes: result.byteLength,
      sha256: await sha256HexBytes(result),
    }],
  };
  const svc = {
    storage: {
      from() {
        return {
          createSignedUrl() {
            return Promise.resolve({
              data: { signedUrl: "https://files/result" },
              error: null,
            });
          },
        };
      },
    },
  };
  const loaded = await loadCrawlerResult(
    svc as never,
    manifest,
    "snapshot",
    (() =>
      Promise.resolve(new Response(result.slice().buffer))) as typeof fetch,
  );
  assertEquals(loaded.snapshot_error, "capture_incomplete");

  const invalidResult = await gzip(new TextEncoder().encode(JSON.stringify({
    markdown: "page",
    source_url: "https://example.test",
  })));
  const invalidSha256 = await sha256HexBytes(invalidResult);
  await assertRejects(
    () =>
      loadCrawlerResult(
        svc as never,
        {
          artifacts: [{
            kind: "result",
            path: "result",
            bytes: invalidResult.byteLength,
            sha256: invalidSha256,
          }],
        },
        "snapshot",
        (() =>
          Promise.resolve(
            new Response(invalidResult.slice().buffer),
          )) as typeof fetch,
      ),
    Error,
    "invalid crawler snapshot result",
  );
});
