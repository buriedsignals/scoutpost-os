/**
 * mcp-server Edge Function — MCP (Model Context Protocol) JSON-RPC 2.0
 * server for coJournalist, with an embedded OAuth 2.1 authorization
 * server.
 *
 * PR 1+2 shipped the OAuth skeleton. PR 3 wires the JSON-RPC dispatcher
 * (rpc.ts) — 11 tools forwarded to the units/scouts/projects EFs.
 *
 * Routes (after Kong strips `/mcp-server/` from the path):
 *
 *   GET  /.well-known/oauth-authorization-server  -> RFC 8414 metadata
 *   GET  /.well-known/oauth-protected-resource    -> RFC 9728 metadata
 *   POST /register                                -> RFC 7591 dynamic reg
 *   GET  /authorize                               -> 302 to mcp-auth
 *   POST /token                                   -> OAuth 2.1 token endpoint
 *   POST /                                        -> JSON-RPC (PR 3)
 *   *                                             -> 404 JSON
 *
 * This function sets `verify_jwt = false` in config.toml — the OAuth
 * endpoints are (by design) unauthenticated, and the future JSON-RPC
 * handler does its own token verification via `requireUser`.
 */

import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { logEvent } from "../_shared/log.ts";
import { metadataHandler, protectedResourceHandler } from "./oauth/metadata.ts";
import { registerHandler } from "./oauth/register.ts";
import { authorize } from "./oauth/authorize.ts";
import { tokenHandler } from "./oauth/token.ts";
import { oauthError } from "./oauth/errors.ts";
import { handleRpc, MCP_PROTOCOL_VERSION } from "./rpc.ts";

export function stripPrefix(pathname: string): string {
  // Kong may keep the function name in the path ("/mcp-server/x") or strip
  // it ("/x"); handle both. Also collapse trailing slashes.
  const stripped = pathname.replace(/^\/+mcp-server(\/|$)/, "/").replace(
    /\/+$/,
    "",
  );
  return stripped === "" ? "/" : stripped;
}

export async function handleRequest(req: Request): Promise<Response> {
  const cors = handleCors(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const path = stripPrefix(url.pathname);
  const isRead = req.method === "GET" || req.method === "HEAD";

  // Per-request trace so we can correlate the OAuth + MCP-RPC chain end-to-end
  // when debugging Anthropic-side silent failures (MCP issue #1675).
  // Headers are inspected for presence/length only — never log token values.
  const requestId = crypto.randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const sessionId = req.headers.get("mcp-session-id") ?? "";
  logEvent({
    level: "info",
    fn: "mcp-server",
    event: "request_in",
    request_id: requestId,
    method: req.method,
    path,
    has_auth: auth.length > 0,
    auth_scheme: auth.split(" ")[0] || null,
    auth_len: auth.length || 0,
    user_agent: req.headers.get("user-agent") ?? null,
    mcp_protocol_version: req.headers.get("mcp-protocol-version") ?? null,
    mcp_session_id: sessionId || null,
    accept: req.headers.get("accept") ?? null,
    origin: req.headers.get("origin") ?? null,
    forwarded_for: req.headers.get("x-forwarded-for") ?? null,
  });
  const startedAt = Date.now();

  const respond = (res: Response): Response => {
    logEvent({
      level: res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info",
      fn: "mcp-server",
      event: "request_out",
      request_id: requestId,
      method: req.method,
      path,
      status: res.status,
      ms: Date.now() - startedAt,
      content_type: res.headers.get("content-type") ?? null,
      www_authenticate: res.headers.get("www-authenticate") ?? null,
      location: res.headers.get("location") ?? null,
    });
    return res;
  };

  const dispatch = async (): Promise<Response> => {
    // RFC 8414 metadata
    if (path === "/.well-known/oauth-authorization-server" && isRead) {
      return metadataHandler(req);
    }
    // RFC 9728 protected resource metadata
    if (path === "/.well-known/oauth-protected-resource" && isRead) {
      return protectedResourceHandler(req);
    }
    // RFC 7591 dynamic client registration
    if (path === "/register" && req.method === "POST") {
      return await registerHandler(req);
    }
    // OAuth authorization endpoint. The post-OIDC callback / code mint
    // happen entirely inside mcp-auth — there is no /authorize-callback
    // hop on this EF. mcp-auth 302s the browser straight to the MCP
    // client's redirect_uri after writing the code.
    if (path === "/authorize" && isRead) {
      return await authorize(req, requestId);
    }
    // OAuth token endpoint
    if (path === "/token" && req.method === "POST") {
      return await tokenHandler(req, requestId);
    }

    // JSON-RPC body — MCP protocol surface.
    if (path === "/" && req.method === "POST") {
      return await handleRpc(req, requestId);
    }

    // MCP Streamable HTTP discovery: clients HEAD the root to confirm the
    // server speaks MCP and to read the advertised protocol version.
    if (path === "/" && req.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          ...corsHeaders,
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Allow": "POST, HEAD, OPTIONS",
        },
      });
    }
    // Per MCP spec / Vetticaden playbook: GET on the root must return 405
    // (not 404 / 501) so clients understand "POST-only by design" and keep
    // the session, instead of giving up and showing "Disconnected".
    if (path === "/" && req.method === "GET") {
      return new Response(
        JSON.stringify({
          error: "method_not_allowed",
          error_description: "MCP endpoint is POST-only. Use POST with JSON-RPC 2.0 over HTTP.",
        }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8",
            "Allow": "POST, HEAD, OPTIONS",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          },
        },
      );
    }

    return oauthError(
      "invalid_request",
      `no route for ${req.method} ${path}`,
      404,
    );
  };

  try {
    return respond(await dispatch());
  } catch (e) {
    logEvent({
      level: "error",
      fn: "mcp-server",
      event: "unhandled",
      request_id: requestId,
      msg: e instanceof Error ? e.message : String(e),
    });
    return respond(oauthError("server_error", "internal error", 500));
  }
}

Deno.serve(handleRequest);
