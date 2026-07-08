import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { SupabaseClient } from "./supabase.ts";
import { applyTrustLayer } from "./trust.ts";
import { _internal } from "./tsa.ts";
import type { StoredSnapshot } from "./snapshot_store.ts";

const U = {
  user: "22222222-2222-2222-2222-222222222222",
  scout: "11111111-1111-1111-1111-111111111111",
  snap: "33333333-3333-3333-3333-333333333333",
};

function stored(): StoredSnapshot {
  return {
    id: U.snap,
    fidelity: "full",
    markdownPath: `${U.user}/${U.scout}/m.md`,
    paths: {},
    manifestInput: {
      snapshotId: U.snap,
      scoutId: U.scout,
      userId: U.user,
      captureKind: "change",
      fidelity: "full",
      capturedAt: "2026-07-07T12:00:00Z",
      requestedUrl: "https://example.com",
      markdownSha256: "m".repeat(64),
      mhtmlSha256: "h".repeat(64),
      screenshotSha256: "p".repeat(64),
    },
  };
}

function fakeSvc(opts: { uploadError?: string; failOnly?: string } = {}) {
  const uploads: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const svc = {
    storage: {
      from() {
        return {
          upload(path: string) {
            uploads.push(path);
            // failOnly scopes the failure to matching paths (e.g. ".tsr");
            // uploadError alone fails every upload.
            const fail = opts.uploadError &&
              (!opts.failOnly || path.includes(opts.failOnly));
            return Promise.resolve(
              fail ? { error: { message: opts.uploadError } } : { error: null },
            );
          },
        };
      },
    },
    from() {
      return {
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          return { eq() { return Promise.resolve({ error: null }); } };
        },
      };
    },
  };
  return { svc: svc as unknown as SupabaseClient, uploads, updates };
}

// A synthetic valid RFC 3161 token matching the fixed nonce [1,2,3,4].
function validTsr(imprintHex: string): Uint8Array {
  const { der, encodeInteger, hexToBytes, SHA256_OID, NULL_DER, TST_INFO_OID } = _internal;
  const statusInfo = der(0x30, encodeInteger([0]));
  const algId = der(0x30, [...SHA256_OID, ...NULL_DER]);
  const messageImprint = der(0x30, [...algId, ...der(0x04, hexToBytes(imprintHex))]);
  const tstInfo = der(0x30, [
    ...encodeInteger([1]),
    ...messageImprint,
    ...der(0x18, [...new TextEncoder().encode("20260707120000Z")]),
    ...encodeInteger([1, 2, 3, 4]),
  ]);
  const token = der(0x30, [...der(0x06, TST_INFO_OID), ...der(0x04, tstInfo)]);
  return new Uint8Array(der(0x30, [...statusInfo, ...token]));
}

const fixedNonce = () => new Uint8Array([1, 2, 3, 4]);

Deno.test("applyTrustLayer: ok TSA + success Wayback → row stamped, manifest+tsr uploaded", async () => {
  const { svc, uploads, updates } = fakeSvc();
  // Build the token to match the manifest hash the layer will compute.
  const { buildManifest } = await import("./tsa.ts");
  const { sha256HexBytes } = await import("./snapshot_store.ts");
  const manifestHash = await sha256HexBytes(
    new TextEncoder().encode(buildManifest(stored().manifestInput)),
  );
  const token = validTsr(manifestHash);
  const tsaFetch = (() =>
    Promise.resolve(new Response(token as unknown as BodyInit, { status: 200 }))) as
      unknown as typeof fetch;

  const waybackFetch = ((url: string) =>
    url.includes("/save/status/")
      ? Promise.resolve(new Response(JSON.stringify({ status: "success", timestamp: "20260707120500", original_url: "https://example.com" }), { status: 200 }))
      : Promise.resolve(new Response(JSON.stringify({ job_id: "j" }), { status: 200 }))) as unknown as typeof fetch;

  const r = await applyTrustLayer(svc, stored(), true, {
    tsa: { fetchImpl: tsaFetch, randomNonce: fixedNonce },
    wayback: { fetchImpl: waybackFetch, accessKey: "a", secretKey: "b" },
  });
  assertEquals(r.tsaStatus, "ok");
  assertEquals(r.waybackStatus, "success");
  assert(r.manifestPath);
  assert(r.tsaPath);
  // manifest + tsr both uploaded
  assertEquals(uploads.length, 2);
  // row stamped once with the trust columns
  assertEquals(updates.length, 1);
  assertEquals(updates[0].tsa_status, "ok");
  assertEquals(updates[0].wayback_status, "success");
});

