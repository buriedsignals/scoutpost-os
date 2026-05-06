/**
 * auth-muckrock Edge Function — MuckRock OAuth broker + Supabase magiclink handoff.
 *
 * Ports the legacy FastAPI broker (backend/app/routers/auth.py) to an EF and
 * folds in ticket #20 (team-tier sync at callback): before the magiclink
 * redirect, we run `applyUserEvent` so the caller lands in the app with their
 * tier, credit pool, and team-org membership already populated.
 *
 * Routes (after Kong strips `/functions/v1/auth-muckrock`):
 *   GET /login     — 302 to MuckRock authorize endpoint. Optional
 *                    `post_login_redirect` is accepted only for localhost
 *                    /auth/callback targets in local dev.
 *   GET /callback  — exchange code, upsert Supabase user, sync tier, 302
 *                    to the Supabase magiclink.
 *
 * This function sets `verify_jwt = false` — these are browser-facing redirects
 * hit directly (no Supabase JWT or anon key available).
 *
 * Required env vars (Supabase secrets):
 *   MUCKROCK_CLIENT_ID, MUCKROCK_CLIENT_SECRET
 *   MUCKROCK_BASE_URL (optional, default https://accounts.muckrock.com)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase)
 *   SERVICE_SUPABASE_URL, SERVICE_SUPABASE_SERVICE_ROLE_KEY (optional local-dev
 *     overrides when `supabase functions serve` blocks custom SUPABASE_* vars)
 *   SESSION_SECRET — HMAC key for stateless OAuth state tokens
 *   PUBLIC_APP_URL — app origin. Used for (a) error redirects and (b) the
 *     MuckRock-registered `redirect_uri`: `${PUBLIC_APP_URL}/api/auth/callback`
 *     is proxied by Render to this EF's /callback, preserving signed state.
 *   MUCKROCK_CALLBACK_URL (optional) — override the computed redirect_uri
 *     if MuckRock is pointed at a non-proxied URL.
 *   APP_POST_LOGIN_REDIRECT — frontend route that parses the hash tokens
 *     (named APP_* not SUPABASE_* because Supabase reserves SUPABASE_* for
 *     its own auto-injected env vars and rejects user-set names there)
 *   EMAIL_ALLOWLIST (optional) — comma-separated emails / @domain patterns
 *
 * redirect_uri registered with MuckRock (client 879742):
 *   production:  https://cojournalist.ai/api/auth/callback   (apex — NOT www)
 *   development: http://localhost:5173/api/auth/callback
 * Production requests proxy through the Render backend at
 * backend/app/routers/muckrock_proxy.py which 302s to this EF's /callback.
 * The `MUCKROCK_CALLBACK_URL` EF secret is set to the apex string so
 * callbackUrl() returns it on both the authorize and token-exchange calls
 * (RFC 6749 §4.1.3 byte-match). Do NOT change to `www.cojournalist.ai` —
 * MuckRock will reject with "Redirect URI Error".
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors } from "../_shared/cors.ts";
import { logEvent } from "../_shared/log.ts";
import { MuckrockClient } from "../_shared/muckrock.ts";
import { applyUserEvent } from "../_shared/entitlements.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import {
  buildLocalPostLoginHandoffUrl,
  parseAllowedPostLoginRedirect,
} from "./redirects.ts";

const SCOPES = "openid profile uuid organizations email preferences";
const STATE_TTL_SECONDS = 600;

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
  return Deno.env.get("SERVICE_SUPABASE_SERVICE_ROLE_KEY") ?? envOrThrow("SUPABASE_SERVICE_ROLE_KEY");
}

function stripPrefix(pathname: string): string {
  return pathname.replace(/^.*\/auth-muckrock/, "") || "/";
}

function callbackUrl(): string {
  // MUST match the redirect_uri registered with MuckRock's OAuth client.
  // We keep MuckRock pointing at the pre-cutover cojournalist.ai URL
  // (no OAuth client reconfiguration needed) and proxy that URL on the
  // Render backend to this EF — see backend/app/routers/muckrock_proxy.py
  // for the 302 that preserves the signed `state` byte-for-byte.
  //
  // If you ever want to switch MuckRock to register the Supabase URL
  // directly, override MUCKROCK_CALLBACK_URL on the EF.
  const override = Deno.env.get("MUCKROCK_CALLBACK_URL");
  if (override) return override;
  const base = envOrThrow("PUBLIC_APP_URL").replace(/\/$/, "");
  return `${base}/api/auth/callback`;
}

function authorizeUrl(state: string): string {
  const muckrockBase = envOr("MUCKROCK_BASE_URL", "https://accounts.muckrock.com").replace(/\/$/, "");
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
// Signed state token (HMAC-SHA256, stateless — no storage)
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
  /** Optional local-dev frontend callback after Supabase magiclink. */
  post_login_redirect?: string;
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
}

