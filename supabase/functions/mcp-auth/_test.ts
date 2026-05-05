/**
 * Deno unit tests for mcp-auth (the MCP-only MuckRock broker).
 *
 * Run:
 *   cd supabase/functions/mcp-auth
 *   deno test _test.ts --allow-env --allow-net --allow-read
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// Set required env BEFORE importing the module so its top-level reads pick
// up our test values. SUPABASE_URL is read by `isValidMcpCallback`; the
// state secret is read by createMcpState/verifyMcpState through stateSecret().
Deno.env.set("SUPABASE_URL", "https://proj.supabase.co");
Deno.env.set(
  "SESSION_SECRET",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
Deno.env.set("PUBLIC_APP_URL", "https://www.cojournalist.ai");
Deno.env.set("MCP_SERVER_BASE_URL", "https://www.cojournalist.ai/mcp");
Deno.env.set("MUCKROCK_CLIENT_ID", "test-client");
Deno.env.set("MUCKROCK_CLIENT_SECRET", "test-secret");

const {
  createMcpState,
  verifyMcpState,
  isValidMcpCallback,
  handleRequest,
} = await import("./index.ts");

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// State token: prefix + verify round-trip
// ---------------------------------------------------------------------------

Deno.test("state: createMcpState produces a tagged 'mcp.' prefix", async () => {
  const token = await createMcpState(SECRET, {
    mcp_callback: "https://www.cojournalist.ai/mcp/authorize-callback",
    mcp_state: "signed-blob",
  });
  if (!token.startsWith("mcp.")) {
    throw new Error(`expected mcp. prefix, got ${token.slice(0, 12)}`);
  }
  // After the prefix it must look like base64url.hex.
  const rest = token.slice(4);
  const dot = rest.indexOf(".");
  if (dot < 0) throw new Error("missing inner dot separator");
  const sig = rest.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) {
    throw new Error(`expected 64-char hex signature, got ${sig.length} chars`);
  }
});

Deno.test("state: verifyMcpState round-trips a freshly created token", async () => {
  const payload = {
    mcp_callback: "https://www.cojournalist.ai/mcp/authorize-callback",
    mcp_state: "client-signed-state-blob",
  };
  const token = await createMcpState(SECRET, payload);
  const decoded = await verifyMcpState(SECRET, token);
  assertExists(decoded);
  assertEquals(decoded?.mcp_callback, payload.mcp_callback);
  assertEquals(decoded?.mcp_state, payload.mcp_state);
});

Deno.test("state: verifyMcpState rejects state without 'mcp.' prefix", async () => {
  // Mimic the auth-muckrock state shape (no prefix). Even with the same
  // secret, mcp-auth must refuse it so a web-flow state can't accidentally
  // be processed as MCP.
  const body = "eyJub25jZSI6ImFiYyJ9";
  const sig = await (async () => {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  })();
  const tokenWithoutPrefix = `${body}.${sig}`;
  const decoded = await verifyMcpState(SECRET, tokenWithoutPrefix);
  assertEquals(decoded, null);
});

Deno.test("state: verifyMcpState rejects tampered signature", async () => {
  const token = await createMcpState(SECRET, {
    mcp_callback: "https://www.cojournalist.ai/mcp/authorize-callback",
    mcp_state: "blob",
  });
  const tampered = token.slice(0, -2) + "00";
  const decoded = await verifyMcpState(SECRET, tampered);
  assertEquals(decoded, null);
});

// ---------------------------------------------------------------------------
// mcp_callback validation
// ---------------------------------------------------------------------------

Deno.test("isValidMcpCallback: accepts public MCP host /mcp/* path", () => {
  if (!isValidMcpCallback("https://www.cojournalist.ai/mcp/authorize-callback")) {
    throw new Error("public mcp callback should be accepted");
  }
});

Deno.test("isValidMcpCallback: accepts raw Supabase host /functions/v1/mcp-server/* path", () => {
  if (!isValidMcpCallback(
    "https://proj.supabase.co/functions/v1/mcp-server/authorize-callback",
  )) {
    throw new Error("supabase mcp callback should be accepted");
  }
});

Deno.test("isValidMcpCallback: rejects arbitrary path on the public host", () => {
  if (isValidMcpCallback("https://www.cojournalist.ai/anywhere")) {
    throw new Error("non-/mcp path on public host must be rejected");
  }
});

Deno.test("isValidMcpCallback: rejects an unrelated host", () => {
  if (isValidMcpCallback("https://evil.example/mcp/authorize-callback")) {
    throw new Error("unrelated host must be rejected");
  }
});

Deno.test("isValidMcpCallback: rejects malformed URL", () => {
  if (isValidMcpCallback("not-a-url")) {
    throw new Error("malformed URL must be rejected");
  }
});

// ---------------------------------------------------------------------------
// HTTP surface — login validation paths
// ---------------------------------------------------------------------------

Deno.test("login: rejects missing mcp_callback", async () => {
  const req = new Request(
    "https://x/functions/v1/mcp-auth/login?mcp_state=abc",
    { method: "GET" },
  );
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "mcp_callback and mcp_state are required");
});

Deno.test("login: rejects mcp_callback pointing at an arbitrary host", async () => {
  const req = new Request(
    "https://x/functions/v1/mcp-auth/login?mcp_callback=" +
      encodeURIComponent("https://evil.example/mcp/x") +
      "&mcp_state=abc",
    { method: "GET" },
  );
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "invalid mcp_callback");
});

Deno.test("login: 302s to MuckRock authorize with state preserved", async () => {
  const req = new Request(
    "https://x/functions/v1/mcp-auth/login?mcp_callback=" +
      encodeURIComponent("https://www.cojournalist.ai/mcp/authorize-callback") +
      "&mcp_state=client-signed",
    { method: "GET" },
  );
  const res = await handleRequest(req);
  assertEquals(res.status, 302);
  const loc = res.headers.get("location") ?? "";
  if (!loc.startsWith("https://accounts.muckrock.com/openid/authorize?")) {
    throw new Error(`unexpected location ${loc}`);
  }
  const qs = new URL(loc).searchParams;
  assertEquals(qs.get("client_id"), "test-client");
  assertEquals(qs.get("response_type"), "code");
  assertEquals(qs.get("redirect_uri"), "https://www.cojournalist.ai/api/auth/callback");
  const state = qs.get("state") ?? "";
  if (!state.startsWith("mcp.")) {
    throw new Error(`expected mcp. state prefix, got ${state.slice(0, 8)}`);
  }
});

// ---------------------------------------------------------------------------
// HTTP surface — callback bounces unauthenticated errors safely back
// ---------------------------------------------------------------------------

Deno.test("callback: with provider error and a valid state, 302s back to mcp_callback with ?error", async () => {
  const state = await createMcpState(SECRET, {
    mcp_callback: "https://www.cojournalist.ai/mcp/authorize-callback",
    mcp_state: "client-signed",
  });
  const req = new Request(
    `https://x/functions/v1/mcp-auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  );
  const res = await handleRequest(req);
  assertEquals(res.status, 302);
  const loc = res.headers.get("location") ?? "";
  const u = new URL(loc);
  assertEquals(u.host, "www.cojournalist.ai");
  assertEquals(u.pathname, "/mcp/authorize-callback");
  assertEquals(u.searchParams.get("error"), "access_denied");
  assertEquals(u.searchParams.get("mcp_state"), "client-signed");
});

Deno.test("callback: with no state and no code, returns 400 JSON", async () => {
  const req = new Request("https://x/functions/v1/mcp-auth/callback", { method: "GET" });
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
});

Deno.test("callback: with malformed (non-mcp.) state, returns 400 JSON not 302", async () => {
  const req = new Request(
    "https://x/functions/v1/mcp-auth/callback?code=abc&state=eyJhbGciOiJIUzI1NiJ9.signature",
    { method: "GET" },
  );
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

Deno.test("routing: unknown path returns 404 JSON", async () => {
  const req = new Request("https://x/functions/v1/mcp-auth/unknown", { method: "GET" });
  const res = await handleRequest(req);
  assertEquals(res.status, 404);
});

Deno.test("routing: /login with POST returns 404 (only GET)", async () => {
  const req = new Request("https://x/functions/v1/mcp-auth/login", { method: "POST" });
  const res = await handleRequest(req);
  assertEquals(res.status, 404);
});
