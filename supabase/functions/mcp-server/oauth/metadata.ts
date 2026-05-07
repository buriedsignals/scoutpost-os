/**
 * RFC 8414 OAuth 2.0 Authorization Server Metadata and RFC 9728
 * OAuth 2.0 Protected Resource Metadata.
 *
 * `issuer` MUST equal the base URL of the mcp-server function exactly —
 * MCP clients enforce this. We derive it from `SUPABASE_URL` at runtime so
 * the same code works in dev (127.0.0.1:54321) and prod.
 */

import { corsHeaders } from "../../_shared/cors.ts";

export function baseUrl(): string {
  const url = Deno.env.get("MCP_SERVER_BASE_URL") ??
    `${
      Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321"
    }/functions/v1/mcp-server`;
  return url.replace(/\/+$/, "");
}

export function metadataHandler(_req: Request): Response {
  const issuer = baseUrl();
  const body = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["mcp"],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

export function protectedResourceHandler(_req: Request): Response {
  const resource = baseUrl();
  const body = {
    resource,
    authorization_servers: [resource],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_documentation:
      "https://www.scoutpost.ai/skills/scoutpost.md",
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
