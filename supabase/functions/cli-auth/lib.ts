const PRINTABLE_RE = /[^\x20-\x7E]/g;
const USER_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export const DEVICE_TTL_SECONDS = 600;
export const POLL_INTERVAL_SECONDS = 5;
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export function sanitizeLabel(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(PRINTABLE_RE, " ").replace(/\s+/g, " ")
    .trim().slice(0, maxLength);
  return normalized || null;
}

export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const formatted = compact.length === 8
    ? `${compact.slice(0, 4)}-${compact.slice(4)}`
    : value.toUpperCase();
  return USER_CODE_RE.test(formatted) ? formatted : null;
}

export function randomUrlToken(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (value) => alphabet[value % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function safeSiteOrigin(req: Request, advertised?: unknown): string {
  const configured = Deno.env.get("SCOUTPOST_SITE_URL")?.trim() ||
    Deno.env.get("PUBLIC_APP_URL")?.trim();
  const candidate = configured ||
    (typeof advertised === "string" ? advertised : "") ||
    req.headers.get("origin") ||
    "https://scoutpost.ai";
  const url = new URL(candidate);
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "::1" &&
    !/^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  ) {
    throw new Error("invalid site origin");
  }
  return url.origin;
}

export function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function allowedApprovalOrigin(
  req: Request,
  siteOrigin: string,
): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(siteOrigin).origin;
  } catch {
    return false;
  }
}
