/**
 * Remote MCP OAuth /authorize endpoint.
 *
 *   GET /authorize  — validate the dynamic client, sign a state blob,
 *                     302 the browser to mcp-auth/login.
 *
 * mcp-auth handles the entire MuckRock OIDC handshake, mints the MCP
 * authorization code server-side, and 302s the browser directly to the
 * client's redirect_uri — there is no /authorize-callback hop on this
 * EF anymore. See supabase/functions/mcp-auth/index.ts for that flow.
 */

import { logEvent } from "../../_shared/log.ts";
import { getServiceClient } from "../../_shared/supabase.ts";
import { UUID_RE } from "../../_shared/validation.ts";
import { base64urlEncode, signState } from "./state.ts";
import { oauthError } from "./errors.ts";

function randUrlSafe(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64urlEncode(buf);
}

function brokerBaseUrl(): string {
  // MCP-only broker. Lives in its own EF (`mcp-auth`) so that fixes here
  // can never regress the web browser sign-in flow that uses
  // `auth-muckrock`. Override with MCP_BROKER_URL if a self-hosted
  // deployment exposes the broker elsewhere.
  const override = Deno.env.get("MCP_BROKER_URL");
  if (override) return override;
  const supabase = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  return `${supabase}/functions/v1/mcp-auth/login`;
}

/**
 * GET /authorize
 *
 * Params (query): client_id, redirect_uri, response_type=code, state,
 *                 code_challenge, code_challenge_method=S256, scope
 */
export async function authorize(req: Request, requestId?: string): Promise<Response> {
  const url = new URL(req.url);
  const params = url.searchParams;
  logEvent({
    level: "info",
    fn: "mcp-server.authorize",
    event: "authorize_in",
    request_id: requestId,
    client_id: params.get("client_id"),
    redirect_uri: params.get("redirect_uri"),
    response_type: params.get("response_type"),
    has_code_challenge: !!params.get("code_challenge"),
    code_challenge_method: params.get("code_challenge_method"),
    state_len: (params.get("state") ?? "").length,
    scope: params.get("scope"),
  });

  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const responseType = params.get("response_type");
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method") ?? "S256";

  if (!clientId) return oauthError("invalid_request", "client_id required", 400);
  // client_id must be a UUID (mcp_oauth_clients.client_id is uuid-typed in
  // Postgres). Reject non-UUID values up front — otherwise the downstream
  // .eq() throws a type-cast error that surfaces as a 500.
  if (!UUID_RE.test(clientId)) {
    return oauthError("invalid_request", "client_id must be a UUID", 400);
  }
  if (!redirectUri) return oauthError("invalid_request", "redirect_uri required", 400);
  if (responseType !== "code") {
    return oauthError("unsupported_response_type", "response_type must be 'code'", 400);
  }
  if (!codeChallenge) {
    return oauthError("invalid_request", "code_challenge required (PKCE)", 400);
  }
  if (codeChallengeMethod !== "S256") {
    return oauthError("invalid_request", "code_challenge_method must be S256", 400);
  }

  const db = getServiceClient();
  const { data: client, error } = await db
    .from("mcp_oauth_clients")
    .select("client_id, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) {
    logEvent({ level: "error", fn: "mcp-server.authorize", event: "client_lookup_failed", msg: error.message });
    return oauthError("server_error", "client lookup failed", 500);
  }
  if (!client) {
    return oauthError("invalid_request", "unknown client_id", 400);
  }
  const allowed = Array.isArray(client.redirect_uris) ? client.redirect_uris as string[] : [];
  if (!allowed.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri not registered for this client", 400);
  }

  const mcpState = await signState({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    nonce: randUrlSafe(16),
  });

  // mcp-auth/login verifies mcp_state with the same MCP_STATE_SECRET and
  // re-wraps it in its own broker state for the MuckRock round-trip, so
  // the redirect_uri / PKCE challenge are recoverable at /callback when
  // it mints the MCP authorization code.
  const target = new URL(brokerBaseUrl());
  target.searchParams.set("mcp_state", mcpState);

  logEvent({
    level: "info",
    fn: "mcp-server.authorize",
    event: "redirect_to_broker",
    client_id: clientId,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: target.toString() },
  });
}
