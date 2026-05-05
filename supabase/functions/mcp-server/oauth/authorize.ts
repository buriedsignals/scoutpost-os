/**
 * Remote MCP OAuth flow for browser-based agents (claude.ai, ChatGPT, etc).
 *
 *   GET  /authorize                   — validate client, 302 to auth-muckrock
 *   GET  /authorize-callback          — HTML bounce: reads fragment tokens,
 *                                        POSTs them to /authorize-callback-commit
 *   POST /authorize-callback-commit   — mint the MCP code, 302 to client
 *
 * Supabase's magiclink redirect delivers `access_token` + `refresh_token` in
 * the URL fragment (not the query), so the intermediate HTML page is the
 * simplest way to land them on the server without leaking them to analytics.
 * The browser POSTs same-origin to commit — no CORS handshake required.
 */

import { getServiceClient } from "../../_shared/supabase.ts";
import { logEvent } from "../../_shared/log.ts";
import { base64urlEncode, signState, verifyState } from "./state.ts";
import { baseUrl } from "./metadata.ts";
import { oauthError } from "./errors.ts";

function randUrlSafe(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64urlEncode(buf);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const callback = `${baseUrl()}/authorize-callback`;
  const target = new URL(brokerBaseUrl());
  // auth-muckrock EF reads these params on /login and threads them through
  // the MuckRock OAuth handshake + Supabase magiclink, so the magiclink's
  // post-login redirect lands here with the signed mcp_state preserved.
  target.searchParams.set("mcp_callback", callback);
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

/**
 * GET /authorize-callback
 *
 * Supabase magiclink lands the browser here with tokens in the URL
 * fragment (`#access_token=…&refresh_token=…`) and `mcp_state` in the
 * query. Fragments never reach the server — so we render a tiny HTML
 * page that parses `location.hash` client-side and POSTs the tokens
 * same-origin to /authorize-callback-commit.
 *
 * Error path: if Supabase forwarded `?error=…` (no fragment), commit the
 * redirect back to the MCP client immediately from the server.
 */
export async function renderCallbackPage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const brokerError = url.searchParams.get("error");
  const mcpState = url.searchParams.get("mcp_state");

  if (brokerError) {
    if (mcpState) {
      try {
        const payload = await verifyState(mcpState);
        const target = new URL(payload.redirect_uri);
        target.searchParams.set("error", brokerError);
        const desc = url.searchParams.get("error_description");
        if (desc) target.searchParams.set("error_description", desc);
        if (payload.state) target.searchParams.set("state", payload.state);
        return new Response(null, { status: 302, headers: { Location: target.toString() } });
      } catch {
        /* fall through */
      }
    }
    return oauthError("access_denied", brokerError, 400);
  }

  const commitUrl = `${baseUrl()}/authorize-callback-commit`;
  const html = callbackBounceHtml(commitUrl);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Defense-in-depth — this page only runs our own inline script and
      // POSTs same-origin. No third-party loads needed.
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    },
  });
}

