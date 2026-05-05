/**
 * mcp-auth Edge Function — MCP-only OAuth broker.
 *
 * Handles the entire MuckRock OIDC handshake on behalf of the MCP server,
 * mints an MCP authorization code server-side, and 302s the browser
 * directly back to the MCP client (claude.ai, Claude Desktop, Cowork).
 *
 * Why this shape (vs the magiclink-bounce design that landed in PR #152):
 * after deploy, the browser-bounce variant left users on cojournalist.ai
 * without ever calling the claude.ai callback URL. The chain depended on
 * Supabase Auth's `redirectTo` parameter exact-matching an allowlist
 * entry, the magiclink succeeding, the browser following it back to
 * /mcp/authorize-callback, an inline JS parser pulling tokens out of a
 * URL fragment, and a same-origin POST to commit them — every link in
 * that chain was a place state could drift. Public custom-connector
 * targets like Cloudflare's MCP demos do this in one server-side bounce;
 * we now do too.
 *
 * Routes (after Kong strips `/functions/v1/mcp-auth`):
 *
 *   GET /login     — verifies the signed state minted by mcp-server,
 *                    re-wraps it under our own HMAC with the literal
 *                    `mcp.` state-prefix routing tag, and 302s to the
 *                    MuckRock authorize endpoint.
 *
 *   GET /callback  — exchange MuckRock code → access token → userinfo,
 *                    upsert the Supabase auth user, sync entitlements,
 *                    resolve a magiclink server-side to extract a real
 *                    Supabase session JWT (we never bounce the browser
 *                    through it), insert into mcp_oauth_codes, and 302
 *                    directly to the MCP client's redirect_uri with
 *                    `?code=…&state=…`.
 *
 * State scheme (unchanged from PR #152): we tag our HMAC-signed state
 * with the literal prefix `mcp.` so the Render proxy at
 * /api/auth/callback can route MuckRock callbacks to this EF without
 * touching the web sign-in path. MuckRock has one registered redirect
 * URI; the prefix is the only routing signal.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors } from "../_shared/cors.ts";
import { logEvent } from "../_shared/log.ts";
import { MuckrockClient } from "../_shared/muckrock.ts";
import { applyUserEvent } from "../_shared/entitlements.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import {
  type StatePayload as McpServerStatePayload,
  verifyState as verifyMcpServerState,
} from "./mcp_server_state.ts";

const SCOPES = "openid profile uuid organizations email preferences";
const STATE_TTL_SECONDS = 600;
const STATE_PREFIX = "mcp.";

function envOrThrow(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function envOr(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

function serviceSupabaseUrl(): string {
  return Deno.env.get("SERVICE_SUPABASE_URL") ?? envOrThrow("SUPABASE_URL");
}

function serviceRoleKey(): string {
  return Deno.env.get("SERVICE_SUPABASE_SERVICE_ROLE_KEY") ??
    envOrThrow("SUPABASE_SERVICE_ROLE_KEY");
}

function stateSecret(): string {
  return Deno.env.get("MCP_AUTH_STATE_SECRET") ?? envOrThrow("SESSION_SECRET");
}

function stripPrefix(pathname: string): string {
  return pathname.replace(/^.*\/mcp-auth/, "") || "/";
}

function callbackUrl(): string {
  // MUST byte-match the redirect_uri registered with MuckRock's OAuth
  // client. Shared with auth-muckrock; the Render proxy routes the
  // post-OIDC callback to this EF based on the `mcp.` state prefix.
  const override = Deno.env.get("MUCKROCK_CALLBACK_URL");
  if (override) return override;
  const base = envOrThrow("PUBLIC_APP_URL").replace(/\/$/, "");
  return `${base}/api/auth/callback`;
}

function authorizeUrl(state: string): string {
  const muckrockBase = envOr("MUCKROCK_BASE_URL", "https://accounts.muckrock.com").replace(
    /\/$/,
    "",
  );
  const params = new URLSearchParams({
    response_type: "code",
    client_id: envOrThrow("MUCKROCK_CLIENT_ID"),
    redirect_uri: callbackUrl(),
    state,
    scope: SCOPES,
  });
  return `${muckrockBase}/openid/authorize?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Signed state (HMAC-SHA256, stateless). Wraps the mcp-server state we
// received at /login so we can hand it back unchanged at /callback.
// ---------------------------------------------------------------------------

async function hmac(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface BrokerStatePayload {
  nonce: string;
  ts: number;
  /** mcp-server's signed state — opaque to us; we re-verify at callback. */
  mcp_state: string;
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
}

