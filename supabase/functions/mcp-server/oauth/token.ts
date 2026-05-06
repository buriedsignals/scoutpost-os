/**
 * POST /token — OAuth 2.1 token endpoint.
 *
 * Two grant types supported:
 *
 *   authorization_code:
 *     - Parse form body → {grant_type, code, code_verifier, client_id,
 *                         redirect_uri, client_secret?}
 *     - Load code row. It must exist, not be used, not be expired, and its
 *       `client_id` + `redirect_uri` must match the request.
 *     - If the client has a secret, verify it (constant-time SHA-256 hash
 *       compare).
 *     - Run PKCE S256 verifier check against stored `code_challenge`.
 *     - Atomic `UPDATE ... SET used_at=now() WHERE code=$1 AND used_at IS
 *       NULL` — rowcount must be 1, else another request won the race.
 *     - Return `{access_token, refresh_token, token_type, expires_in}` using
 *       the Supabase tokens stored by `mcp-auth` at callback time. The MCP
 *       client uses the access_token directly as a Supabase JWT for
 *       subsequent `tools/call` requests.
 *
 *   refresh_token:
 *     - Pass-through to Supabase Auth's `/auth/v1/token?grant_type=refresh_token`.
 *       We do NOT track refresh tokens ourselves — letting Supabase do it
 *       means that rotating a user's Supabase auth invalidates their MCP
 *       session for free.
 */

import { getServiceClient } from "../../_shared/supabase.ts";
import { logEvent } from "../../_shared/log.ts";
import { verifyS256, validateVerifier } from "./pkce.ts";
import { oauthError, oauthJson } from "./errors.ts";

interface OAuthCodeRow {
  code: string;
  client_id: string;
  user_id: string;
  supabase_access_token: string;
  supabase_refresh_token: string;
  code_challenge: string;
  redirect_uri: string;
  expires_at: string;
  used_at: string | null;
}

function parseBasicAuth(header: string | null): { id: string; secret: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header.trim());
  if (!m) return null;
  try {
    const decoded = atob(m[1]);
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function tokenHandler(req: Request, requestId?: string): Promise<Response> {
  if (req.method !== "POST") {
    return oauthError("invalid_request", "POST required", 405);
  }
  const contentType = req.headers.get("content-type") ?? "";
  logEvent({
    level: "info",
    fn: "mcp-server.token",
    event: "token_in",
    request_id: requestId,
    content_type: contentType,
    has_basic_auth: (req.headers.get("authorization") ?? "").startsWith("Basic "),
  });
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return oauthError(
      "invalid_request",
      "content-type must be application/x-www-form-urlencoded",
      400,
    );
  }

  let form: URLSearchParams;
  try {
    const text = await req.text();
    form = new URLSearchParams(text);
  } catch {
    return oauthError("invalid_request", "unable to parse form body", 400);
  }

  const grantType = form.get("grant_type") ?? "";

  logEvent({
    level: "info",
    fn: "mcp-server.token",
    event: "token_grant",
    request_id: requestId,
    grant_type: grantType,
    has_code: !!form.get("code"),
    has_code_verifier: !!form.get("code_verifier"),
    has_client_id: !!form.get("client_id"),
    has_client_secret: !!form.get("client_secret"),
    redirect_uri: form.get("redirect_uri"),
  });
  if (grantType === "authorization_code") {
    return await handleAuthorizationCode(req, form, requestId);
  }
  if (grantType === "refresh_token") {
    return await handleRefreshToken(form, requestId);
  }
  return oauthError(
    "unsupported_grant_type",
    `grant_type must be authorization_code or refresh_token (got '${grantType}')`,
    400,
  );
}

