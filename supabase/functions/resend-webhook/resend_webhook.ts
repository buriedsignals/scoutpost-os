export interface ResendWebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export interface ResendEmailEvent {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    to?: unknown;
    bounce?: unknown;
    suppressed?: unknown;
    failed?: unknown;
    [key: string]: unknown;
  };
}

const EVENT_STATUS: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.suppressed": "suppressed",
  "email.complained": "complained",
  "email.failed": "failed",
};

export function deliveryStatusForEvent(type: string): string | null {
  return EVENT_STATUS[type] ?? null;
}

export function parseResendEmailEvent(value: unknown): ResendEmailEvent {
  if (!value || typeof value !== "object") {
    throw new Error("invalid webhook payload");
  }
  const event = value as Record<string, unknown>;
  const data = event.data;
  if (
    typeof event.type !== "string" || !event.type.startsWith("email.") ||
    typeof event.created_at !== "string" ||
    !Number.isFinite(Date.parse(event.created_at)) ||
    !data || typeof data !== "object" ||
    typeof (data as Record<string, unknown>).email_id !== "string"
  ) {
    throw new Error("invalid email event payload");
  }
  return event as unknown as ResendEmailEvent;
}

export function sanitizedDeliveryDetails(event: ResendEmailEvent): {
  recipientCount: number;
  reason: string | null;
  details: Record<string, unknown>;
} {
  const recipients = Array.isArray(event.data.to) ? event.data.to.length : 0;
  const bounce = record(event.data.bounce);
  const suppressed = record(event.data.suppressed);
  const failed = record(event.data.failed);
  const reason = firstString(
    bounce?.message,
    suppressed?.message,
    failed?.message,
    failed?.reason,
  );
  return {
    recipientCount: recipients,
    reason,
    details: compact({
      bounce_type: firstString(bounce?.type),
      bounce_subtype: firstString(bounce?.subType, bounce?.subtype),
      suppression_type: firstString(suppressed?.type),
      failure_code: firstString(failed?.code),
    }),
  };
}

export async function verifyResendWebhookSignature(
  payload: string,
  headers: ResendWebhookHeaders,
  secret: string,
  nowMs = Date.now(),
  toleranceSeconds = 300,
): Promise<void> {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    throw new Error("missing webhook signature headers");
  }
  const timestamp = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(timestamp)) throw new Error("invalid webhook timestamp");
  const delta = Math.abs(Math.floor(nowMs / 1000) - timestamp);
  if (delta > toleranceSeconds) {
    throw new Error("webhook timestamp outside tolerance");
  }

  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = decodeBase64(encodedSecret);
  } catch {
    throw new Error("invalid webhook signing secret");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(
    `${headers.id}.${headers.timestamp}.${payload}`,
  );
  const signatures = headers.signature.split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));
  for (const candidate of signatures) {
    try {
      if (
        await crypto.subtle.verify(
          "HMAC",
          key,
          decodeBase64(candidate),
          signed,
        )
      ) return;
    } catch {
      // Try the next v1 signature during signing-secret rotation.
    }
  }
  throw new Error("invalid webhook signature");
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 1000);
    }
  }
  return null;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null),
  );
}
