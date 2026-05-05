/**
 * Signed state helper.
 *
 * Format: `<base64url(json(payload))>.<hex(hmac_sha256(MCP_STATE_SECRET, b64))>`
 *
 * The payload is opaque to the caller but carries the OAuth `client_id`,
 * `redirect_uri`, original client `state`, and `code_challenge` so the
 * callback can rehydrate the flow without a server-side session.
 *
 * We use HMAC-SHA256 with a 32-byte secret (`MCP_STATE_SECRET`). The payload
 * is NOT encrypted — anyone with the token can read it. The HMAC only proves
 * we produced it. Don't put user-sensitive data in here.
 */

export interface StatePayload {
  client_id: string;
  redirect_uri: string;
  state: string;           // original `state` param from client
  code_challenge: string;
  nonce: string;
}

function encoder(): TextEncoder {
  return new TextEncoder();
}

function base64urlEncode(bytes: Uint8Array): string {
  // Deno has btoa on Uint8Array strings — use it, then strip padding / translate chars.
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function getSecret(): string {
  const s = Deno.env.get("MCP_STATE_SECRET");
  if (!s) throw new Error("MCP_STATE_SECRET env var is required");
  if (s.length < 32) {
    throw new Error("MCP_STATE_SECRET must be at least 32 bytes (use `openssl rand -hex 32`)");
  }
  return s;
}

/** HMAC-SHA256(secret, data) → 32-byte digest. */
async function hmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await importKey(secret);
  // Cast: Deno's stricter BufferSource typing rejects Uint8Array<ArrayBufferLike>
  // even though it's runtime-compatible. Safe because we always pass a Uint8Array.
  const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return new Uint8Array(sig);
}

/** Constant-time comparison of two equal-length byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signState(payload: StatePayload): Promise<string> {
  const secret = getSecret();
  const json = JSON.stringify(payload);
  const b64 = base64urlEncode(encoder().encode(json));
  const mac = await hmac(secret, encoder().encode(b64));
  return `${b64}.${toHex(mac)}`;
}

export async function verifyState(token: string): Promise<StatePayload> {
  const secret = getSecret();
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("malformed state token");
  const [b64, hex] = parts;
  const expected = await hmac(secret, encoder().encode(b64));
  let provided: Uint8Array;
  try {
    provided = fromHex(hex);
  } catch {
    throw new Error("malformed state signature");
  }
  if (!timingSafeEqual(expected, provided)) {
    throw new Error("state signature mismatch");
  }
  const json = new TextDecoder().decode(base64urlDecode(b64));
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("malformed state payload");
  }
  if (
    typeof payload !== "object" || payload === null ||
    typeof (payload as StatePayload).client_id !== "string" ||
    typeof (payload as StatePayload).redirect_uri !== "string" ||
    typeof (payload as StatePayload).state !== "string" ||
    typeof (payload as StatePayload).code_challenge !== "string" ||
    typeof (payload as StatePayload).nonce !== "string"
  ) {
    throw new Error("state payload missing required fields");
  }
  return payload as StatePayload;
}

// Re-export helpers used by sibling modules so we only keep one copy.
export { base64urlDecode, base64urlEncode, toHex };
