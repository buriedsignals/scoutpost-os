import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  deliveryStatusForEvent,
  parseResendEmailEvent,
  sanitizedDeliveryDetails,
  verifyResendWebhookSignature,
} from "./resend_webhook.ts";

const RAW_SECRET = "scoutpost-resend-webhook-test-key";
const SECRET = `whsec_${btoa(RAW_SECRET)}`;
const NOW = 1_774_048_000_000;
const TIMESTAMP = String(Math.floor(NOW / 1000));
const PAYLOAD = JSON.stringify({
  type: "email.bounced",
  created_at: "2026-03-20T20:00:00Z",
  data: {
    email_id: "email-123",
    to: ["recipient@example.test"],
    bounce: {
      message: "mailbox does not exist",
      type: "Permanent",
      subType: "General",
    },
  },
});

async function signature(payload = PAYLOAD): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(RAW_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`msg_test.${TIMESTAMP}.${payload}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(bytes)))}`;
}

Deno.test("Resend webhook verifies the raw signed payload", async () => {
  await verifyResendWebhookSignature(
    PAYLOAD,
    {
      id: "msg_test",
      timestamp: TIMESTAMP,
      signature: await signature(),
    },
    SECRET,
    NOW,
  );
});

Deno.test("Resend webhook rejects modified and stale payloads", async () => {
  const headers = {
    id: "msg_test",
    timestamp: TIMESTAMP,
    signature: await signature(),
  };
  await assertRejects(() =>
    verifyResendWebhookSignature(`${PAYLOAD} `, headers, SECRET, NOW)
  );
  await assertRejects(() =>
    verifyResendWebhookSignature(PAYLOAD, headers, SECRET, NOW + 301_000)
  );
});

Deno.test("Resend webhook maps and sanitizes delivery outcomes", () => {
  const event = parseResendEmailEvent(JSON.parse(PAYLOAD));
  assertEquals(deliveryStatusForEvent(event.type), "bounced");
  assertEquals(sanitizedDeliveryDetails(event), {
    recipientCount: 1,
    reason: "mailbox does not exist",
    details: {
      bounce_type: "Permanent",
      bounce_subtype: "General",
    },
  });
  assertEquals(deliveryStatusForEvent("email.opened"), null);
});
