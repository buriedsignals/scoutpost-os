/**
 * RFC 7591 Dynamic Client Registration.
 *
 * Public endpoint (no auth): any MCP client can register. We generate a
 * fresh `client_id` (uuid) and, if the client opts into `client_secret_post`
 * or `client_secret_basic`, a 32-byte urlsafe `client_secret`. Only the
 * SHA-256 hash of the secret is persisted.
 *
 * Abuse mitigation lives outside this handler — see Plan 03 §(e) Risk 2.
 */

import { getServiceClient } from "../../_shared/supabase.ts";
import { logEvent } from "../../_shared/log.ts";
import { base64urlEncode } from "./state.ts";
import { oauthError, oauthJson } from "./errors.ts";

interface RegisterBody {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
}

const ALLOWED_AUTH_METHODS = new Set(["none", "client_secret_post", "client_secret_basic"]);
// Native MCP clients (Cursor, VS Code, and other desktop apps) register a
// private-use scheme as their OAuth callback, per RFC 8252 §7.1; Cursor 3.x
// sends a cursor:// redirect and fails registration when it is refused. We
// accept http, https, and well-formed private-use schemes, and refuse the
// schemes a browser could execute or that leak a code to a file or mailbox.
// PKCE (S256) is mandatory on every flow, which is what makes a custom-scheme
// callback safe against interception.
const DENIED_SCHEMES = new Set([
  "javascript",
  "data",
  "blob",
  "file",
  "vbscript",
  "about",
  "chrome",
  "ftp",
  "mailto",
]);
const PRIVATE_USE_SCHEME = /^[a-z][a-z0-9+.-]*$/;

export type RedirectUriCheck = { ok: true; uri: string } | { ok: false; message: string };

export function validateRedirectUri(raw: unknown): RedirectUriCheck {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) {
    return { ok: false, message: "redirect_uris entries must be non-empty strings" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: `redirect_uri is not a valid URL: ${raw}` };
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (DENIED_SCHEMES.has(scheme) || !PRIVATE_USE_SCHEME.test(scheme)) {
    return {
      ok: false,
      message: `redirect_uri scheme must be http, https, or a native app scheme (got ${scheme})`,
    };
  }
  if ((scheme === "http" || scheme === "https") && !parsed.hostname) {
    return { ok: false, message: `redirect_uri must have a host: ${raw}` };
  }
  return { ok: true, uri: raw };
}

export async function registerHandler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return oauthError("invalid_request", "POST required", 405);
  }

  let body: RegisterBody;
  try {
    body = await req.json() as RegisterBody;
  } catch {
    return oauthError("invalid_client_metadata", "request body is not valid JSON", 400);
  }

  const clientName = typeof body.client_name === "string" ? body.client_name.trim() : "";
  if (!clientName) {
    return oauthError("invalid_client_metadata", "client_name is required", 400);
  }
  if (clientName.length > 200) {
    return oauthError("invalid_client_metadata", "client_name too long", 400);
  }

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty array", 400);
  }
  const redirectUris: string[] = [];
  for (const raw of body.redirect_uris) {
    const check = validateRedirectUri(raw);
    if (!check.ok) return oauthError("invalid_redirect_uri", check.message, 400);
    redirectUris.push(check.uri);
  }

  let authMethod = "none";
  if (body.token_endpoint_auth_method !== undefined) {
    if (typeof body.token_endpoint_auth_method !== "string"
        || !ALLOWED_AUTH_METHODS.has(body.token_endpoint_auth_method)) {
      return oauthError(
        "invalid_client_metadata",
        "token_endpoint_auth_method must be one of: none, client_secret_post, client_secret_basic",
        400,
      );
    }
    authMethod = body.token_endpoint_auth_method;
  }

  // Generate id + optional secret.
  const clientId = crypto.randomUUID();
  let clientSecret: string | null = null;
  let clientSecretHash: string | null = null;
  if (authMethod !== "none") {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    clientSecret = base64urlEncode(bytes);
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientSecret));
    clientSecretHash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  const db = getServiceClient();
  const { error } = await db.from("mcp_oauth_clients").insert({
    client_id: clientId,
    client_secret_hash: clientSecretHash,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
  });
  if (error) {
    logEvent({
      level: "error",
      fn: "mcp-server.register",
      event: "insert_failed",
      msg: error.message,
    });
    return oauthError("server_error", "failed to persist client", 500);
  }

  logEvent({
    level: "info",
    fn: "mcp-server.register",
    event: "registered",
    client_id: clientId,
    client_name: clientName,
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const responseBody: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  if (clientSecret) {
    responseBody.client_secret = clientSecret;
    // 0 means "no expiry" per RFC 7591 §3.2.1.
    responseBody.client_secret_expires_at = 0;
  }
  return oauthJson(responseBody, 201);
}
