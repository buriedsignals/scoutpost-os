/**
 * Deno tests for mcp-server (Plan 03 PR 1+2 — OAuth skeleton).
 *
 * Scope:
 *   - Pure unit tests for ./oauth/pkce.ts and ./oauth/state.ts
 *   - HTTP integration tests against the local supabase stack for
 *     /.well-known/oauth-authorization-server, /register, /authorize,
 *     and /token.
 *
 * Full OAuth round-trip with a fake broker is PR 3 (Plan 03 §PR 5).
 *
 * Run:
 *   supabase start
 *   supabase functions serve mcp-server --no-verify-jwt \
 *     --env-file supabase/.env.test.local      # MCP_STATE_SECRET set here
 *   cd supabase/functions/mcp-server
 *   deno test _test.ts --allow-env --allow-net --allow-read
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { functionUrl } from "../_shared/_testing.ts";

// Direct imports for unit tests (no network / DB).
import { base64urlEncode, signState, verifyState } from "./oauth/state.ts";
import { validateVerifier, verifyS256 } from "./oauth/pkce.ts";
import { metadataHandler, protectedResourceHandler } from "./oauth/metadata.ts";
import { handleRequest } from "./index.ts";
import { MCP_PROTOCOL_VERSION } from "./rpc.ts";

// ---------------------------------------------------------------------------
// Ensure MCP_STATE_SECRET is set for the unit tests. Use a deterministic
// 64-char hex secret; tests must not depend on prod secrets.
// ---------------------------------------------------------------------------
if (!Deno.env.get("MCP_STATE_SECRET")) {
  Deno.env.set(
    "MCP_STATE_SECRET",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
}

// ---------------------------------------------------------------------------
// Metadata unit tests
// ---------------------------------------------------------------------------

Deno.test("metadata: issuer and endpoints use MCP_SERVER_BASE_URL when set", async () => {
  const original = Deno.env.get("MCP_SERVER_BASE_URL");
  Deno.env.set("MCP_SERVER_BASE_URL", "https://www.scoutpost.ai/mcp/");
  try {
    const res = metadataHandler(
      new Request(
        "https://ignored.test/.well-known/oauth-authorization-server",
      ),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.issuer, "https://www.scoutpost.ai/mcp");
    assertEquals(
      body.authorization_endpoint,
      "https://www.scoutpost.ai/mcp/authorize",
    );
    assertEquals(body.token_endpoint, "https://www.scoutpost.ai/mcp/token");
    assertEquals(
      body.registration_endpoint,
      "https://www.scoutpost.ai/mcp/register",
    );
  } finally {
    if (original === undefined) Deno.env.delete("MCP_SERVER_BASE_URL");
    else Deno.env.set("MCP_SERVER_BASE_URL", original);
  }
});

Deno.test("metadata: protected resource advertises same MCP resource", async () => {
  const original = Deno.env.get("MCP_SERVER_BASE_URL");
  Deno.env.set("MCP_SERVER_BASE_URL", "https://www.scoutpost.ai/mcp/");
  try {
    const res = protectedResourceHandler(
      new Request("https://ignored.test/.well-known/oauth-protected-resource"),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.resource, "https://www.scoutpost.ai/mcp");
    assertEquals(body.authorization_servers, [
      "https://www.scoutpost.ai/mcp",
    ]);
    assertEquals(body.bearer_methods_supported, ["header"]);
    assertEquals(body.scopes_supported, ["mcp"]);
    assertEquals(
      body.resource_documentation,
      "https://www.scoutpost.ai/skills/scoutpost.md",
    );
  } finally {
    if (original === undefined) Deno.env.delete("MCP_SERVER_BASE_URL");
    else Deno.env.set("MCP_SERVER_BASE_URL", original);
  }
});

// ---------------------------------------------------------------------------
// MCP Streamable HTTP discovery unit tests
//
// These exercise the index.ts router directly so they run without a live
// supabase stack. They guard against silent regressions in the contract
// MCP clients (claude.ai, Claude Desktop, Claude Code) probe before
// initiating OAuth — i.e. HEAD /, GET /, and the initialize / tools/list
// pair. See CLAUDE.md note about the Vetticaden "Missing MCP Playbook"
// findings if any of these change.
// ---------------------------------------------------------------------------

Deno.test("router: HEAD / without bearer returns 401 with WWW-Authenticate", async () => {
  // Why: Anthropic's Cowork connector card uses the very first HEAD probe
  // to choose between "Configure" (200 → reachable, no auth) and "Connect"
  // (401 → auth required, kick off DCR+OAuth). Returning 200 here makes
  // the card silently default to Configure and the user has to manually
  // disconnect+reconnect to trigger auth — the symptom we shipped on
  // 2026-05-05 even after gating the POST initialize handshake.
  const res = await handleRequest(
    new Request("https://example.test/", { method: "HEAD" }),
  );
  assertEquals(res.status, 401);
  const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
  assertStringIncludes(wwwAuth, "Bearer");
  assertStringIncludes(wwwAuth, "resource_metadata=");
  assertEquals(res.headers.get("MCP-Protocol-Version"), MCP_PROTOCOL_VERSION);
  assertStringIncludes(res.headers.get("Allow") ?? "", "POST");
});

Deno.test("router: HEAD / with bearer returns 200 (still a valid liveness probe)", async () => {
  const res = await handleRequest(
    new Request("https://example.test/", {
      method: "HEAD",
      headers: { authorization: "Bearer dummy-token" },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("MCP-Protocol-Version"), MCP_PROTOCOL_VERSION);
  assertStringIncludes(res.headers.get("Allow") ?? "", "POST");
});

Deno.test("router: GET / returns 405 with Allow: POST (not 404 / 501)", async () => {
  const res = await handleRequest(
    new Request("https://example.test/", { method: "GET" }),
  );
  assertEquals(res.status, 405);
  assertStringIncludes(res.headers.get("Allow") ?? "", "POST");
});

Deno.test("rpc: initialize without bearer returns HTTP 401 with WWW-Authenticate", async () => {
  // Why: Anthropic's Cowork connector card defaults to "Configure"
  // (auth optional) instead of "Connect" (auth required) when initialize
  // succeeds without auth. Returning 401 + WWW-Authenticate up front
  // tells the client this resource is OAuth-protected so it kicks off
  // DCR + the OAuth flow on the very first probe instead of forcing the
  // user to disconnect+reconnect to trigger auth.
  const original = Deno.env.get("MCP_SERVER_BASE_URL");
  Deno.env.set("MCP_SERVER_BASE_URL", "https://www.scoutpost.ai/mcp");
  try {
    const res = await handleRequest(
      new Request("https://example.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "deno-test", version: "0" },
          },
        }),
      }),
    );
    assertEquals(res.status, 401);
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    assertStringIncludes(wwwAuth, "Bearer");
    assertStringIncludes(
      wwwAuth,
      `resource_metadata="https://www.scoutpost.ai/mcp/.well-known/oauth-protected-resource"`,
    );
    await res.body?.cancel();
  } finally {
    if (original === undefined) Deno.env.delete("MCP_SERVER_BASE_URL");
    else Deno.env.set("MCP_SERVER_BASE_URL", original);
  }
});

Deno.test("rpc: notifications/initialized without bearer returns 401, not 202", async () => {
  // Same rationale as initialize: the auth gate runs before method
  // dispatch, so any unauthenticated probe is challenged uniformly.
  const res = await handleRequest(
    new Request("https://example.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }),
  );
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("rpc: negotiateProtocolVersion echoes supported and falls back otherwise", async () => {
  const { negotiateProtocolVersion } = await import("./rpc.ts");
  assertEquals(negotiateProtocolVersion("2025-06-18"), "2025-06-18");
  assertEquals(negotiateProtocolVersion("2025-03-26"), "2025-03-26");
  assertEquals(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assertEquals(negotiateProtocolVersion("1999-01-01"), MCP_PROTOCOL_VERSION);
  assertEquals(negotiateProtocolVersion(undefined), MCP_PROTOCOL_VERSION);
  assertEquals(negotiateProtocolVersion(""), MCP_PROTOCOL_VERSION);
});

Deno.test("rpc: tools/list without bearer returns HTTP 401 with WWW-Authenticate", async () => {
  const original = Deno.env.get("MCP_SERVER_BASE_URL");
  Deno.env.set("MCP_SERVER_BASE_URL", "https://www.scoutpost.ai/mcp");
  try {
    const res = await handleRequest(
      new Request("https://example.test/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        }),
      }),
    );
    // HTTP 401 (not JSON-RPC error inside 200) — without this MCP clients
    // never trigger the OAuth flow.
    assertEquals(res.status, 401);
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    assertStringIncludes(wwwAuth, "Bearer");
    assertStringIncludes(
      wwwAuth,
      `resource_metadata="https://www.scoutpost.ai/mcp/.well-known/oauth-protected-resource"`,
    );
    await res.body?.cancel();
  } finally {
    if (original === undefined) Deno.env.delete("MCP_SERVER_BASE_URL");
    else Deno.env.set("MCP_SERVER_BASE_URL", original);
  }
});

// ---------------------------------------------------------------------------
// PKCE unit tests
// ---------------------------------------------------------------------------

Deno.test("pkce: verifier shorter than 43 chars is rejected", () => {
  let threw = false;
  try {
    validateVerifier("a".repeat(42));
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "too short");
  }
  assertEquals(threw, true);
});

Deno.test("pkce: verifier longer than 128 chars is rejected", () => {
  let threw = false;
  try {
    validateVerifier("a".repeat(129));
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "too long");
  }
  assertEquals(threw, true);
});

Deno.test("pkce: verifier with invalid chars is rejected", () => {
  const bad = "a".repeat(42) + "!"; // length 43 but contains '!'
  let threw = false;
  try {
    validateVerifier(bad);
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "invalid characters");
  }
  assertEquals(threw, true);
});

Deno.test("pkce: valid verifier of minimum length is accepted", () => {
  validateVerifier("A".repeat(43));
});

Deno.test("pkce: valid verifier of maximum length is accepted", () => {
  validateVerifier("A".repeat(128));
});

Deno.test("pkce: verifyS256 round-trip matches challenge", async () => {
  // Reference vector from RFC 7636 Appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = base64urlEncode(digest);
  assertEquals(await verifyS256(verifier, challenge), true);
  assertEquals(await verifyS256(verifier, challenge + "x"), false);
});

// ---------------------------------------------------------------------------
// State sign/verify
// ---------------------------------------------------------------------------

Deno.test("state: sign + verify round-trip recovers payload", async () => {
  const payload = {
    client_id: "11111111-1111-1111-1111-111111111111",
    redirect_uri: "https://client.example/cb",
    state: "xyz",
    code_challenge: "abc123",
    nonce: "nnn",
  };
  const token = await signState(payload);
  const parts = token.split(".");
  assertEquals(parts.length, 2);
  const recovered = await verifyState(token);
  assertEquals(recovered, payload);
});

Deno.test("state: tampered payload fails verification", async () => {
  const payload = {
    client_id: "11111111-1111-1111-1111-111111111111",
    redirect_uri: "https://client.example/cb",
    state: "xyz",
    code_challenge: "abc123",
    nonce: "nnn",
  };
  const token = await signState(payload);
  const [b64, sig] = token.split(".");
  // Flip the first base64 char — signature no longer matches.
  const tampered = (b64[0] === "A" ? "B" : "A") + b64.slice(1) + "." + sig;
  let threw = false;
  try {
    await verifyState(tampered);
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "signature");
  }
  assertEquals(threw, true);
});

Deno.test("state: malformed token (no dot) fails verification", async () => {
  let threw = false;
  try {
    await verifyState("not-a-state-token");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// ---------------------------------------------------------------------------
// HTTP integration tests (require `supabase functions serve mcp-server`).
//
// We skip them when functionUrl points at nothing reachable — local
// `supabase start` must be running. The functions also need MCP_STATE_SECRET
// exported in the serve environment.
// ---------------------------------------------------------------------------

async function mcpReachable(): Promise<boolean> {
  try {
    const res = await fetch(
      functionUrl("mcp-server", "/.well-known/oauth-authorization-server"),
      { method: "GET", signal: AbortSignal.timeout(2000) },
    );
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
const RUN_HTTP = await mcpReachable();

Deno.test({
  name:
    "metadata: GET /.well-known/oauth-authorization-server returns RFC 8414 JSON",
  ignore: !RUN_HTTP,
  fn: async () => {
    const res = await fetch(
      functionUrl("mcp-server", "/.well-known/oauth-authorization-server"),
      { method: "GET" },
    );
    assertEquals(res.status, 200);
    assertStringIncludes(
      res.headers.get("content-type") ?? "",
      "application/json",
    );
    assertStringIncludes(
      res.headers.get("cache-control") ?? "",
      "max-age=300",
    );
    const body = await res.json();
    assertExists(body.issuer);
    assertEquals(body.authorization_endpoint, `${body.issuer}/authorize`);
    assertEquals(body.token_endpoint, `${body.issuer}/token`);
    assertEquals(body.registration_endpoint, `${body.issuer}/register`);
    assertEquals(body.response_types_supported, ["code"]);
    assertEquals(body.code_challenge_methods_supported, ["S256"]);
    assertEquals(
      body.grant_types_supported,
      ["authorization_code", "refresh_token"],
    );
  },
});

Deno.test({
  name: "register: valid body returns 201 + client_id",
  ignore: !RUN_HTTP,
  fn: async () => {
    const res = await fetch(functionUrl("mcp-server", "/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "deno-test",
        redirect_uris: ["https://client.example/cb"],
      }),
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertExists(body.client_id);
    assertEquals(body.client_name, "deno-test");
    assertEquals(body.redirect_uris, ["https://client.example/cb"]);
    assertEquals(body.token_endpoint_auth_method, "none");
    // No secret for public PKCE-only clients.
    assertEquals(body.client_secret, undefined);
  },
});

Deno.test({
  name: "register: issues client_secret for client_secret_post auth method",
  ignore: !RUN_HTTP,
  fn: async () => {
    const res = await fetch(functionUrl("mcp-server", "/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "deno-test-confidential",
        redirect_uris: ["https://client.example/cb"],
        token_endpoint_auth_method: "client_secret_post",
      }),
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertExists(body.client_secret);
    assertEquals(body.client_secret_expires_at, 0);
  },
});

Deno.test({
  name: "register: non-http(s) redirect_uri scheme returns 400",
  ignore: !RUN_HTTP,
  fn: async () => {
    const res = await fetch(functionUrl("mcp-server", "/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "bad",
        redirect_uris: ["javascript:alert(1)"],
      }),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "invalid_redirect_uri");
  },
});

Deno.test({
  name: "register: missing client_name returns 400",
  ignore: !RUN_HTTP,
  fn: async () => {
    const res = await fetch(functionUrl("mcp-server", "/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/cb"],
      }),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "invalid_client_metadata");
  },
});

Deno.test({
  name: "register: empty redirect_uris returns 400",
  ignore: !RUN_HTTP,
  fn: async () => {
    const res = await fetch(functionUrl("mcp-server", "/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "bad",
        redirect_uris: [],
      }),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "invalid_redirect_uri");
  },
});

Deno.test({
  name: "authorize: unknown client_id returns 400",
  ignore: !RUN_HTTP,
  fn: async () => {
    const params = new URLSearchParams({
      client_id: "00000000-0000-0000-0000-000000000000",
      redirect_uri: "https://client.example/cb",
      response_type: "code",
      state: "xyz",
      code_challenge: "abc",
      code_challenge_method: "S256",
    });
    const res = await fetch(
      functionUrl("mcp-server", `/authorize?${params.toString()}`),
      { method: "GET", redirect: "manual" },
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "invalid_request");
    assertStringIncludes(body.error_description, "unknown client_id");
  },
});

Deno.test({
  name: "authorize: redirect_uri not in client's registered list returns 400",
  ignore: !RUN_HTTP,
  fn: async () => {
    // First register a client whose allowed redirect is "https://ok.example/cb".
    const reg = await fetch(functionUrl("mcp-server", "/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "deno-redir-test",
        redirect_uris: ["https://ok.example/cb"],
      }),
    });
    assertEquals(reg.status, 201);
    const { client_id } = await reg.json();
    const params = new URLSearchParams({
      client_id,
      redirect_uri: "https://evil.example/cb", // not registered
      response_type: "code",
      state: "xyz",
      code_challenge: "abc",
      code_challenge_method: "S256",
    });
    const res = await fetch(
      functionUrl("mcp-server", `/authorize?${params.toString()}`),
      { method: "GET", redirect: "manual" },
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "invalid_request");
    assertStringIncludes(body.error_description, "redirect_uri");
  },
});

Deno.test({
  name: "authorize: missing code_challenge returns 400",
  ignore: !RUN_HTTP,
  fn: async () => {
    const params = new URLSearchParams({
      client_id: "00000000-0000-0000-0000-000000000000",
      redirect_uri: "https://client.example/cb",
      response_type: "code",
      state: "xyz",
    });
    const res = await fetch(
      functionUrl("mcp-server", `/authorize?${params.toString()}`),
      { method: "GET", redirect: "manual" },
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "invalid_request");
  },
});

Deno.test({
  name: "token: unsupported grant_type returns 400",
  ignore: !RUN_HTTP,
  fn: async () => {
    const body = new URLSearchParams({ grant_type: "password" });
    const res = await fetch(functionUrl("mcp-server", "/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    assertEquals(res.status, 400);
    const payload = await res.json();
    assertEquals(payload.error, "unsupported_grant_type");
  },
});

Deno.test({
  name: "token: missing grant_type returns 400",
  ignore: !RUN_HTTP,
  fn: async () => {
    const res = await fetch(functionUrl("mcp-server", "/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    assertEquals(res.status, 400);
    const payload = await res.json();
    assertEquals(payload.error, "unsupported_grant_type");
  },
});

Deno.test({
  name: "token: wrong content-type returns 400",
  ignore: !RUN_HTTP,
  fn: async () => {
    const res = await fetch(functionUrl("mcp-server", "/token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code" }),
    });
    assertEquals(res.status, 400);
    const payload = await res.json();
    assertEquals(payload.error, "invalid_request");
  },
});

// -----------------------------------------------------------------------
// authorization_code negative paths. We seed rows directly via the
// service-role client so we don't need a live broker.
// -----------------------------------------------------------------------

async function seedCodeRow(): Promise<{
  code: string;
  clientId: string;
  verifier: string;
  challenge: string;
  cleanup: () => Promise<void>;
}> {
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2"
  );
  const url = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY required for seeded tests");
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Create a user to own the code (FK CASCADE target).
  const email = `mcp-test-${crypto.randomUUID()}@example.com`;
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email,
    password: "mcp-test-pw-" + crypto.randomUUID(),
    email_confirm: true,
  });
  if (userErr || !created.user) throw new Error(userErr?.message);
  const userId = created.user.id;

  // Register a client.
  const reg = await fetch(functionUrl("mcp-server", "/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "seed",
      redirect_uris: ["https://seed.example/cb"],
    }),
  });
  const { client_id: clientId } = await reg.json();

  // Make a valid PKCE pair.
  const verifier = "A".repeat(64); // valid shape, within alphabet
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = base64urlEncode(digest);

  // Seed a code row (mcp-auth would otherwise do this at /callback).
  const code = "seed-" + crypto.randomUUID();
  const { error: insErr } = await db.from("mcp_oauth_codes").insert({
    code,
    client_id: clientId,
    user_id: userId,
    supabase_access_token: "at-fake",
    supabase_refresh_token: "rt-fake",
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: "https://seed.example/cb",
  });
  if (insErr) throw new Error(insErr.message);

  return {
    code,
    clientId,
    verifier,
    challenge,
    cleanup: async () => {
      await db.from("mcp_oauth_codes").delete().eq("code", code);
      await db.from("mcp_oauth_clients").delete().eq("client_id", clientId);
      await db.auth.admin.deleteUser(userId);
    },
  };
}

Deno.test({
  name: "token: replayed authorization_code returns invalid_grant",
  ignore: !RUN_HTTP,
  fn: async () => {
    const seed = await seedCodeRow();
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: seed.code,
        code_verifier: seed.verifier,
        client_id: seed.clientId,
        redirect_uri: "https://seed.example/cb",
      });
      // First exchange succeeds (returns fake tokens from the seeded row).
      const res1 = await fetch(functionUrl("mcp-server", "/token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      assertEquals(res1.status, 200);
      const ok1 = await res1.json();
      assertEquals(ok1.access_token, "at-fake");
      assertEquals(ok1.refresh_token, "rt-fake");
      assertEquals(ok1.token_type, "bearer");

      // Second exchange with the same code must fail.
      const res2 = await fetch(functionUrl("mcp-server", "/token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      assertEquals(res2.status, 400);
      const err2 = await res2.json();
      assertEquals(err2.error, "invalid_grant");
      assertStringIncludes(err2.error_description, "already used");
    } finally {
      await seed.cleanup();
    }
  },
});

Deno.test({
  name: "token: wrong code_verifier returns invalid_grant",
  ignore: !RUN_HTTP,
  fn: async () => {
    const seed = await seedCodeRow();
    try {
      const wrongVerifier = "B".repeat(64); // valid shape, wrong value
      assertNotEquals(wrongVerifier, seed.verifier);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: seed.code,
        code_verifier: wrongVerifier,
        client_id: seed.clientId,
        redirect_uri: "https://seed.example/cb",
      });
      const res = await fetch(functionUrl("mcp-server", "/token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      assertEquals(res.status, 400);
      const err = await res.json();
      assertEquals(err.error, "invalid_grant");
      assertStringIncludes(err.error_description, "code_verifier");
    } finally {
      await seed.cleanup();
    }
  },
});

Deno.test({
  name: "token: malformed code_verifier (too short) returns invalid_grant",
  ignore: !RUN_HTTP,
  fn: async () => {
    const seed = await seedCodeRow();
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: seed.code,
        code_verifier: "short", // <43 chars
        client_id: seed.clientId,
        redirect_uri: "https://seed.example/cb",
      });
      const res = await fetch(functionUrl("mcp-server", "/token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      assertEquals(res.status, 400);
      const err = await res.json();
      assertEquals(err.error, "invalid_grant");
    } finally {
      await seed.cleanup();
    }
  },
});
