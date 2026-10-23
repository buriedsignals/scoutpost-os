/**
 * Which OAuth client a bearer token was issued to.
 *
 * /token returns the caller's Supabase access token as the MCP token, so the
 * token itself names no client. At code exchange we record its `session_id`
 * claim against the client (`mcp_oauth_sessions`); Supabase keeps that id
 * across refreshes. tools/list reads it back to tell Osaurus apart.
 */

import { logEvent } from "../../_shared/log.ts";

/** The client_name Osaurus registers with (Osaurus MCPOAuthClientMetadata). */
export const OSAURUS_CLIENT_NAME = "Osaurus";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the `session_id` claim from a Supabase JWT without verifying it.
 * Callers use it only after the token was verified (requireUserOrApiKey) or
 * on a token Supabase just issued.
 */
export function jwtSessionId(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as Record<string, unknown>;
    const sid = claims.session_id;
    return typeof sid === "string" && UUID.test(sid) ? sid : null;
  } catch {
    return null;
  }
}

// The narrow slice of the Supabase client these helpers use, so tests can
// pass a stand-in.
// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

/**
 * Records which client a freshly issued session belongs to. Returns false
 * when it could not be saved, so the caller can refuse the exchange before
 * the code is spent. A token with no session_id claim has nothing to record.
 */
export async function recordSessionClient(
  db: Db,
  accessToken: string,
  clientId: string,
  userId: string,
): Promise<boolean> {
  const sessionId = jwtSessionId(accessToken);
  if (!sessionId) {
    logEvent({ level: "warn", fn: "mcp-server.token", event: "session_id_missing", client_id: clientId });
    return true;
  }
  const { error } = await db.from("mcp_oauth_sessions").upsert({
    session_id: sessionId,
    client_id: clientId,
    user_id: userId,
  });
  if (error) {
    logEvent({ level: "warn", fn: "mcp-server.token", event: "session_record_failed", msg: error.message });
    return false;
  }
  return true;
}

/** The outcome of looking up which client a token's session belongs to. */
export type ClientLookup =
  | { ok: true; name: string | null } // null: no record (another sign-in path, or before records began)
  | { ok: false }; // the lookup itself failed

/** The client_name of the OAuth client the token's session was issued to. */
export async function clientNameForToken(db: Db, token: string): Promise<ClientLookup> {
  const sessionId = jwtSessionId(token);
  if (!sessionId) return { ok: true, name: null };
  const { data, error } = await db
    .from("mcp_oauth_sessions")
    .select("mcp_oauth_clients(client_name)")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) {
    logEvent({ level: "warn", fn: "mcp-server.rpc", event: "client_lookup_failed", msg: error.message });
    return { ok: false };
  }
  const name = data?.mcp_oauth_clients?.client_name;
  return { ok: true, name: typeof name === "string" ? name : null };
}

/**
 * Whether tools/list marks every tool open-world for this caller: yes for a
 * session signed in through Osaurus, and when the lookup fails (asking is
 * the safe side). API-key callers have no OAuth client.
 */
export async function listsAsOpenWorld(db: Db, token: string, authMethod?: string): Promise<boolean> {
  if (authMethod === "api_key" || token.startsWith("cj_")) return false;
  const lookup = await clientNameForToken(db, token);
  return !lookup.ok || lookup.name === OSAURUS_CLIENT_NAME;
}
