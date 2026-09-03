/**
 * Stack-free unit tests for the /register redirect_uri policy. Runs in CI's
 * network-isolated Deno set (see .github/workflows/ci.yml); no Supabase stack.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { validateRedirectUri } from "./register.ts";
// ---------------------------------------------------------------------------
// register: redirect_uri policy (pure, no DB). Native MCP clients register a
// private-use scheme as their callback (Cursor sends cursor://, RFC 8252
// §7.1); browsers-executable and file/mail schemes stay refused.
// ---------------------------------------------------------------------------
Deno.test("register: accepts https, loopback http, and native-app redirect schemes", () => {
  for (const uri of [
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "http://localhost:8787/callback",
    "http://127.0.0.1:19876/mcp/oauth/callback",
    "cursor://anysphere.cursor-deeplink/mcp/oauth/callback",
    "vscode://ms-vscode.mcp/oauth/callback",
    "com.example.app:/oauth2redirect",
  ]) {
    const check = validateRedirectUri(uri);
    assertEquals(check.ok, true, uri);
    if (check.ok) assertEquals(check.uri, uri);
  }
});

Deno.test("register: refuses executable, file, and mail redirect schemes", () => {
  for (const uri of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "blob:https://scoutpost.ai/x",
    "mailto:someone@example.com",
    "vbscript:msgbox(1)",
  ]) {
    const check = validateRedirectUri(uri);
    assertEquals(check.ok, false, uri);
    if (!check.ok) assertStringIncludes(check.message, "redirect_uri scheme must be");
  }
  assertEquals(validateRedirectUri("not a url").ok, false);
  assertEquals(validateRedirectUri("").ok, false);
  assertEquals(validateRedirectUri(42).ok, false);
});
