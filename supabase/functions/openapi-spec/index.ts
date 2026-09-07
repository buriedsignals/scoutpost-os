/**
 * openapi-spec Edge Function — serves the static OpenAPI 3.1.0 spec for
 * coJournalist v2. No authentication required; consumers discover the API
 * surface by GETting this endpoint. HEAD is also allowed for route sweeps,
 * uptime checks, and clients that probe metadata before downloading the body.
 */

import { corsHeaders, handleCors } from "../_shared/cors.ts";
import spec from "./spec.json" with { type: "json" };

const specJson = JSON.stringify(spec);

Deno.serve((req): Response => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(
      JSON.stringify({
        error: "method not allowed",
        code: "method_not_allowed",
      }),
      {
        status: 405,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  }

  return new Response(req.method === "HEAD" ? null : specJson, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
});
