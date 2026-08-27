#!/usr/bin/env -S deno run --allow-env --allow-net

const USAGE = `Usage:
  abuse-review.ts run
  abuse-review.ts list [open|confirmed|dismissed|deferred]
  abuse-review.ts show <finding-id>
  abuse-review.ts confirm <finding-id> [note]
  abuse-review.ts dismiss <finding-id> [note]
  abuse-review.ts defer <finding-id> [note]
  abuse-review.ts export <finding-id>

Requires SUPABASE_URL and INTERNAL_SERVICE_KEY.`;

const [command, first, ...rest] = Deno.args;
if (!command || command === "help" || command === "--help") {
  console.log(USAGE);
  Deno.exit(command ? 0 : 2);
}

const baseUrl = Deno.env.get("SUPABASE_URL")?.trim().replace(/\/+$/, "");
const serviceKey = Deno.env.get("INTERNAL_SERVICE_KEY")?.trim();
if (!baseUrl || !serviceKey) {
  console.error("SUPABASE_URL and INTERNAL_SERVICE_KEY are required");
  Deno.exit(2);
}

const findingId = (value: string | undefined): string => {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    console.error("A valid finding ID is required");
    Deno.exit(2);
  }
  return normalized;
};

const request = async (body: Record<string, unknown>): Promise<unknown> => {
  const response = await fetch(`${baseUrl}/functions/v1/abuse-risk-audit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Service-Key": serviceKey,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.error === "string"
      ? payload.error
      : JSON.stringify(payload);
    throw new Error(`abuse review request failed (${response.status}): ${detail}`);
  }
  return payload;
};

let body: Record<string, unknown>;
if (command === "run") {
  body = { action: "run" };
} else if (command === "list") {
  const disposition = first ?? "open";
  if (!["open", "confirmed", "dismissed", "deferred"].includes(disposition)) {
    console.error("Invalid list disposition");
    Deno.exit(2);
  }
  body = { action: "list", disposition };
} else if (command === "show" || command === "export") {
  body = { action: command, finding_id: findingId(first) };
} else if (["confirm", "dismiss", "defer"].includes(command)) {
  const disposition = command === "confirm" ? "confirmed" :
    command === "dismiss" ? "dismissed" : "deferred";
  body = {
    action: "disposition",
    finding_id: findingId(first),
    disposition,
    note: rest.join(" ").trim() || undefined,
  };
} else {
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  Deno.exit(2);
}

try {
  console.log(JSON.stringify(await request(body), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}