export async function createBrokerState(
  secret: string,
  payload: Omit<BrokerStatePayload, "nonce" | "ts">,
): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const ts = Math.floor(Date.now() / 1000);
  const body = b64urlEncode(JSON.stringify({ nonce, ts, ...payload }));
  const sig = await hmac(secret, body);
  return `${STATE_PREFIX}${body}.${sig}`;
}

export async function verifyBrokerState(
  secret: string,
  state: string,
): Promise<BrokerStatePayload | null> {
  if (!state.startsWith(STATE_PREFIX)) return null;
  const stripped = state.slice(STATE_PREFIX.length);
  const dot = stripped.indexOf(".");
  if (dot < 0) return null;
  const body = stripped.slice(0, dot);
  const sig = stripped.slice(dot + 1);
  const expected = await hmac(secret, body);
  if (!constantTimeEq(sig, expected)) return null;
  let parsed: BrokerStatePayload;
  try {
    parsed = JSON.parse(b64urlDecode(body)) as BrokerStatePayload;
  } catch {
    return null;
  }
  if (
    typeof parsed.nonce !== "string" || typeof parsed.ts !== "number" ||
    typeof parsed.mcp_state !== "string"
  ) {
    return null;
  }
  const age = Math.floor(Date.now() / 1000) - parsed.ts;
  if (age < 0 || age > STATE_TTL_SECONDS) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Random helpers + magiclink token extraction
// ---------------------------------------------------------------------------

function randUrlSafe(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

interface SupabaseSession {
  access_token: string;
  refresh_token: string;
}

/**
 * Resolve a Supabase magiclink server-side.
 *
 * `admin.auth.admin.generateLink` returns a verify URL. Hitting that URL
 * with `redirect: "manual"` produces a 302 whose Location places the
 * session tokens in the URL fragment (`#access_token=…&refresh_token=…`).
 * The browser would normally follow that redirect to expose the tokens
 * via JS — we do it server-side instead so the user never sees the
 * intermediate Supabase host and we never need an HTML bounce page.
 *
 * `redirectTo` here is cosmetic — the tokens come out the same regardless
 * of where the redirect points. We use PUBLIC_APP_URL because it's
 * always on Supabase's redirect allowlist (it's SITE_URL).
 */
async function exchangeMagiclinkForSession(
  admin: SupabaseClient,
  email: string,
  requestId: string,
): Promise<SupabaseSession | null> {
  const redirectTo = envOrThrow("PUBLIC_APP_URL");
  const { data, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (linkErr || !data?.properties?.action_link) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "magiclink_failed",
      request_id: requestId,
      msg: linkErr?.message ?? "no action_link",
    });
    return null;
  }

  let actionRes: Response;
  try {
    actionRes = await fetch(data.properties.action_link, { redirect: "manual" });
  } catch (e) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "magiclink_fetch_failed",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  if (actionRes.status < 300 || actionRes.status >= 400) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "magiclink_unexpected_status",
      request_id: requestId,
      status: actionRes.status,
    });
    return null;
  }
  const location = actionRes.headers.get("location");
  if (!location) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "magiclink_no_location",
      request_id: requestId,
    });
    return null;
  }

  // Parse `#access_token=…&refresh_token=…&…` from the Location URL.
  const hashIdx = location.indexOf("#");
  if (hashIdx < 0) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "magiclink_no_fragment",
      request_id: requestId,
      // Useful even with no tokens — exposes Supabase error redirects.
      location_host: (() => {
        try { return new URL(location).host; } catch { return null; }
      })(),
    });
    return null;
  }
  const fragment = new URLSearchParams(location.slice(hashIdx + 1));
  const accessToken = fragment.get("access_token");
  const refreshToken = fragment.get("refresh_token");
  if (!accessToken || !refreshToken) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "magiclink_missing_tokens",
      request_id: requestId,
      has_access: !!accessToken,
      has_refresh: !!refreshToken,
    });
    return null;
  }
  return { access_token: accessToken, refresh_token: refreshToken };
}

// ---------------------------------------------------------------------------
// Email allowlist (mirrored from auth-muckrock so MCP and web share gating)
// ---------------------------------------------------------------------------

