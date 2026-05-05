/**
 * mcp-auth Edge Function — MCP-only MuckRock OAuth broker + Supabase
 * magiclink handoff. Cleanly split from `auth-muckrock` so changes here
 * cannot regress the web browser sign-in flow.
 *
 * Why split? The web browser sign-in path lives entirely inside
 * `auth-muckrock`. The MCP OAuth chain previously rode the same EF, which
 * meant any MCP-side fix (additional log lines, redirect helpers, etc.)
 * also touched the production web sign-in. The user-facing requirement is
 * that "anything touching muckrock auth does not touch the web browser
 * sign in" — so the MCP path now lives in a dedicated function with its
 * own state schema, log namespace, and tests.
 *
 * Routes (after Kong strips `/functions/v1/mcp-auth`):
 *   GET /login     — 302 to MuckRock authorize endpoint. Required query
 *                    params `mcp_callback` (the mcp-server EF callback)
 *                    + `mcp_state` (signed blob from mcp-server/authorize)
 *                    are threaded through MuckRock and the Supabase
 *                    magiclink so the post-OAuth bounce lands on the
 *                    mcp-server callback with mcp_state preserved.
 *   GET /callback  — exchange code, upsert Supabase user, sync entitlements,
 *                    302 to a Supabase magiclink whose redirect_to is the
 *                    mcp_callback URL. The browser then lands on
 *                    mcp-server/authorize-callback with tokens in the URL
 *                    fragment.
 *
 * State scheme: this function uses HMAC-signed state with a tagged prefix
 * `mcp.<base64>.<hex>`. The Render proxy at /api/auth/callback peeks at
 * the prefix and routes to this EF (mcp.* → mcp-auth/callback) vs the
 * web broker (no prefix → auth-muckrock/callback). MuckRock sees only
 * one registered redirect_uri (`/api/auth/callback`); the prefix is the
 * sole router signal — no MuckRock-side changes needed.
 *
 * Required env vars (Supabase secrets):
 *   MUCKROCK_CLIENT_ID, MUCKROCK_CLIENT_SECRET
 *   MUCKROCK_BASE_URL (optional, default https://accounts.muckrock.com)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 *   SERVICE_SUPABASE_URL, SERVICE_SUPABASE_SERVICE_ROLE_KEY (optional
 *     local-dev overrides)
 *   MCP_AUTH_STATE_SECRET — HMAC key for stateless OAuth state tokens.
 *     Defaults to SESSION_SECRET to avoid a separate rotation step on
 *     first deploy; rotate independently once mcp-auth is steady-state.
 *   MCP_SERVER_BASE_URL — public host of the MCP server (e.g.
 *     https://www.cojournalist.ai/mcp). Required so we can validate
 *     mcp_callback URLs against an allowlist of trusted hosts.
 *   PUBLIC_APP_URL — used only for error redirects.
 *   MUCKROCK_CALLBACK_URL (optional) — override the redirect_uri sent
 *     to MuckRock if it's pointed at a non-proxied URL. Defaults to
 *     `${PUBLIC_APP_URL}/api/auth/callback` (apex — see the byte-match
 *     note in auth-muckrock/index.ts).
 *   EMAIL_ALLOWLIST (optional) — comma-separated emails / @domain patterns.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors } from "../_shared/cors.ts";
import { logEvent } from "../_shared/log.ts";
import { MuckrockClient } from "../_shared/muckrock.ts";
import { applyUserEvent } from "../_shared/entitlements.ts";
import { getServiceClient } from "../_shared/supabase.ts";

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
  // Prefer MCP_AUTH_STATE_SECRET so we can rotate independently of
  // SESSION_SECRET (which is hot for the web broker). Fall back to
  // SESSION_SECRET on first deploy so operators don't have to set two
  // secrets in lockstep.
  return Deno.env.get("MCP_AUTH_STATE_SECRET") ?? envOrThrow("SESSION_SECRET");
}

function stripPrefix(pathname: string): string {
  return pathname.replace(/^.*\/mcp-auth/, "") || "/";
}

function callbackUrl(): string {
  // MUST byte-match the redirect_uri registered with MuckRock's OAuth
  // client. We share the registered URL with auth-muckrock; the Render
  // proxy at /api/auth/callback is the routing point that hands MCP
  // flows to mcp-auth/callback (via the `mcp.` state prefix).
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
// Signed state token (HMAC-SHA256, stateless — no storage). Mirrors the
// auth-muckrock helper but lives here so we don't import across functions.
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

interface StatePayload {
  nonce: string;
  ts: number;
  /** mcp-server EF callback URL where the magiclink should land. */
  mcp_callback: string;
  /** Signed state blob from mcp-server/authorize — passed through. */
  mcp_state: string;
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
}

