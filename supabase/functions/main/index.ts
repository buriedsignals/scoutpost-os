/**
 * Main Edge Function — entry point for supabase/edge-runtime.
 *
 * The edge-runtime `--main-service` flag points here. Kong strips
 * `/functions/v1/` from the path, so requests arrive as `/execute-scout`.
 * This handler routes to the appropriate sub-function logic inline
 * (dynamic imports conflict with Deno.serve re-registration).
 */

import { requireServiceKey } from "../_shared/auth.ts";
import { AuthError } from "../_shared/errors.ts";

const BACKEND_URL = Deno.env.get("BACKEND_URL") ?? "http://backend:8000";
const SERVICE_KEY = Deno.env.get("INTERNAL_SERVICE_KEY") ?? "";

const EXECUTE_ENDPOINTS: Record<string, string> = {
  web: "/api/scouts/execute",
  // `beat` is the canonical scout type; the `/api/pulse/execute` path is a
  // historical name retained by the downstream Supabase executor for route
  // compatibility.
  beat: "/api/pulse/execute",
  social: "/api/social/execute",
  civic: "/api/civic/execute",
};

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const jsonHeaders = { "Content-Type": "application/json" };

  // Root health check
  if (url.pathname === "/" || url.pathname === "") {
    return new Response(
      JSON.stringify({ status: "ok", service: "edge-functions" }),
      { status: 200, headers: jsonHeaders },
    );
  }

  // Route: /execute-scout — forward scout execution to FastAPI backend
  if (url.pathname === "/execute-scout") {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: jsonHeaders,
      });
    }

    try {
      try {
        requireServiceKey(req);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: e instanceof AuthError ? e.status : 401,
          headers: jsonHeaders,
        });
      }

      const body = await req.json();
      const scoutType: string = body.scout_type ?? body.type ?? "";
      const endpoint = EXECUTE_ENDPOINTS[scoutType];

      if (!endpoint) {
        return new Response(
          JSON.stringify({ error: `Unknown scout type: ${scoutType}` }),
          { status: 400, headers: jsonHeaders },
        );
      }

      console.log(
        `Executing ${scoutType} scout: ${
          body.scout_id ?? body.scraper_name ?? "unknown"
        }`,
      );

      const response = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Key": SERVICE_KEY,
        },
        body: JSON.stringify(body),
      });

      const responseBody = await response.text();
      console.log(`Scout execution completed: ${response.status}`);

      return new Response(responseBody, {
        status: response.status,
        headers: jsonHeaders,
      });
    } catch (error) {
      console.error("Error executing scout:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          detail: error instanceof Error ? error.message : String(error),
        }),
        { status: 500, headers: jsonHeaders },
      );
    }
  }

  // Fallback for unknown routes
  return new Response(
    JSON.stringify({ error: "Function not found" }),
    { status: 404, headers: jsonHeaders },
  );
});
