/**
 * Deno unit tests for mcp-auth (server-side mint flow).
 *
 * Run:
 *   cd supabase/functions/mcp-auth
 *   deno test _test.ts --allow-env --allow-net --allow-read
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// Set required env BEFORE importing the modules so top-level reads pick
// up our test values.
Deno.env.set("SUPABASE_URL", "https://proj.supabase.co");
Deno.env.set(
  "SESSION_SECRET",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
Deno.env.set(
  "MCP_STATE_SECRET",
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
);
Deno.env.set("PUBLIC_APP_URL", "https://www.cojournalist.ai");
Deno.env.set("MUCKROCK_CLIENT_ID", "test-client");
Deno.env.set("MUCKROCK_CLIENT_SECRET", "test-secret");

const { signState } = await import("./mcp_server_state.ts");
const {
  createBrokerState,
  verifyBrokerState,
  handleRequest,
} = await import("./index.ts");

const BROKER_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function makeMcpServerState(overrides: Record<string, string> = {}): Promise<string> {
  return await signState({
    client_id: "11111111-2222-3333-4444-555555555555",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    state: "client-anti-csrf",
    code_challenge: "abc123challenge",
    nonce: "nonce-stub",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Broker state: prefix + verify round-trip
// ---------------------------------------------------------------------------

Deno.test("broker state: createBrokerState produces a tagged 'mcp.' prefix", async () => {
  const token = await createBrokerState(BROKER_SECRET, { mcp_state: "x" });
  if (!token.startsWith("mcp.")) {
    throw new Error(`expected mcp. prefix, got ${token.slice(0, 12)}`);
  }
});

Deno.test("broker state: verifyBrokerState round-trips a fresh token", async () => {
  const token = await createBrokerState(BROKER_SECRET, { mcp_state: "embedded-blob" });
  const decoded = await verifyBrokerState(BROKER_SECRET, token);
  assertExists(decoded);
  assertEquals(decoded?.mcp_state, "embedded-blob");
});

Deno.test("broker state: rejects state without 'mcp.' prefix", async () => {
  // Same secret, no prefix — must still be rejected so a web-flow state
  // can't accidentally be processed as MCP.
  const decoded = await verifyBrokerState(BROKER_SECRET, "eyJub25jZSI6ImFiYyJ9.deadbeef");
  assertEquals(decoded, null);
});

Deno.test("broker state: rejects tampered signature", async () => {
  const token = await createBrokerState(BROKER_SECRET, { mcp_state: "x" });
  const tampered = token.slice(0, -2) + "00";
  const decoded = await verifyBrokerState(BROKER_SECRET, tampered);
  assertEquals(decoded, null);
});

// ---------------------------------------------------------------------------
// /login surface
// ---------------------------------------------------------------------------

Deno.test("login: rejects missing mcp_state", async () => {
  const req = new Request("https://x/functions/v1/mcp-auth/login", { method: "GET" });
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "mcp_state required");
});

Deno.test("login: rejects mcp_state not signed by mcp-server's secret", async () => {
  const req = new Request(
    "https://x/functions/v1/mcp-auth/login?mcp_state=" +
      encodeURIComponent("eyJjbGllbnRfaWQiOiJ4In0.deadbeef"),
    { method: "GET" },
  );
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "invalid mcp_state");
});

Deno.test("login: 302s to MuckRock authorize with broker-tagged state", async () => {
  const mcpState = await makeMcpServerState();
  const req = new Request(
    "https://x/functions/v1/mcp-auth/login?mcp_state=" + encodeURIComponent(mcpState),
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
// /callback error paths (the success path requires a real MuckRock + DB and
// is exercised end-to-end against the deployed function, not in unit tests)
// ---------------------------------------------------------------------------

Deno.test("callback: missing state returns 400 JSON", async () => {
  const req = new Request("https://x/functions/v1/mcp-auth/callback", { method: "GET" });
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "missing state");
});

Deno.test("callback: state without 'mcp.' prefix returns 400 JSON, never 302s", async () => {
  const req = new Request(
    "https://x/functions/v1/mcp-auth/callback?code=abc&state=eyJhbGciOiJIUzI1NiJ9.deadbeef",
    { method: "GET" },
  );
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
});

Deno.test("callback: provider error with valid broker state bounces to client redirect_uri", async () => {
  // mcp-server's signed state carries the redirect_uri; mcp-auth's broker
  // state wraps it. On a MuckRock ?error=… we must 302 to the client's
  // callback with ?error=…&state=… instead of stranding the user.
  const mcpState = await makeMcpServerState({ state: "client-anti-csrf" });
  const brokerState = await createBrokerState(BROKER_SECRET, { mcp_state: mcpState });
  const req = new Request(
    `https://x/functions/v1/mcp-auth/callback?error=access_denied&state=${
      encodeURIComponent(brokerState)
    }`,
    { method: "GET" },
  );
  const res = await handleRequest(req);
  assertEquals(res.status, 302);
  const loc = new URL(res.headers.get("location") ?? "");
  assertEquals(loc.host, "claude.ai");
  assertEquals(loc.pathname, "/api/mcp/auth_callback");
  assertEquals(loc.searchParams.get("error"), "access_denied");
  assertEquals(loc.searchParams.get("state"), "client-anti-csrf");
});

Deno.test("callback: missing code with valid broker state bounces invalid_request to client", async () => {
  const mcpState = await makeMcpServerState();
  const brokerState = await createBrokerState(BROKER_SECRET, { mcp_state: mcpState });
  const req = new Request(
    `https://x/functions/v1/mcp-auth/callback?state=${encodeURIComponent(brokerState)}`,
    { method: "GET" },
  );
  const res = await handleRequest(req);
  assertEquals(res.status, 302);
  const loc = new URL(res.headers.get("location") ?? "");
  assertEquals(loc.searchParams.get("error"), "invalid_request");
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

Deno.test("routing: /callback with POST returns 404 (only GET)", async () => {
  const req = new Request("https://x/functions/v1/mcp-auth/callback", { method: "POST" });
  const res = await handleRequest(req);
  assertEquals(res.status, 404);
});
