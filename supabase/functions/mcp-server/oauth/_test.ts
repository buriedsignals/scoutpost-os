/**
 * mcp-server /authorize handler — input validation tests.
 *
 * The post-OIDC callback / code mint moved to the mcp-auth Edge Function
 * (see supabase/functions/mcp-auth/). What's left on this EF is just
 * the /authorize endpoint that 302s to mcp-auth/login. End-to-end
 * coverage of the full chain is exercised against the deployed
 * functions, not in unit tests.
 */

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { authorize } from "./authorize.ts";

function reqWithEnv(env: Record<string, string>, fn: () => Promise<Response>): Promise<Response> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = Deno.env.get(k) ?? undefined;
    Deno.env.set(k, env[k]);
  }
  return fn().finally(() => {
    for (const k of Object.keys(prev)) {
      const v = prev[k];
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
}

// ---------------------------------------------------------------------------
// /authorize — input validation
// ---------------------------------------------------------------------------

Deno.test("authorize: non-UUID client_id → 400 before DB query", async () => {
  const res = await reqWithEnv(
    { MCP_STATE_SECRET: "s".repeat(32), SUPABASE_URL: "http://127.0.0.1:54321" },
    () =>
      authorize(
        new Request(
          "http://x/authorize?client_id=not-a-uuid&redirect_uri=https://a.b&response_type=code&code_challenge=x&code_challenge_method=S256",
          { method: "GET" },
        ),
      ),
  );
  // Must be 400 with an OAuth 2.0 `invalid_request` code, never a 500
  // — the DB query would type-cast-error on a non-UUID and surface as
  // a misleading "client lookup failed" if we let it through.
  assertEquals(res.status, 400);
  const err = await res.json();
  assertEquals(err.error, "invalid_request");
  assertStringIncludes(err.error_description ?? "", "UUID");
});

Deno.test("authorize: missing client_id → 400", async () => {
  const res = await reqWithEnv(
    { MCP_STATE_SECRET: "s".repeat(32), SUPABASE_URL: "http://127.0.0.1:54321" },
    () =>
      authorize(
        new Request(
          "http://x/authorize?redirect_uri=https://a.b&response_type=code&code_challenge=x&code_challenge_method=S256",
          { method: "GET" },
        ),
      ),
  );
  assertEquals(res.status, 400);
  const err = await res.json();
  assertStringIncludes(err.error_description ?? "", "client_id");
});
