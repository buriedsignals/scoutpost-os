/**
 * Trust layer part 1 — RFC 3161 trusted timestamps (PAGE-ARCHIVE-PRD U4, KTD5).
 *
 * Builds a canonical-JSON manifest binding every artifact hash + content hash +
 * capture metadata for one snapshot, then obtains an independent RFC 3161
 * timestamp token over that manifest's SHA-256. The token proves the manifest
 * (and therefore every artifact) existed at time T on a third-party authority's
 * clock — the load-bearing integrity layer.
 *
 * Evidence integrity is the product: `tsa_status='ok'` is stored ONLY after the
 * returned token is validated — RFC 3161 TSAs answer HTTP 200 with
 * `PKIStatus=rejection`, so a 200 alone is not proof. We confirm the PKIStatus
 * is granted/grantedWithMods, the token's messageImprint equals the hash we
 * submitted, and our random nonce is echoed. Any mismatch → `failed:*`, bytes
 * discarded. We do NOT verify the CMS signature here; `certReq=true` embeds the
 * signing chain so the stored `.tsr` stays verifiable later with
 * `openssl ts -verify` (U4 verification step / U7 docs).
 *
 * The DER is hand-rolled because the request is a small fixed ASN.1 structure
 * and pulling a full ASN.1 library into an Edge Function isolate is not worth
 * it; the token parse is a generic TLV walk scoped to exactly the fields we
 * validate.
 */

// --------------------------------------------------------------------------
// Canonical manifest
// --------------------------------------------------------------------------

export interface SnapshotManifestInput {
  version?: number;
  snapshotId: string;
  scoutId: string;
  userId: string;
  scoutRunId?: string | null;
  captureKind: string;
  fidelity: string;
  servedBy?: string | null;
  capturedAt: string;
  requestedUrl: string;
  finalUrl?: string | null;
  httpStatus?: number | null;
  contentSha256?: string | null;
  canonicalContentSha256?: string | null;
  markdownSha256: string;
  mhtmlSha256?: string | null;
  screenshotSha256?: string | null;
  rawhtmlSha256?: string | null;
}

/** Deterministic JSON: object keys sorted recursively, no insignificant
 * whitespace. Same inputs → same bytes → same hash (a manifest invariant, so a
 * re-run over identical evidence produces an identical timestamp target). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${
    keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")
  }}`;
}

/** Build the canonical manifest string. Only artifact hashes that exist are
 * included (KTD9: rendered_thirdparty binds rawhtml+screenshot, markdown_only
 * binds markdown alone) — the manifest describes exactly what was stored. */
export function buildManifest(input: SnapshotManifestInput): string {
  const m: Record<string, unknown> = {
    manifest_version: input.version ?? 1,
    snapshot_id: input.snapshotId,
    scout_id: input.scoutId,
    user_id: input.userId,
    scout_run_id: input.scoutRunId ?? null,
    capture_kind: input.captureKind,
    fidelity: input.fidelity,
    served_by: input.servedBy ?? null,
    captured_at: input.capturedAt,
    requested_url: input.requestedUrl,
    final_url: input.finalUrl ?? null,
    http_status: input.httpStatus ?? null,
    content_sha256: input.contentSha256 ?? null,
    canonical_content_sha256: input.canonicalContentSha256 ?? null,
    markdown_sha256: input.markdownSha256,
  };
  if (input.mhtmlSha256) m.mhtml_sha256 = input.mhtmlSha256;
  if (input.screenshotSha256) m.screenshot_sha256 = input.screenshotSha256;
  if (input.rawhtmlSha256) m.rawhtml_sha256 = input.rawhtmlSha256;
  return canonicalJson(m);
}

// --------------------------------------------------------------------------
// DER encoding (minimal)
// --------------------------------------------------------------------------

function encodeLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: number[]): number[] {
  return [tag, ...encodeLength(content.length), ...content];
}

/** Encode big-endian magnitude bytes as a positive DER INTEGER: strip leading
 * zeros (keep one if all zero) and prepend 0x00 when the top bit is set, so the
 * value never reads as negative. */
function encodeInteger(magnitude: number[]): number[] {
  let bytes = [...magnitude];
  while (bytes.length > 1 && bytes[0] === 0x00) bytes = bytes.slice(1);
  if (bytes.length === 0) bytes = [0x00];
  if (bytes[0] & 0x80) bytes = [0x00, ...bytes];
  return der(0x02, bytes);
}

// AlgorithmIdentifier for SHA-256: SEQUENCE { OID 2.16.840.1.101.3.4.2.1, NULL }
const SHA256_OID = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const NULL_DER = [0x05, 0x00];
// id-ct-TSTInfo = 1.2.840.113549.1.9.16.1.4
const TST_INFO_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04];

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function bytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a DER-encoded RFC 3161 TimeStampReq over a SHA-256 imprint, with
 * `certReq=true` and the given nonce. Nonce bytes are passed in (not generated)
 * so the encoding is deterministic and byte-testable.
 *
 * TimeStampReq ::= SEQUENCE { version INTEGER(1), messageImprint, nonce
 * INTEGER, certReq BOOLEAN }
 */
