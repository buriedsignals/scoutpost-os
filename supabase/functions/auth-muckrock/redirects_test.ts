import {
  buildLocalPostLoginHandoffUrl,
  parseAllowedPostLoginRedirect,
} from "./redirects.ts";

Deno.test("parseAllowedPostLoginRedirect accepts localhost auth callback", () => {
  const redirect = parseAllowedPostLoginRedirect("http://localhost:5173/auth/callback");
  if (redirect !== "http://localhost:5173/auth/callback") {
    throw new Error(`expected localhost callback, got ${redirect ?? "undefined"}`);
  }
});

Deno.test("parseAllowedPostLoginRedirect rejects non-local hosts", () => {
  const redirect = parseAllowedPostLoginRedirect("https://cojournalist.ai/auth/callback");
  if (redirect !== undefined) {
    throw new Error(`expected redirect to be rejected, got ${redirect}`);
  }
});

Deno.test("buildLocalPostLoginHandoffUrl rewrites the Supabase redirect onto localhost", () => {
  const handoff = buildLocalPostLoginHandoffUrl(
    "http://localhost:5173/auth/callback",
    "https://www.cojournalist.ai/auth/callback#access_token=abc&refresh_token=def",
  );
  if (handoff !== "http://localhost:5173/auth/callback#access_token=abc&refresh_token=def") {
    throw new Error(`unexpected handoff ${handoff ?? "undefined"}`);
  }
});

Deno.test("buildLocalPostLoginHandoffUrl rejects action redirects without tokens", () => {
  const handoff = buildLocalPostLoginHandoffUrl(
    "http://localhost:5173/auth/callback",
    "https://www.cojournalist.ai/auth/callback",
  );
  if (handoff !== undefined) {
    throw new Error(`expected missing-hash redirect to be rejected, got ${handoff}`);
  }
});
