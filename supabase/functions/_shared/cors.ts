/**
 * CORS headers and preflight handling for Edge Functions.
 */

const ALLOWED_METHODS = "GET, HEAD, POST, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS =
  "authorization, content-type, x-service-key, x-client-info, apikey";
const MAX_AGE = "86400";

// Canonical origin returned when the request Origin is not allowlisted. A
// browser making a credentialed cross-origin request from a non-allowlisted
// site will not match this and is correctly blocked.
const CANONICAL_ORIGIN = "https://www.scoutpost.ai";

/**
 * Origins permitted to make credentialed cross-origin requests. Self-hosters
 * extend this via the ALLOWED_CORS_ORIGINS env var (comma-separated).
 */
function allowedOrigins(): Set<string> {
  const base = [
    "https://www.scoutpost.ai",
    "https://scoutpost.ai",
    "https://cojournalist.ai", // legacy migration origin
    "https://www.cojournalist.ai", // legacy migration origin
    "http://localhost:5173", // SvelteKit dev
    "http://localhost:4173", // OSS demo preview
    "http://localhost:7860", // HF Spaces local
  ];
  const extra = (Deno.env.get("ALLOWED_CORS_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return new Set([...base, ...extra]);
}

/**
 * Build CORS headers for a given request origin. Reflects the Origin only when
 * it is allowlisted; otherwise returns the canonical origin (and omits the
 * credentials header) so arbitrary sites cannot make credentialed requests.
 */
export function makeCorsHeaders(origin: string | null): Record<string, string> {
  const isAllowed = origin !== null && allowedOrigins().has(origin);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": isAllowed ? origin : CANONICAL_ORIGIN,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": MAX_AGE,
    "Vary": "Origin",
  };
  if (isAllowed) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

/**
 * Legacy static CORS headers — kept for backward compatibility with
 * responses.ts spread pattern. Echoes "*" which works as long as the
 * frontend does NOT use credentials: 'include'.
 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOWED_METHODS,
  "Access-Control-Allow-Headers": ALLOWED_HEADERS,
  "Access-Control-Max-Age": MAX_AGE,
};

/**
 * Short-circuit handler for OPTIONS preflight requests.
 * Returns a 204 response with CORS headers, or null if the request is not OPTIONS.
 */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("origin");
    return new Response(null, {
      status: 204,
      headers: makeCorsHeaders(origin),
    });
  }
  return null;
}