export async function createMcpState(
  secret: string,
  payload: Omit<StatePayload, "nonce" | "ts">,
): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const ts = Math.floor(Date.now() / 1000);
  const body = b64urlEncode(JSON.stringify({ nonce, ts, ...payload }));
  const sig = await hmac(secret, body);
  // Prefix marks this state as belonging to the MCP flow so the Render
  // proxy can route the MuckRock callback to the right EF.
  return `${STATE_PREFIX}${body}.${sig}`;
}

export async function verifyMcpState(
  secret: string,
  state: string,
): Promise<StatePayload | null> {
  if (!state.startsWith(STATE_PREFIX)) return null;
  const stripped = state.slice(STATE_PREFIX.length);
  const dot = stripped.indexOf(".");
  if (dot < 0) return null;
  const body = stripped.slice(0, dot);
  const sig = stripped.slice(dot + 1);
  const expected = await hmac(secret, body);
  if (!constantTimeEq(sig, expected)) return null;
  let parsed: StatePayload;
  try {
    parsed = JSON.parse(b64urlDecode(body)) as StatePayload;
  } catch {
    return null;
  }
  if (
    typeof parsed.nonce !== "string" || typeof parsed.ts !== "number" ||
    typeof parsed.mcp_callback !== "string" || typeof parsed.mcp_state !== "string"
  ) {
    return null;
  }
  const age = Math.floor(Date.now() / 1000) - parsed.ts;
  if (age < 0 || age > STATE_TTL_SECONDS) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// mcp_callback host validation — reject anything not pointing at our own
// MCP server, defence-in-depth against open-redirector abuse.
// ---------------------------------------------------------------------------

export function isValidMcpCallback(raw: string): boolean {
  let cb: URL;
  try {
    cb = new URL(raw);
  } catch {
    return false;
  }
  if (cb.protocol !== "https:" && cb.protocol !== "http:") return false;

  const supabaseHost = (() => {
    try {
      return new URL(envOrThrow("SUPABASE_URL")).host;
    } catch {
      return "";
    }
  })();
  const publicMcpBase = Deno.env.get("MCP_SERVER_BASE_URL");
  const publicHost = publicMcpBase ? new URL(publicMcpBase).host : "";

  const hostOk = (supabaseHost && cb.host === supabaseHost) ||
    (publicHost && cb.host === publicHost);
  // Path must live under the mcp-server function (raw Supabase) or the
  // /mcp prefix (public host). Block arbitrary same-host paths.
  const pathOk = cb.pathname.startsWith("/functions/v1/mcp-server/") ||
    cb.pathname.startsWith("/mcp/");

  return Boolean(hostOk && pathOk);
}

// ---------------------------------------------------------------------------
// Email allowlist — duplicated from auth-muckrock to keep this function
// self-contained. The two flows share the same allowlist env var so MCP
// users see consistent gating with web sign-in.
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

function bounceToMcpError(
  payload: StatePayload | null,
  errorCode: string,
  description: string,
  requestId: string,
): Response {
  // When we have the original mcp_state, bounce the user back to
  // mcp-server/authorize-callback with ?error so the MCP client sees a
  // clean OAuth error instead of being stranded on cojournalist.ai.
  if (payload?.mcp_callback && payload?.mcp_state) {
    try {
      const target = new URL(payload.mcp_callback);
      target.searchParams.set("error", errorCode);
      target.searchParams.set("error_description", description);
      target.searchParams.set("mcp_state", payload.mcp_state);
      logEvent({
        level: "warn",
        fn: "mcp-auth",
        event: "bounce_to_mcp_error",
        request_id: requestId,
        error: errorCode,
        location: target.toString(),
      });
      return new Response(null, {
        status: 302,
        headers: { Location: target.toString() },
      });
    } catch {
      /* fall through to JSON error */
    }
  }
  return jsonError(description, 400, requestId);
}

async function handleLogin(req: Request, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const mcpCallback = url.searchParams.get("mcp_callback") ?? "";
  const mcpState = url.searchParams.get("mcp_state") ?? "";

  logEvent({
    level: "info",
    fn: "mcp-auth.login",
    event: "login_in",
    request_id: requestId,
    has_mcp_callback: mcpCallback.length > 0,
    has_mcp_state: mcpState.length > 0,
    mcp_callback_host: (() => {
      try { return new URL(mcpCallback).host; } catch { return null; }
    })(),
  });

  if (!mcpCallback || !mcpState) {
    return jsonError("mcp_callback and mcp_state are required", 400, requestId);
  }
  if (!isValidMcpCallback(mcpCallback)) {
    return jsonError("invalid mcp_callback", 400, requestId);
  }

  const state = await createMcpState(stateSecret(), {
    mcp_callback: mcpCallback,
    mcp_state: mcpState,
  });

  logEvent({
    level: "info",
    fn: "mcp-auth.login",
    event: "redirect_to_muckrock",
    request_id: requestId,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl(state) },
  });
}

