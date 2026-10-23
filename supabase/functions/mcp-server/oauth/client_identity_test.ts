import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clientNameForToken,
  jwtSessionId,
  listsAsOpenWorld,
  OSAURUS_CLIENT_NAME,
  recordSessionClient,
} from "./client_identity.ts";

const SESSION = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const CLIENT = "11111111-2222-4333-8444-555555555555";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.signature`;
}

// A two-table stand-in for the service client: sessions keyed by session_id,
// each joined to its client's name, as the embedded select returns it.
function fakeDb(clients: Record<string, string>, opts: { fail?: boolean } = {}) {
  const sessions = new Map<string, { client_id: string; user_id: string }>();
  return {
    sessions,
    from(table: string) {
      if (table !== "mcp_oauth_sessions") throw new Error(`unexpected table ${table}`);
      return {
        upsert(row: { session_id: string; client_id: string; user_id: string }) {
          if (opts.fail) return Promise.resolve({ error: { message: "down" } });
          sessions.set(row.session_id, { client_id: row.client_id, user_id: row.user_id });
          return Promise.resolve({ error: null });
        },
        select(_cols: string) {
          return {
            eq(_col: string, sid: string) {
              return {
                maybeSingle() {
                  if (opts.fail) return Promise.resolve({ data: null, error: { message: "down" } });
                  const s = sessions.get(sid);
                  return Promise.resolve({
                    data: s ? { mcp_oauth_clients: { client_name: clients[s.client_id] } } : null,
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
    },
  };
}

Deno.test("client identity: reads only a UUID session_id claim", () => {
  assertEquals(jwtSessionId(jwt({ session_id: SESSION })), SESSION);
  assertEquals(jwtSessionId(jwt({ session_id: "not-a-uuid" })), null);
  assertEquals(jwtSessionId(jwt({ sub: "user" })), null);
  assertEquals(jwtSessionId("cj_apikey"), null);
});

// The session recorded at code exchange names the client on every later
// call, including after a refresh (Supabase keeps the session id).
Deno.test("client identity: a recorded session names its OAuth client", async () => {
  const db = fakeDb({ [CLIENT]: OSAURUS_CLIENT_NAME });
  await recordSessionClient(db, jwt({ session_id: SESSION }), CLIENT, "user-1");
  const refreshed = jwt({ session_id: SESSION, iat: 2 });
  assertEquals(await clientNameForToken(db, refreshed), { ok: true, name: OSAURUS_CLIENT_NAME });
  assertEquals(await clientNameForToken(db, jwt({ session_id: "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" })), { ok: true, name: null });
});

Deno.test("client identity: a failed lookup is reported as a failure, not as no client", async () => {
  assertEquals(await clientNameForToken(fakeDb({}, { fail: true }), jwt({ session_id: SESSION })), { ok: false });
});

// The tools/list decision: Osaurus asks, other OAuth clients and API keys
// keep today's hints, and a failed lookup asks. A client that merely names
// itself "error" is just another client.
Deno.test("client identity: only Osaurus sessions, or a failed lookup, list every tool as open-world", async () => {
  const OTHER = "99999999-2222-4333-8444-555555555555";
  const db = fakeDb({ [CLIENT]: OSAURUS_CLIENT_NAME, [OTHER]: "error" });
  await recordSessionClient(db, jwt({ session_id: SESSION }), CLIENT, "user-1");
  const otherSession = "8f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  await recordSessionClient(db, jwt({ session_id: otherSession }), OTHER, "user-2");
  assertEquals(await listsAsOpenWorld(db, jwt({ session_id: SESSION }), "session"), true);
  assertEquals(await listsAsOpenWorld(db, jwt({ session_id: otherSession }), "session"), false);
  assertEquals(await listsAsOpenWorld(db, jwt({ sub: "user-3" }), "session"), false);
  assertEquals(await listsAsOpenWorld(db, "cj_key", "api_key"), false);
  assertEquals(await listsAsOpenWorld(fakeDb({}, { fail: true }), jwt({ session_id: SESSION }), "session"), true);
});

// /token refuses the exchange, before the code is spent, when the link
// cannot be saved; a token with no session id has nothing to save.
Deno.test("client identity: recording reports whether the link was saved", async () => {
  assertEquals(await recordSessionClient(fakeDb({}), jwt({ session_id: SESSION }), CLIENT, "user-1"), true);
  assertEquals(await recordSessionClient(fakeDb({}, { fail: true }), jwt({ session_id: SESSION }), CLIENT, "user-1"), false);
  assertEquals(await recordSessionClient(fakeDb({}, { fail: true }), jwt({ sub: "user-1" }), CLIENT, "user-1"), true);
});
