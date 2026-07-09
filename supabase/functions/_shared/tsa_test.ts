import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  _internal,
  buildManifest,
  buildTsq,
  canonicalJson,
  requestTsaToken,
  type SnapshotManifestInput,
  validateTsr,
} from "./tsa.ts";

const { der, encodeInteger, hexToBytes, bytesToHex, SHA256_OID, NULL_DER, TST_INFO_OID } =
  _internal;

const IMPRINT = "ab".repeat(32); // 32 bytes of 0xAB
const NONCE = new Uint8Array([1, 2, 3, 4]);

// --------------------------------------------------------------------------
// canonicalJson / buildManifest
// --------------------------------------------------------------------------
Deno.test("canonicalJson sorts keys deterministically", () => {
  assertEquals(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assertEquals(canonicalJson({ z: { y: 1, x: 2 }, a: [3, 1] }), '{"a":[3,1],"z":{"x":2,"y":1}}');
  // undefined keys are dropped; null retained.
  assertEquals(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

function manifestInput(over: Partial<SnapshotManifestInput> = {}): SnapshotManifestInput {
  return {
    snapshotId: "s1",
    scoutId: "sc1",
    userId: "u1",
    captureKind: "change",
    fidelity: "full",
    capturedAt: "2026-07-07T00:00:00Z",
    requestedUrl: "https://example.com",
    markdownSha256: "m".repeat(64),
    mhtmlSha256: "h".repeat(64),
    screenshotSha256: "p".repeat(64),
    ...over,
  };
}

Deno.test("buildManifest is deterministic and binds only present artifacts", () => {
  const a = buildManifest(manifestInput());
  const b = buildManifest(manifestInput());
  assertEquals(a, b); // same inputs → same bytes
  assertStringIncludes(a, '"mhtml_sha256"');
  assertStringIncludes(a, '"screenshot_sha256"');
  // markdown_only: no mhtml/screenshot/rawhtml keys
  const md = buildManifest(manifestInput({
    fidelity: "markdown_only",
    mhtmlSha256: null,
    screenshotSha256: null,
  }));
  assert(!md.includes("mhtml_sha256"));
  assert(!md.includes("screenshot_sha256"));
  assertStringIncludes(md, '"markdown_sha256"');
});

// --------------------------------------------------------------------------
// buildTsq — byte fixture
// --------------------------------------------------------------------------
Deno.test("buildTsq produces the exact DER for a fixed imprint + nonce", () => {
  const expected = "303f" + "020101" +
    "3031" + "300d06096086480165030402010500" + "0420" + "ab".repeat(32) +
    "020401020304" + "0101ff";
  assertEquals(bytesToHex(buildTsq(IMPRINT, NONCE)), expected);
});

Deno.test("buildTsq rejects a non-32-byte imprint", () => {
  let threw = false;
  try {
    buildTsq("abcd", NONCE);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("encodeInteger prepends a sign byte when the top bit is set", () => {
  assertEquals(bytesToHex(new Uint8Array(encodeInteger([0x80]))), "020200 80".replace(" ", ""));
  assertEquals(bytesToHex(new Uint8Array(encodeInteger([0x00, 0x00, 0x05]))), "020105");
});

// --------------------------------------------------------------------------
// Synthetic TimeStampResp for validator tests
// --------------------------------------------------------------------------
function synthTsr(opts: {
  status?: number;
  imprintHex?: string;
  nonce?: number[];
  omitNonce?: boolean;
  noToken?: boolean;
} = {}): Uint8Array {
  const status = opts.status ?? 0;
  const statusInfo = der(0x30, encodeInteger([status]));
  const algId = der(0x30, [...SHA256_OID, ...NULL_DER]);
  const imprint = hexToBytes(opts.imprintHex ?? IMPRINT);
  const messageImprint = der(0x30, [...algId, ...der(0x04, imprint)]);
  const version = encodeInteger([1]);
  const serial = encodeInteger([0x12, 0x34]);
  const genTime = der(0x18, [...new TextEncoder().encode("20260707000000Z")]);
  const nonceInt = opts.omitNonce ? [] : encodeInteger([...(opts.nonce ?? [1, 2, 3, 4])]);
  const tstInfo = der(0x30, [...version, ...messageImprint, ...serial, ...genTime, ...nonceInt]);
  const token = der(0x30, [...der(0x06, TST_INFO_OID), ...der(0x04, tstInfo)]);
  const resp = der(0x30, opts.noToken ? statusInfo : [...statusInfo, ...token]);
  return new Uint8Array(resp);
}

Deno.test("validateTsr accepts a granted token with matching imprint + nonce", () => {
  assertEquals(validateTsr(synthTsr(), IMPRINT, NONCE), { ok: true });
  // grantedWithMods (status 1) also accepted
  assertEquals(validateTsr(synthTsr({ status: 1 }), IMPRINT, NONCE), { ok: true });
});

Deno.test("validateTsr rejects PKIStatus=rejection (200-but-rejected)", () => {
  const v = validateTsr(synthTsr({ status: 2 }), IMPRINT, NONCE);
  assertEquals(v.ok, false);
  assertStringIncludes((v as { reason: string }).reason, "rejected:pkistatus_2");
});

Deno.test("validateTsr rejects an imprint mismatch", () => {
  const v = validateTsr(synthTsr({ imprintHex: "cd".repeat(32) }), IMPRINT, NONCE);
  assertEquals(v.ok, false);
  assertStringIncludes((v as { reason: string }).reason, "imprint_mismatch");
});

Deno.test("validateTsr rejects a nonce mismatch / missing nonce", () => {
  const mismatch = validateTsr(synthTsr({ nonce: [9, 9, 9, 9] }), IMPRINT, NONCE);
  assertEquals(mismatch.ok, false);
  assertStringIncludes((mismatch as { reason: string }).reason, "nonce_mismatch");
  const missing = validateTsr(synthTsr({ omitNonce: true }), IMPRINT, NONCE);
  assertEquals(missing.ok, false);
});

Deno.test("validateTsr rejects a response with no token", () => {
  const v = validateTsr(synthTsr({ noToken: true }), IMPRINT, NONCE);
  assertEquals(v.ok, false);
  assertStringIncludes((v as { reason: string }).reason, "no_token");
});

Deno.test("validateTsr rejects unparseable / non-resp bytes", () => {
  assertEquals(validateTsr(new Uint8Array([0x99, 0x99]), IMPRINT, NONCE).ok, false);
  assertEquals(validateTsr(new Uint8Array([0x02, 0x01, 0x01]), IMPRINT, NONCE).ok, false);
});

// --------------------------------------------------------------------------
// requestTsaToken — network paths (mocked)
// --------------------------------------------------------------------------
const fixedNonce = () => NONCE;

Deno.test("requestTsaToken returns ok with the .tsr on a valid token", async () => {
  const fetchImpl = ((_url: string) =>
    Promise.resolve(new Response(synthTsr() as unknown as BodyInit, { status: 200 }))) as
      unknown as typeof fetch;
  const r = await requestTsaToken(IMPRINT, { fetchImpl, randomNonce: fixedNonce });
  assertEquals(r.status, "ok");
  assert(r.tsr instanceof Uint8Array);
});

Deno.test("requestTsaToken returns failed:invalid_token on a 200 rejection (no retry to fallback)", async () => {
  let calls = 0;
  const fetchImpl = ((_url: string) => {
    calls++;
    return Promise.resolve(new Response(synthTsr({ status: 2 }) as unknown as BodyInit, { status: 200 }));
  }) as unknown as typeof fetch;
  const r = await requestTsaToken(IMPRINT, { fetchImpl, randomNonce: fixedNonce });
  assertStringIncludes(r.status, "failed:invalid_token");
  assertEquals(calls, 1); // authoritative answer — does not hit the fallback TSA
  assertEquals(r.tsr, undefined);
});

Deno.test("requestTsaToken tries the fallback TSA on a transport error, then gives up", async () => {
  let calls = 0;
  const fetchImpl = ((_url: string) => {
    calls++;
    return Promise.reject(new Error("connection refused"));
  }) as unknown as typeof fetch;
  const r = await requestTsaToken(IMPRINT, { fetchImpl, randomNonce: fixedNonce });
  assertStringIncludes(r.status, "failed:network");
  assertEquals(calls, 2); // primary + Sectigo fallback
});

Deno.test("requestTsaToken maps a 5xx to failed:http and an abort to failed:timeout", async () => {
  const http5xx = ((_url: string) =>
    Promise.resolve(new Response("busy", { status: 503 }))) as unknown as typeof fetch;
  const r1 = await requestTsaToken(IMPRINT, { fetchImpl: http5xx, randomNonce: fixedNonce });
  assertStringIncludes(r1.status, "failed:http_503");

  const abort = ((_url: string) => {
    const e = new Error("aborted");
    (e as { name: string }).name = "AbortError";
    return Promise.reject(e);
  }) as unknown as typeof fetch;
  const r2 = await requestTsaToken(IMPRINT, { fetchImpl: abort, randomNonce: fixedNonce });
  assertStringIncludes(r2.status, "failed:timeout");
});

Deno.test("requestTsaToken honors an explicit TSA_URL without adding the fallback", async () => {
  const seen: string[] = [];
  const fetchImpl = ((url: string) => {
    seen.push(url);
    return Promise.resolve(new Response(synthTsr() as unknown as BodyInit, { status: 200 }));
  }) as unknown as typeof fetch;
  await requestTsaToken(IMPRINT, {
    fetchImpl,
    randomNonce: fixedNonce,
    tsaUrl: "https://timestamp.sectigo.com",
  });
  assertEquals(seen, ["https://timestamp.sectigo.com"]);
});

Deno.test("requestTsaToken uses a real random nonce by default", async () => {
  const fetchImpl = ((_url: string) =>
    Promise.resolve(new Response(synthTsr() as unknown as BodyInit, { status: 200 }))) as
      unknown as typeof fetch;
  // Default nonce won't match the synthetic token's fixed [1,2,3,4] nonce →
  // invalid_token, but this exercises defaultNonce() (crypto.getRandomValues).
  const r = await requestTsaToken(IMPRINT, { fetchImpl });
  assertStringIncludes(r.status, "failed:invalid_token");
});

// --------------------------------------------------------------------------
// DER edge paths
// --------------------------------------------------------------------------
Deno.test("der emits long-form length for >127-byte content", () => {
  const encoded = _internal.der(0x04, new Array(200).fill(0xaa));
  assertEquals([encoded[0], encoded[1], encoded[2]], [0x04, 0x81, 200]);
  assertEquals(encoded.length, 3 + 200);
});

Deno.test("encodeInteger handles an empty magnitude → 0", () => {
  assertEquals(bytesToHex(new Uint8Array(encodeInteger([]))), "020100");
});

Deno.test("parseTlv reads a multi-byte length and rejects an overrun", () => {
  const tlv = new Uint8Array([0x04, 0x81, 130, ...new Array(130).fill(0x11)]);
  const node = _internal.parseTlv(tlv, 0);
  assertEquals(node.tag, 0x04);
  assertEquals(node.content.length, 130);
  let threw = false;
  try {
    _internal.parseTlv(new Uint8Array([0x04, 0x0a, 0x00, 0x00]), 0);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("validateTsr: token without id-ct-TSTInfo OID → no_tstinfo", () => {
  const { der, encodeInteger, TST_INFO_OID } = _internal;
  const statusInfo = der(0x30, encodeInteger([0]));
  // token whose OID is NOT id-ct-TSTInfo, plus a decoy octet
  const wrongOid = der(0x06, [0x2a, 0x03]);
  const token = der(0x30, [...wrongOid, ...der(0x04, [0x30, 0x00])]);
  const resp = new Uint8Array(der(0x30, [...statusInfo, ...token]));
  const v = validateTsr(resp, IMPRINT, NONCE);
  assertEquals(v.ok, false);
  assertStringIncludes((v as { reason: string }).reason, "no_tstinfo");
  // sanity: TST_INFO_OID is the real one (not the decoy)
  assert(TST_INFO_OID.length > 2);
});

Deno.test("validateTsr: TSTInfo octet that is not a valid SEQUENCE → no_tstinfo (parse guard)", () => {
  const { der, encodeInteger, TST_INFO_OID } = _internal;
  const statusInfo = der(0x30, encodeInteger([0]));
  // octet content = SEQUENCE claiming 5 bytes with none present → parse throws
  const token = der(0x30, [...der(0x06, TST_INFO_OID), ...der(0x04, [0x30, 0x05])]);
  const resp = new Uint8Array(der(0x30, [...statusInfo, ...token]));
  assertEquals(validateTsr(resp, IMPRINT, NONCE).ok, false);
});

Deno.test("validateTsr: nonce with the high bit set round-trips through the sign byte", () => {
  const highNonce = new Uint8Array([0x80, 0x01]);
  const tsr = synthTsr({ nonce: [0x80, 0x01] });
  assertEquals(validateTsr(tsr, IMPRINT, highNonce), { ok: true });
});