async function handleCallback(req: Request, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  logEvent({
    level: "info",
    fn: "mcp-auth.callback",
    event: "callback_in",
    request_id: requestId,
    has_code: !!code,
    has_state: !!state,
    has_error: !!error,
    state_prefix_ok: state?.startsWith(STATE_PREFIX) ?? false,
  });

  // Verify state up front so any error path can still bounce back to
  // the MCP client with the original mcp_state preserved.
  let payload: StatePayload | null = null;
  if (state) payload = await verifyMcpState(stateSecret(), state);

  if (error) {
    logEvent({
      level: "warn",
      fn: "mcp-auth.callback",
      event: "muckrock_oauth_error",
      request_id: requestId,
      error,
    });
    return bounceToMcpError(payload, "access_denied", error, requestId);
  }
  if (!code || !state) {
    return bounceToMcpError(payload, "invalid_request", "missing code or state", requestId);
  }
  if (!payload) {
    logEvent({
      level: "warn",
      fn: "mcp-auth.callback",
      event: "state_invalid",
      request_id: requestId,
    });
    return jsonError("invalid state", 400, requestId);
  }

  // 1. Exchange code for MuckRock access token
  const muckrockBase = envOr("MUCKROCK_BASE_URL", "https://accounts.muckrock.com").replace(
    /\/$/,
    "",
  );
  let accessToken: string;
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
        event: "token_exchange_failed",
        request_id: requestId,
        status: tokenRes.status,
      });
      return bounceToMcpError(payload, "server_error", "muckrock token exchange failed", requestId);
    }
    accessToken = (await tokenRes.json() as { access_token: string }).access_token;
  } catch (e) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "token_exchange_exception",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return bounceToMcpError(payload, "server_error", "muckrock token exchange exception", requestId);
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
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!uRes.ok) {
      logEvent({
        level: "error",
        fn: "mcp-auth.callback",
        event: "userinfo_failed",
        request_id: requestId,
        status: uRes.status,
      });
      return bounceToMcpError(payload, "server_error", "muckrock userinfo failed", requestId);
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
    return bounceToMcpError(payload, "server_error", "muckrock userinfo exception", requestId);
  }

  // 3. Email allowlist
  if (!isEmailAllowed(userinfo.email)) {
    logEvent({
      level: "info",
      fn: "mcp-auth.callback",
      event: "email_denied",
      request_id: requestId,
      email_domain: userinfo.email?.split("@").pop() ?? null,
    });
    return bounceToMcpError(payload, "access_denied", "email not allowed", requestId);
  }

  const supabaseUrl = serviceSupabaseUrl();
  const serviceKey = serviceRoleKey();
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 4. Upsert Supabase auth user with MuckRock UUID as id
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
        return bounceToMcpError(payload, "server_error", "supabase user upsert failed", requestId);
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
    return bounceToMcpError(payload, "server_error", "supabase user upsert exception", requestId);
  }

  // 5. Entitlement sync (best-effort) — failure here doesn't block sign-in.
  try {
    const client = new MuckrockClient();
    const fullUser = await client.fetchUserData(userinfo.uuid);
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

  // 6. Generate magiclink. redirect_to is the mcp-server EF callback (with
  //    the original mcp_state echoed back as a query param). Supabase
  //    appends session tokens to the URL fragment on the bounce.
  try {
    const callback = new URL(payload.mcp_callback);
    callback.searchParams.set("mcp_state", payload.mcp_state);
    const redirectTo = callback.toString();

    const { data, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: userinfo.email ?? "",
      options: { redirectTo },
    });
    if (linkErr || !data?.properties?.action_link) {
      logEvent({
        level: "error",
        fn: "mcp-auth.callback",
        event: "magiclink_failed",
        request_id: requestId,
        // Critical observability: this is the most likely failure point
        // (Supabase Auth allowlist rejecting the redirectTo URL).
        msg: linkErr?.message ?? "no action_link",
        redirect_to_host: callback.host,
        redirect_to_path: callback.pathname,
      });
      return bounceToMcpError(payload, "server_error", "magiclink generation failed", requestId);
    }

    logEvent({
      level: "info",
      fn: "mcp-auth.callback",
      event: "magiclink_issued",
      request_id: requestId,
      redirect_to_host: callback.host,
    });

    return new Response(null, {
      status: 302,
      headers: { Location: data.properties.action_link },
    });
  } catch (e) {
    logEvent({
      level: "error",
      fn: "mcp-auth.callback",
      event: "magiclink_exception",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return bounceToMcpError(payload, "server_error", "magiclink exception", requestId);
  }
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