Deno.test("applyTrustLayer: failed TSA + disabled Wayback → honest statuses, no tsr upload", async () => {
  const { svc, uploads, updates } = fakeSvc();
  const tsaFetch = (() => Promise.reject(new Error("refused"))) as unknown as typeof fetch;
  const r = await applyTrustLayer(svc, stored(), false, {
    tsa: { fetchImpl: tsaFetch, randomNonce: fixedNonce },
    wayback: {}, // no keys + wayback off
  });
  assertEquals(r.tsaStatus.startsWith("failed:"), true);
  assertEquals(r.waybackStatus, "disabled");
  assertEquals(r.tsaPath, null);
  // only the manifest uploaded (no valid token to store)
  assertEquals(uploads.length, 1);
  assertEquals(updates[0].tsa_path, null);
});

Deno.test("applyTrustLayer: a manifest upload failure degrades manifest_path but still stamps statuses", async () => {
  const { svc, updates } = fakeSvc({ uploadError: "bucket down" });
  const r = await applyTrustLayer(svc, stored(), false, {
    tsa: { fetchImpl: (() => Promise.reject(new Error("x"))) as unknown as typeof fetch, randomNonce: fixedNonce },
    wayback: {},
  });
  assertEquals(r.manifestPath, null);
  assertEquals(updates[0].manifest_path, null);
  assert(r.tsaStatus.startsWith("failed:"));
});

Deno.test("applyTrustLayer: manifest OK but tsr upload fails → tsa_status failed:store", async () => {
  // fail ONLY the .tsr upload; the manifest persists fine.
  const { svc, updates } = fakeSvc({ uploadError: "bucket down", failOnly: ".tsr" });
  const { buildManifest } = await import("./tsa.ts");
  const { sha256HexBytes } = await import("./snapshot_store.ts");
  const manifestHash = await sha256HexBytes(new TextEncoder().encode(buildManifest(stored().manifestInput)));
  const tsaFetch = (() =>
    Promise.resolve(new Response(validTsr(manifestHash) as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch;
  const r = await applyTrustLayer(svc, stored(), false, {
    tsa: { fetchImpl: tsaFetch, randomNonce: fixedNonce },
    wayback: {},
  });
  assertEquals(r.manifestPath !== null, true); // manifest stored
  assertEquals(r.tsaStatus, "failed:store");
  assertEquals(updates[0].tsa_status, "failed:store");
});

Deno.test("applyTrustLayer: valid token but manifest upload fails → tsa downgraded to failed:no_manifest, no .tsr stored", async () => {
  // fail ONLY the manifest (.json) upload; the token is valid but attests to a
  // manifest nobody can retrieve, so it must not be presented as 'ok'.
  const { svc, uploads, updates } = fakeSvc({ uploadError: "bucket down", failOnly: ".json" });
  const { buildManifest } = await import("./tsa.ts");
  const { sha256HexBytes } = await import("./snapshot_store.ts");
  const manifestHash = await sha256HexBytes(new TextEncoder().encode(buildManifest(stored().manifestInput)));
  const tsaFetch = (() =>
    Promise.resolve(new Response(validTsr(manifestHash) as unknown as BodyInit, { status: 200 }))) as unknown as typeof fetch;
  const r = await applyTrustLayer(svc, stored(), false, {
    tsa: { fetchImpl: tsaFetch, randomNonce: fixedNonce },
    wayback: {},
  });
  assertEquals(r.manifestPath, null);
  assertEquals(r.tsaStatus, "failed:no_manifest");
  assertEquals(r.tsaPath, null);
  // The .tsr was NOT uploaded (nothing to verify against). Only the failed
  // manifest attempt is recorded.
  assert(!uploads.some((p) => p.endsWith(".tsr")));
  assertEquals(updates[0].tsa_status, "failed:no_manifest");
});