function isEmailAllowed(email: string | undefined): boolean {
  const raw = (Deno.env.get("EMAIL_ALLOWLIST") ?? "").trim();
  if (!raw) return true;
  const entries = raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const emails = new Set(entries.filter((e) => !e.startsWith("@")));
  const domains = new Set(entries.filter((e) => e.startsWith("@")));
  const lower = (email ?? "").toLowerCase();
  if (!lower) return false;
  if (emails.has(lower)) return true;
  const domain = lower.includes("@") ? `@${lower.split("@").pop()}` : "";
  return domains.has(domain);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function jsonError(message: string, status: number, requestId?: string): Response {
  logEvent({
    level: "warn",
    fn: "mcp-auth",
    event: "error_response",
    request_id: requestId,
    msg: message,
    status,
  });
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bounceClientError(
  mcpPayload: McpServerStatePayload,
  errorCode: string,
  description: string,
  requestId: string,
): Response {
  const target = new URL(mcpPayload.redirect_uri);
  target.searchParams.set("error", errorCode);
  target.searchParams.set("error_description", description);
  if (mcpPayload.state) target.searchParams.set("state", mcpPayload.state);
  logEvent({
    level: "warn",
    fn: "mcp-auth",
    event: "bounce_client_error",
    request_id: requestId,
    error: errorCode,
    redirect_host: target.host,
  });
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString() },
  });
}

async function handleLogin(req: Request, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const mcpState = url.searchParams.get("mcp_state") ?? "";

  logEvent({
    level: "info",
    fn: "mcp-auth.login",
    event: "login_in",
    request_id: requestId,
    has_mcp_state: mcpState.length > 0,
  });

  if (!mcpState) return jsonError("mcp_state required", 400, requestId);

  // Verify mcp-server's signed state up front so we can reject obviously
  // bogus traffic before round-tripping to MuckRock. We don't act on its
  // contents at /login — we re-verify at /callback to recover the
  // redirect_uri we 302 the browser to.
  try {
    await verifyMcpServerState(mcpState);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "mcp-auth.login",
      event: "mcp_state_invalid",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonError("invalid mcp_state", 400, requestId);
  }

  const brokerState = await createBrokerState(stateSecret(), { mcp_state: mcpState });

  logEvent({
    level: "info",
    fn: "mcp-auth.login",
    event: "redirect_to_muckrock",
    request_id: requestId,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl(brokerState) },
  });
}