export function buildTsq(imprintHex: string, nonce: Uint8Array): Uint8Array {
  const imprint = hexToBytes(imprintHex);
  if (imprint.length !== 32) {
    throw new Error(`SHA-256 imprint must be 32 bytes, got ${imprint.length}`);
  }
  const algId = der(0x30, [...SHA256_OID, ...NULL_DER]);
  const messageImprint = der(0x30, [...algId, ...der(0x04, imprint)]);
  const version = encodeInteger([0x01]);
  const nonceInt = encodeInteger([...nonce]);
  const certReq = [0x01, 0x01, 0xff]; // BOOLEAN TRUE
  const req = der(0x30, [...version, ...messageImprint, ...nonceInt, ...certReq]);
  return new Uint8Array(req);
}

// --------------------------------------------------------------------------
// DER parsing (generic TLV walk)
// --------------------------------------------------------------------------

interface Tlv {
  tag: number;
  content: Uint8Array; // raw content bytes (value)
  children: Tlv[]; // parsed sub-TLVs for constructed types
  start: number;
  end: number;
}

function readLength(buf: Uint8Array, pos: number): { len: number; next: number } {
  let b = buf[pos];
  if ((b & 0x80) === 0) return { len: b, next: pos + 1 };
  const n = b & 0x7f;
  if (n === 0 || n > 4) throw new Error("unsupported DER length");
  let len = 0;
  let p = pos + 1;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[p++];
  return { len, next: p };
}

function parseTlv(buf: Uint8Array, pos: number): Tlv {
  const tag = buf[pos];
  const { len, next } = readLength(buf, pos + 1);
  const contentStart = next;
  const contentEnd = contentStart + len;
  if (contentEnd > buf.length) throw new Error("DER length overruns buffer");
  const content = buf.subarray(contentStart, contentEnd);
  const children: Tlv[] = [];
  // Constructed (bit 6 set) → parse children. Context [0] EXPLICIT (0xA0) too.
  if ((tag & 0x20) !== 0) {
    let p = contentStart;
    while (p < contentEnd) {
      const child = parseTlv(buf, p);
      children.push(child);
      p = child.end;
    }
  }
  return { tag, content, children, start: pos, end: contentEnd };
}

