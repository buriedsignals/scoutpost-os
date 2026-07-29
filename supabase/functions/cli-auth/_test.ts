import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  allowedApprovalOrigin,
  normalizeUserCode,
  randomUserCode,
  sanitizeLabel,
  sha256Hex,
} from "./lib.ts";
import { handleCliAuthRequest } from "./index.ts";

Deno.test("labels are printable, normalized, and bounded", () => {
  assertEquals(sanitizeLabel("  Claude\n\tCode  ", 80), "Claude Code");
  assertEquals(sanitizeLabel("", 80), null);
  assertEquals(sanitizeLabel("x".repeat(100), 8), "xxxxxxxx");
});

Deno.test("user codes normalize without ambiguous characters", () => {
  assertEquals(normalizeUserCode("abcd-2345"), "ABCD-2345");
  assertEquals(normalizeUserCode("ABCD2345"), "ABCD-2345");
  assertEquals(normalizeUserCode("ABCI-2345"), null);
  assertMatch(randomUserCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

Deno.test("hashes do not retain the secret", async () => {
  const secret = "cj_SUPERSECRET";
  const hash = await sha256Hex(secret);
  assertEquals(hash.length, 64);
  assertEquals(hash.includes(secret), false);
});

Deno.test("approval origin must exactly match the request site", () => {
  const allowed = new Request("https://api.example/cli-auth", {
    headers: { Origin: "https://newsroom.example" },
  });
  const denied = new Request("https://api.example/cli-auth", {
    headers: { Origin: "https://evil.example" },
  });
  assertEquals(
    allowedApprovalOrigin(allowed, "https://newsroom.example"),
    true,
  );
  assertEquals(
    allowedApprovalOrigin(denied, "https://newsroom.example"),
    false,
  );
});

Deno.test("chunked request bodies are rejected before exceeding the byte cap", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8_192));
      controller.enqueue(new Uint8Array(8_193));
      controller.close();
    },
  });
  const request = new Request(
    "http://127.0.0.1/functions/v1/cli-auth/v1/device/authorize",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
  );

  const response = await handleCliAuthRequest(request, { svc: {} as never });

  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "validation_error");
});
