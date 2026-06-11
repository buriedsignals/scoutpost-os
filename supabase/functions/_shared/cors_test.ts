import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeCorsHeaders } from "./cors.ts";

Deno.test("makeCorsHeaders reflects an allowlisted origin with credentials", () => {
  const h = makeCorsHeaders("https://www.scoutpost.ai");
  assertEquals(h["Access-Control-Allow-Origin"], "https://www.scoutpost.ai");
  assertEquals(h["Access-Control-Allow-Credentials"], "true");
});

Deno.test("makeCorsHeaders does not reflect an unknown origin or allow credentials", () => {
  const h = makeCorsHeaders("https://evil.example.com");
  assertEquals(h["Access-Control-Allow-Origin"], "https://www.scoutpost.ai");
  assertEquals(h["Access-Control-Allow-Credentials"], undefined);
});

Deno.test("makeCorsHeaders falls back to canonical origin for a null origin", () => {
  const h = makeCorsHeaders(null);
  assertEquals(h["Access-Control-Allow-Origin"], "https://www.scoutpost.ai");
  assertEquals(h["Access-Control-Allow-Credentials"], undefined);
});

Deno.test("makeCorsHeaders honors ALLOWED_CORS_ORIGINS for self-host", () => {
  Deno.env.set("ALLOWED_CORS_ORIGINS", "https://news.example.org");
  try {
    const h = makeCorsHeaders("https://news.example.org");
    assertEquals(h["Access-Control-Allow-Origin"], "https://news.example.org");
    assertEquals(h["Access-Control-Allow-Credentials"], "true");
  } finally {
    Deno.env.delete("ALLOWED_CORS_ORIGINS");
  }
});