async function handleCallback(req: Request, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  logEvent({
    level: "info",
    fn: "mcp-auth.callback",
    event: "callback_in",
    request_id: requestId,
    has_code: !!code,
    has_state: !!state,
    has_error: !!oauthError,
  });

  if (!state) return jsonError("missing state", 400, requestId);
  const broker = await verifyBrokerState(stateSecret(), state);
  if (!broker) {
    logEvent({
      level: "warn",
      fn: "mcp-auth.callback",
      event: "broker_state_invalid",
      request_id: requestId,
    });
    return jsonError("invalid state", 400, requestId);
  }

  let mcpPayload: McpServerStatePayload;
  try {
    mcpPayload = await verifyMcpServerState(broker.mcp_state);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "mcp-auth.callback",
      event: "mcp_state_invalid",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonError("invalid embedded mcp_state", 400, requestId);
  }

  if (oauthError) {
    return bounceClientError(mcpPayload, "access_denied", oauthError, requestId);
  }
  if (!code) {
    return bounceClientError(mcpPayload, "invalid_request", "missing code", requestId);
  }

  // 1. Exchange MuckRock code → access_token
  const muckrockBase = envOr("MUCKROCK_BASE_URL", "https://accounts.muckrock.com").replace(
    /\/$/,
    "",
  );
  let muckrockAccessToken: string;
  try {
    const tokenRes = await fetch(`${muckrockBase}/openid/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(),
        client_id: envOrThrow("MUCKROCK_CLIENT_ID"),
        client_secret: envOrThrow("MUCKROCK_CLIENT_SECRET"),
      }),
    });
    if (!tokenRes.ok) {
      logEvent({
        level: "error",
        fn: "mcp-auth.callback",
        event: "muckrock_token_failed",
        request_id: requestId,
        status: tokenRes.status,
      });
      return bounceClientError(mcpPayload, "server_error", "muckrock token exchange failed", requestId);
    }
    muckrockAccessToken = (await tokenRes.json() as { access_token: string }).access_token;
  } catch (e) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "muckrock_token_exception",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return bounceClientError(mcpPayload, "server_error", "muckrock token exchange exception", requestId);
  }

  // 2. Fetch userinfo
  let userinfo: {
    uuid: string;
    email?: string;
    preferred_username?: string;
    organizations?: Array<Record<string, unknown>>;
  };
  try {
    const uRes = await fetch(`${muckrockBase}/openid/userinfo`, {
      headers: { Authorization: `Bearer ${muckrockAccessToken}` },
    });
    if (!uRes.ok) {
      logEvent({
        level: "error",
        fn: "mcp-auth.callback",
        event: "userinfo_failed",
        request_id: requestId,
        status: uRes.status,
      });
      return bounceClientError(mcpPayload, "server_error", "muckrock userinfo failed", requestId);
    }
    userinfo = await uRes.json();
  } catch (e) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "userinfo_exception",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return bounceClientError(mcpPayload, "server_error", "muckrock userinfo exception", requestId);
  }

  if (!isEmailAllowed(userinfo.email)) {
    logEvent({
      level: "info",
      fn: "mcp-auth.callback",
      event: "email_denied",
      request_id: requestId,
      email_domain: userinfo.email?.split("@").pop() ?? null,
    });
    return bounceClientError(mcpPayload, "access_denied", "email not allowed", requestId);
  }

  const admin = createClient(serviceSupabaseUrl(), serviceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 3. Upsert Supabase auth user with the MuckRock UUID as id
  try {
    const { error: createErr } = await admin.auth.admin.createUser({
      id: userinfo.uuid,
      email: userinfo.email,
      email_confirm: true,
      user_metadata: {
        muckrock_subject: userinfo.uuid,
        muckrock_username: userinfo.preferred_username,
      },
    });
    if (createErr) {
      const msg = createErr.message?.toLowerCase() ?? "";
      if (!["already", "exists", "duplicate", "registered"].some((s) => msg.includes(s))) {
        logEvent({
          level: "error",
          fn: "mcp-auth.callback",
          event: "supabase_create_failed",
          request_id: requestId,
          msg: createErr.message,
        });
        return bounceClientError(mcpPayload, "server_error", "user upsert failed", requestId);
      }
    }
  } catch (e) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "supabase_create_exception",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return bounceClientError(mcpPayload, "server_error", "user upsert exception", requestId);
  }

  // 4. Best-effort entitlements sync. Failure here doesn't block sign-in.
  try {
    const muckrockClient = new MuckrockClient();
    const fullUser = await muckrockClient.fetchUserData(userinfo.uuid);
    await applyUserEvent(getServiceClient(), fullUser);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "mcp-auth.callback",
      event: "team_sync_skipped",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  // 5. Resolve a magiclink server-side to get a real Supabase session
  //    JWT without bouncing the browser through Supabase.
  const session = await exchangeMagiclinkForSession(admin, userinfo.email ?? "", requestId);
  if (!session) {
    return bounceClientError(mcpPayload, "server_error", "session establishment failed", requestId);
  }

  // 6. Mint MCP authorization code, bound to the PKCE challenge from
  //    mcp-server's signed state.
  const mcpCode = randUrlSafe(32);
  const { error: insertErr } = await admin.from("mcp_oauth_codes").insert({
    code: mcpCode,
    client_id: mcpPayload.client_id,
    user_id: userinfo.uuid,
    supabase_access_token: session.access_token,
    supabase_refresh_token: session.refresh_token,
    code_challenge: mcpPayload.code_challenge,
    code_challenge_method: "S256",
    redirect_uri: mcpPayload.redirect_uri,
    scopes: [],
  });
  if (insertErr) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "code_insert_failed",
      request_id: requestId,
      msg: insertErr.message,
    });
    return bounceClientError(mcpPayload, "server_error", "code mint failed", requestId);
  }

  // 7. 302 directly to the MCP client's redirect_uri.
  const target = new URL(mcpPayload.redirect_uri);
  target.searchParams.set("code", mcpCode);
  if (mcpPayload.state) target.searchParams.set("state", mcpPayload.state);

  logEvent({
    level: "info",
    fn: "mcp-auth.callback",
    event: "code_issued",
    request_id: requestId,
    client_id: mcpPayload.client_id,
    user_id: userinfo.uuid,
    redirect_host: target.host,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: target.toString() },
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function handleRequest(req: Request): Promise<Response> {
  const cors = handleCors(req);
  if (cors) return cors;

  const path = stripPrefix(new URL(req.url).pathname);
  const requestId = crypto.randomUUID();

  logEvent({
    level: "info",
    fn: "mcp-auth",
    event: "request_in",
    request_id: requestId,
    method: req.method,
    path,
  });

  try {
    if (path === "/login" && req.method === "GET") {
      return await handleLogin(req, requestId);
    }
    if (path === "/callback" && req.method === "GET") {
      return await handleCallback(req, requestId);
    }
    return jsonError("not found", 404, requestId);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "mcp-auth",
      event: "unhandled",
      request_id: requestId,
      path,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonError("internal error", 500, requestId);
  }
}

Deno.serve(handleRequest);