async function handleAuthorizationCode(req: Request, form: URLSearchParams, requestId?: string): Promise<Response> {
  const code = form.get("code") ?? "";
  const codeVerifier = form.get("code_verifier") ?? "";
  const formClientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const formClientSecret = form.get("client_secret");
  const basic = parseBasicAuth(req.headers.get("authorization") ?? req.headers.get("Authorization"));
  const clientId = basic?.id ?? formClientId;
  const clientSecret = basic?.secret ?? formClientSecret ?? null;

  if (!code) return oauthError("invalid_request", "code is required", 400);
  if (!clientId) return oauthError("invalid_client", "client_id is required", 400);
  if (!redirectUri) return oauthError("invalid_request", "redirect_uri is required", 400);
  if (!codeVerifier) return oauthError("invalid_request", "code_verifier is required (PKCE)", 400);

  // Validate verifier shape before any DB work — cheap rejection.
  try {
    validateVerifier(codeVerifier);
  } catch (e) {
    return oauthError(
      "invalid_grant",
      e instanceof Error ? e.message : "invalid code_verifier",
      400,
    );
  }

  const db = getServiceClient();

  // Load code.
  const { data: rowRaw, error } = await db
    .from("mcp_oauth_codes")
    .select(
      "code, client_id, user_id, supabase_access_token, supabase_refresh_token, " +
      "code_challenge, redirect_uri, expires_at, used_at",
    )
    .eq("code", code)
    .maybeSingle();
  if (error) {
    logEvent({ level: "error", fn: "mcp-server.token", event: "code_lookup_failed", msg: error.message });
    return oauthError("server_error", "code lookup failed", 500);
  }
  const row = rowRaw as OAuthCodeRow | null;
  if (!row) return oauthError("invalid_grant", "unknown authorization code", 400);

  // Expired or already used? Treat both as invalid_grant (don't leak which).
  if (row.used_at) return oauthError("invalid_grant", "authorization code already used", 400);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return oauthError("invalid_grant", "authorization code expired", 400);
  }

  if (row.client_id !== clientId) {
    return oauthError("invalid_grant", "client_id does not match code", 400);
  }
  if (row.redirect_uri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri does not match code", 400);
  }

  // Load client to verify secret if present.
  const { data: client, error: clientErr } = await db
    .from("mcp_oauth_clients")
    .select("client_id, client_secret_hash, token_endpoint_auth_method")
    .eq("client_id", clientId)
    .maybeSingle();
  if (clientErr) {
    return oauthError("server_error", "client lookup failed", 500);
  }
  if (!client) return oauthError("invalid_client", "unknown client", 401);

  if (client.token_endpoint_auth_method !== "none") {
    if (!clientSecret) {
      return oauthError("invalid_client", "client_secret required", 401);
    }
    const provided = await sha256Hex(clientSecret);
    if (
      !client.client_secret_hash ||
      !timingSafeEqualString(provided, client.client_secret_hash)
    ) {
      return oauthError("invalid_client", "client authentication failed", 401);
    }
  }

  // PKCE verifier check.
  const pkceOk = await verifyS256(codeVerifier, row.code_challenge);
  if (!pkceOk) {
    return oauthError("invalid_grant", "code_verifier does not match code_challenge", 400);
  }

  // Atomic single-use enforcement. Must update exactly one row where
  // used_at IS NULL. Anything else (0 rows or >1) = race / replay.
  const { data: updated, error: updateErr } = await db
    .from("mcp_oauth_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code", code)
    .is("used_at", null)
    .select("code");
  if (updateErr) {
    logEvent({ level: "error", fn: "mcp-server.token", event: "mark_used_failed", msg: updateErr.message });
    return oauthError("server_error", "failed to consume code", 500);
  }
  if (!updated || updated.length !== 1) {
    return oauthError("invalid_grant", "authorization code already used", 400);
  }

  // Bump client.last_used_at (best-effort — don't fail the exchange on error).
  await db
    .from("mcp_oauth_clients")
    .update({ last_used_at: new Date().toISOString() })
    .eq("client_id", clientId);

  logEvent({
    level: "info",
    fn: "mcp-server.token",
    event: "code_exchanged",
    request_id: requestId,
    client_id: clientId,
    user_id: row.user_id,
  });

  return oauthJson({
    access_token: row.supabase_access_token,
    refresh_token: row.supabase_refresh_token,
    token_type: "bearer",
    expires_in: 3600,
    scope: "mcp",
  });
}

async function handleRefreshToken(form: URLSearchParams, requestId?: string): Promise<Response> {
  const refreshToken = form.get("refresh_token") ?? "";
  if (!refreshToken) {
    return oauthError("invalid_request", "refresh_token is required", 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return oauthError("server_error", "server misconfigured", 500);
  }

  const res = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": anonKey,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  const text = await res.text();
  // Supabase returns either a valid token response or an error payload.
  // Pass through status + body unchanged; translate Supabase's error shape
  // into OAuth when it returns 4xx.
  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch { /* ignore */ }
    const desc = (payload && typeof payload === "object" && "error_description" in payload
      ? String((payload as Record<string, unknown>).error_description)
      : text) || "refresh failed";
    logEvent({
      level: "warn",
      fn: "mcp-server.token",
      event: "refresh_failed",
      request_id: requestId,
      upstream_status: res.status,
      desc,
    });
    return oauthError("invalid_grant", desc, res.status === 401 ? 401 : 400);
  }
  logEvent({
    level: "info",
    fn: "mcp-server.token",
    event: "refresh_ok",
    request_id: requestId,
  });

  // Success — hand Supabase's response straight back. It already has the
  // required fields (access_token, refresh_token, token_type, expires_in).
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