async function createState(secret: string, extra: Partial<StatePayload> = {}): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const ts = Math.floor(Date.now() / 1000);
  const payload: StatePayload = { nonce, ts, ...extra };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

async function verifyState(
  secret: string,
  state: string,
): Promise<StatePayload | null> {
  const dot = state.indexOf(".");
  if (dot < 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = await hmac(secret, body);
  if (!constantTimeEq(sig, expected)) return null;
  let parsed: StatePayload;
  try {
    parsed = JSON.parse(b64urlDecode(body)) as StatePayload;
  } catch {
    return null;
  }
  if (typeof parsed.nonce !== "string" || typeof parsed.ts !== "number") return null;
  const age = Math.floor(Date.now() / 1000) - parsed.ts;
  if (age < 0 || age > STATE_TTL_SECONDS) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Email allowlist
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

function redirectToLogin(errorCode: string, publicBase: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${publicBase.replace(/\/$/, "")}/login?error=${errorCode}` },
  });
}

async function handleLogin(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const postLoginRedirect = parseAllowedPostLoginRedirect(
    url.searchParams.get("post_login_redirect"),
  );
  if (url.searchParams.has("post_login_redirect") && !postLoginRedirect) {
    return jsonError("invalid post_login_redirect", 400);
  }
  const state = await createState(envOrThrow("SESSION_SECRET"), {
    post_login_redirect: postLoginRedirect,
  });
  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl(state) },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function resolveActionLinkRedirect(actionLink: string): Promise<string | null> {
  const response = await fetch(actionLink, { redirect: "manual" });
  if (response.status < 300 || response.status >= 400) return null;
  return response.headers.get("location");
}

async function handleCallback(req: Request): Promise<Response> {
  const publicBase = envOrThrow("PUBLIC_APP_URL");
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    logEvent({ level: "warn", fn: "auth-muckrock", event: "oauth_error", msg: error });
    return redirectToLogin("oauth_denied", publicBase);
  }
  if (!code || !state) {
    return redirectToLogin("callback_failed", publicBase);
  }
  const statePayload = await verifyState(envOrThrow("SESSION_SECRET"), state);
  if (!statePayload) {
    logEvent({ level: "warn", fn: "auth-muckrock", event: "state_invalid" });
    return redirectToLogin("callback_failed", publicBase);
  }

  // 1. Exchange code for MuckRock access token
  const muckrockBase = envOr("MUCKROCK_BASE_URL", "https://accounts.muckrock.com").replace(/\/$/, "");
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
        fn: "auth-muckrock",
        event: "token_exchange_failed",
        msg: `status=${tokenRes.status}`,
      });
      return redirectToLogin("callback_failed", publicBase);
    }
    accessToken = (await tokenRes.json() as { access_token: string }).access_token;
  } catch (e) {
    logEvent({
      level: "error",
      fn: "auth-muckrock",
      event: "token_exchange_exception",
      msg: e instanceof Error ? e.message : String(e),
    });
    return redirectToLogin("callback_failed", publicBase);
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
        fn: "auth-muckrock",
        event: "userinfo_failed",
        msg: `status=${uRes.status}`,
      });
      return redirectToLogin("callback_failed", publicBase);
    }
    userinfo = await uRes.json();
  } catch (e) {
    logEvent({
      level: "error",
      fn: "auth-muckrock",
      event: "userinfo_exception",
      msg: e instanceof Error ? e.message : String(e),
    });
    return redirectToLogin("callback_failed", publicBase);
  }

  // 3. Email allowlist
  if (!isEmailAllowed(userinfo.email)) {
    logEvent({
      level: "info",
      fn: "auth-muckrock",
      event: "email_denied",
      msg: userinfo.email ?? "<none>",
    });
    return redirectToLogin("not_available", publicBase);
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
          fn: "auth-muckrock",
          event: "supabase_create_failed",
          msg: createErr.message,
        });
        return redirectToLogin("callback_failed", publicBase);
      }
    }
  } catch (e) {
    logEvent({
      level: "error",
      fn: "auth-muckrock",
      event: "supabase_create_exception",
      msg: e instanceof Error ? e.message : String(e),
    });
    return redirectToLogin("callback_failed", publicBase);
  }

  // 5. Team-tier sync (#20) — populate credits, org, membership BEFORE magiclink.
  //    Swallows errors so a transient MuckRock API hiccup doesn't block login;
  //    the nightly webhook (#21) will reconcile. We re-fetch via MuckRock
  //    client to get full entitlements (userinfo endpoint omits them).
  try {
    const client = new MuckrockClient();
    const fullUser = await client.fetchUserData(userinfo.uuid);
    await applyUserEvent(getServiceClient(), fullUser);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "auth-muckrock",
      event: "team_sync_skipped",
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  // 6. Generate magiclink action URL — no email is sent; admin API returns the URL.
  //    Redirect lands on PUBLIC_APP_URL (APP_POST_LOGIN_REDIRECT); local dev
  //    can hand the resulting Supabase session fragment back to localhost.
  try {
    const fallbackRedirect = envOrThrow("APP_POST_LOGIN_REDIRECT");
    const localBrowserRedirect = statePayload.post_login_redirect;
    const shouldUseLocalHandoff = Boolean(localBrowserRedirect);
    const { data, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: userinfo.email ?? "",
      options: { redirectTo: fallbackRedirect },
    });
    if (linkErr || !data?.properties?.action_link) {
      logEvent({
        level: "error",
        fn: "auth-muckrock",
        event: "magiclink_failed",
        msg: linkErr?.message ?? "no action_link",
      });
      return redirectToLogin("callback_failed", publicBase);
    }

    if (shouldUseLocalHandoff) {
      const actionLocation = await resolveActionLinkRedirect(data.properties.action_link);
      const browserLocation = actionLocation && localBrowserRedirect
        ? buildLocalPostLoginHandoffUrl(localBrowserRedirect, actionLocation)
        : undefined;

      if (!browserLocation) {
        logEvent({
          level: "error",
          fn: "auth-muckrock",
          event: "local_handoff_failed",
          msg: actionLocation ?? "missing action location",
        });
        return redirectToLogin("callback_failed", publicBase);
      }

      return new Response(null, {
        status: 302,
        headers: { Location: browserLocation },
      });
    }

    return new Response(null, {
      status: 302,
      headers: { Location: data.properties.action_link },
    });
  } catch (e) {
    logEvent({
      level: "error",
      fn: "auth-muckrock",
      event: "magiclink_exception",
      msg: e instanceof Error ? e.message : String(e),
    });
    return redirectToLogin("callback_failed", publicBase);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  const path = stripPrefix(new URL(req.url).pathname);

  try {
    if (path === "/login" && req.method === "GET") return await handleLogin(req);
    if (path === "/callback" && req.method === "GET") return await handleCallback(req);
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    logEvent({
      level: "error",
      fn: "auth-muckrock",
      event: "unhandled",
      path,
      msg: e instanceof Error ? e.message : String(e),
    });
    const publicBase = Deno.env.get("PUBLIC_APP_URL") ?? "/";
    return redirectToLogin("callback_failed", publicBase);
  }
});