function escapeForTemplate(s: string): string {
  // Only protect against breaking out of the single-quoted string literal
  // we embed the URL in. Simple + sufficient because baseUrl() never carries
  // quotes or newlines in practice.
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function callbackBounceHtml(commitUrl: string): string {
  const safe = escapeForTemplate(commitUrl);
  // Inline JS + hidden form. Any failure surfaces as a visible error so
  // the user can report it — never silently redirect on a broken flow.
  return `<!doctype html>
<meta charset="utf-8">
<title>Signing you in…</title>
<style>body{font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:4rem auto;padding:0 1rem;color:#222}.err{color:#b00}</style>
<body>
<p id="msg">Signing you in…</p>
<noscript>JavaScript is required to complete the login redirect. Please enable JavaScript and return to the MCP client.</noscript>
<script>
(function(){
  var COMMIT='${safe}';
  function fail(m){var el=document.getElementById('msg');el.className='err';el.textContent=m;}
  try{
    var hash=(location.hash||'').replace(/^#/,'');
    var q=new URLSearchParams(location.search);
    var h=new URLSearchParams(hash);
    var at=h.get('access_token');
    var rt=h.get('refresh_token');
    var st=q.get('mcp_state');
    if(!at||!rt||!st){
      fail('Missing tokens in redirect — re-start the MCP client login.');
      return;
    }
    var f=document.createElement('form');
    f.method='POST';
    f.action=COMMIT;
    f.style.display='none';
    function add(n,v){var i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.appendChild(i);}
    add('access_token',at);
    add('refresh_token',rt);
    add('mcp_state',st);
    document.body.appendChild(f);
    // Clear the hash so the tokens aren't retained in history.
    history.replaceState(null,'',location.pathname+location.search);
    f.submit();
  }catch(e){fail('Login redirect failed: '+String(e));}
})();
</script>
</body>`;
}

/**
 * POST /authorize-callback-commit
 *
 * Receives the fragment-tokens same-origin from the HTML bounce. Validates
 * the Supabase access token, mints an MCP authorization code tied to the
 * PKCE challenge from the signed mcp_state, and 302s to the MCP client's
 * original redirect_uri.
 */
export async function commitCallback(req: Request, requestId?: string): Promise<Response> {
  logEvent({
    level: "info",
    fn: "mcp-server.commit",
    event: "commit_in",
    request_id: requestId,
    content_type: req.headers.get("content-type") ?? null,
  });
  let form: URLSearchParams;
  try {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("application/json")) {
      const body = await req.json();
      form = new URLSearchParams(
        Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v ?? "")])),
      );
    } else {
      const text = await req.text();
      form = new URLSearchParams(text);
    }
  } catch {
    return oauthError("invalid_request", "failed to parse commit body", 400);
  }

  const accessToken = form.get("access_token") ?? "";
  const refreshToken = form.get("refresh_token") ?? "";
  const mcpState = form.get("mcp_state") ?? "";

  if (!accessToken || !refreshToken || !mcpState) {
    return oauthError(
      "invalid_request",
      "missing access_token, refresh_token, or mcp_state",
      400,
    );
  }

  let payload;
  try {
    payload = await verifyState(mcpState);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "mcp-server.commit",
      event: "bad_state",
      msg: e instanceof Error ? e.message : String(e),
    });
    return oauthError("invalid_request", "invalid mcp_state", 400);
  }

  const db = getServiceClient();
  const { data: userData, error: userErr } = await db.auth.getUser(accessToken);
  if (userErr || !userData.user) {
    logEvent({
      level: "warn",
      fn: "mcp-server.commit",
      event: "bad_access_token",
      msg: userErr?.message,
    });
    return oauthError("invalid_request", "access_token did not resolve to a user", 400);
  }
  const userId = userData.user.id;

  const code = randUrlSafe(32);
  const { error: insertErr } = await db.from("mcp_oauth_codes").insert({
    code,
    client_id: payload.client_id,
    user_id: userId,
    supabase_access_token: accessToken,
    supabase_refresh_token: refreshToken,
    code_challenge: payload.code_challenge,
    code_challenge_method: "S256",
    redirect_uri: payload.redirect_uri,
    scopes: [],
  });
  if (insertErr) {
    logEvent({
      level: "error",
      fn: "mcp-server.commit",
      event: "code_insert_failed",
      msg: insertErr.message,
    });
    return oauthError("server_error", "failed to mint authorization code", 500);
  }

  const target = new URL(payload.redirect_uri);
  target.searchParams.set("code", code);
  if (payload.state) target.searchParams.set("state", payload.state);

  logEvent({
    level: "info",
    fn: "mcp-server.commit",
    event: "code_issued",
    client_id: payload.client_id,
    user_id: userId,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: target.toString() },
  });
}