function eq(a: Uint8Array, b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Depth-first search for the first node satisfying pred. */
function findNode(node: Tlv, pred: (n: Tlv) => boolean): Tlv | null {
  if (pred(node)) return node;
  for (const c of node.children) {
    const found = findNode(c, pred);
    if (found) return found;
  }
  return null;
}

/** Locate TSTInfo inside a TimeStampToken: find the id-ct-TSTInfo OID, then the
 * eContent OCTET STRING that follows in its encapContentInfo SEQUENCE, and
 * parse that OCTET STRING's bytes as the TSTInfo SEQUENCE. */
function extractTstInfo(root: Tlv): Tlv | null {
  const oidNode = findNode(
    root,
    (n) => n.tag === 0x06 && eq(n.content, TST_INFO_OID),
  );
  if (!oidNode) return null;
  // The eContent is an [0] EXPLICIT wrapper somewhere under the same
  // encapContentInfo. Find, anywhere in the tree, an OCTET STRING (possibly
  // nested under [0]) whose bytes parse as a SEQUENCE — the TSTInfo. Scope the
  // search to the token to avoid the top-level status; the OID is only in the
  // token, so searching from root for the nearest following OCTET STRING is
  // sufficient in practice. We parse the first OCTET STRING after the OID.
  const octet = findOctetAfter(root, oidNode.start);
  if (!octet) return null;
  try {
    const tst = parseTlv(octet.content, 0);
    return tst.tag === 0x30 ? tst : null;
  } catch {
    return null;
  }
}

function findOctetAfter(node: Tlv, afterStart: number): Tlv | null {
  let best: Tlv | null = null;
  const walk = (n: Tlv) => {
    if (n.tag === 0x04 && n.start > afterStart) {
      if (best === null || n.start < best.start) best = n;
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return best;
}

export type TsaVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a TimeStampResp against the imprint we submitted and the nonce we
 * sent. Requires PKIStatus granted(0)/grantedWithMods(1), the token's
 * messageImprint hashedMessage == our imprint, and our nonce echoed in TSTInfo.
 */
export function validateTsr(
  tsr: Uint8Array,
  expectedImprintHex: string,
  expectedNonce: Uint8Array,
): TsaVerdict {
  let root: Tlv;
  try {
    root = parseTlv(tsr, 0);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (root.tag !== 0x30 || root.children.length === 0) {
    return { ok: false, reason: "not_a_timestampresp" };
  }
  // PKIStatusInfo is the first element; its first INTEGER child is PKIStatus.
  const statusInfo = root.children[0];
  const statusInt = statusInfo.children.find((c) => c.tag === 0x02);
  if (!statusInt || statusInt.content.length === 0) {
    return { ok: false, reason: "no_status" };
  }
  const status = statusInt.content[statusInt.content.length - 1];
  if (status !== 0 && status !== 1) {
    return { ok: false, reason: `rejected:pkistatus_${status}` };
  }
  // Token present?
  if (root.children.length < 2) {
    return { ok: false, reason: "no_token" };
  }
  const tst = extractTstInfo(root);
  if (!tst) return { ok: false, reason: "no_tstinfo" };

  // messageImprint: the SEQUENCE child that holds an algorithm SEQUENCE + an
  // OCTET STRING (hashedMessage). Compare the OCTET STRING to our imprint.
  const wantImprint = expectedImprintHex.toLowerCase();
  let imprintOk = false;
  for (const c of tst.children) {
    if (c.tag !== 0x30) continue;
    const octet = c.children.find((g) => g.tag === 0x04);
    if (octet && bytesToHex(octet.content) === wantImprint) {
      imprintOk = true;
      break;
    }
  }
  if (!imprintOk) return { ok: false, reason: "imprint_mismatch" };

  // nonce: an INTEGER in TSTInfo equal to the nonce we sent. serialNumber is
  // also an INTEGER, so match by value (our nonce is random; collision is nil).
  const wantNonce = normalizeInt(expectedNonce);
  const nonceOk = tst.children.some(
    (c) => c.tag === 0x02 && bytesToHex(normalizeInt(c.content)) === bytesToHex(wantNonce),
  );
  if (!nonceOk) return { ok: false, reason: "nonce_mismatch" };

  return { ok: true };
}

/** Strip a single leading DER sign byte / leading zeros for value comparison. */
function normalizeInt(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0x00) i++;
  return bytes.subarray(i);
}

// --------------------------------------------------------------------------
// TSA request (network, single attempt, non-fatal)
// --------------------------------------------------------------------------

const DEFAULT_TSA_URL = "http://timestamp.digicert.com";
const TSA_ABORT_MS = 15_000;

export interface TsaResult {
  status: "ok" | "disabled" | string; // "failed:<class>" otherwise
  tsr?: Uint8Array;
  nonce?: Uint8Array;
}

export interface TsaDeps {
  fetchImpl?: typeof fetch;
  randomNonce?: () => Uint8Array;
  tsaUrl?: string;
}

function tsaUrls(explicit?: string): string[] {
  const primary = explicit ?? Deno.env.get("TSA_URL") ?? DEFAULT_TSA_URL;
  // Sectigo fallback (KTD5) unless the operator pinned a specific TSA_URL.
  const fallback = "http://timestamp.sectigo.com";
  return primary === fallback ? [primary] : [primary, fallback];
}

/**
 * Request an RFC 3161 token over `manifestHashHex`. Single attempt per URL
 * (primary then fallback), bounded, never throws. A validated token → `ok` with
 * the raw `.tsr` bytes; a reachable-but-invalid response → `failed:<class>`
 * (bytes discarded — never sealed as evidence); no reachable TSA → the last
 * failure class. The stored token is honest: a snapshot without a valid token
 * is still a snapshot, labeled `failed:*`.
 */
export async function requestTsaToken(
  manifestHashHex: string,
  deps: TsaDeps = {},
): Promise<TsaResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nonce = (deps.randomNonce ?? defaultNonce)();
  const tsq = buildTsq(manifestHashHex, nonce);
  let lastClass = "failed:unreachable";
  for (const url of tsaUrls(deps.tsaUrl)) {
    const ac = new AbortController();
    const fuse = setTimeout(() => ac.abort(), TSA_ABORT_MS);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/timestamp-query",
          "Accept": "application/timestamp-reply",
        },
        // Cast: newer Deno lib types `Uint8Array<ArrayBufferLike>` as not
        // assignable to BodyInit (typed-array generic variance). The bytes are
        // a valid BufferSource at runtime.
        body: tsq as unknown as BodyInit,
        redirect: "error",
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(fuse);
      lastClass = (e as { name?: string }).name === "AbortError"
        ? "failed:timeout"
        : "failed:network";
      continue;
    }
    clearTimeout(fuse);
    if (!res.ok) {
      await res.body?.cancel();
      lastClass = `failed:http_${res.status}`;
      continue;
    }
    const tsr = new Uint8Array(await res.arrayBuffer());
    const verdict = validateTsr(tsr, manifestHashHex, nonce);
    if (verdict.ok) return { status: "ok", tsr, nonce };
    lastClass = `failed:invalid_token`;
    // A validated-invalid token is authoritative (the TSA answered) — stop.
    return { status: lastClass, nonce };
  }
  return { status: lastClass, nonce };
}

function defaultNonce(): Uint8Array {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[0] &= 0x7f; // keep positive-ish; encodeInteger handles the sign byte anyway
  return b;
}

export const _internal = {
  encodeInteger,
  der,
  parseTlv,
  extractTstInfo,
  bytesToHex,
  hexToBytes,
  SHA256_OID,
  NULL_DER,
  TST_INFO_OID,
};
