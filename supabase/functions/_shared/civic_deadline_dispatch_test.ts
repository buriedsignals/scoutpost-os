import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("deadline dispatch preserves each durable key across changed claim batches and reconciles accepted deliveries", async () => {
  const serveBefore = Deno.serve;
  const fetchBefore = globalThis.fetch;
  const settings = {
    SERVICE_SUPABASE_URL: "https://database.example.invalid",
    SERVICE_SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
    INTERNAL_SERVICE_KEY: "offline-service-key",
    RESEND_API_KEY: "offline-resend-key",
  };
  const before = Object.fromEntries(Object.keys(settings).map((key) => [key, Deno.env.get(key)]));
  let handler!: (request: Request) => Promise<Response>;
  const submissions: string[] = [];
  let invocation = 0;
  const userId = "00000000-0000-4000-8000-000000000001";
  const reminder = (id: string, needsSubmission = true) => ({
    delivery_id: `delivery-${id}`, promise_id: id, user_id: userId,
    promise_text: `Publish ${id}`, source_url: "https://example.invalid/source",
    source_title: "Council", due_date: "2030-06-01",
    provider_idempotency_key: `civic/reminder/reader/${id}/2030-06-01`,
    needs_provider_submission: needsSubmission,
  });
  try {
    for (const [key, value] of Object.entries(settings)) Deno.env.set(key, value);
    Deno.serve = ((callback: unknown) => { handler = callback as typeof handler; return {}; }) as typeof Deno.serve;
    // Exercise the deployed module's registration boundary. Static import would
    // start a real server before the Deno.serve interception is installed.
    await import("../promise-digest/index.ts");
    Deno.serve = serveBefore;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "api.resend.com") {
        submissions.push(request.headers.get("Idempotency-Key")!);
        return Response.json({ id: `provider-${submissions.length}` });
      }
      if (url.pathname.includes("/auth/v1/admin/users/")) return Response.json({ id: userId, email: "offline@example.invalid" });
      if (url.pathname.endsWith("/user_preferences")) return Response.json({ preferred_language: "de" });
      if (url.pathname.endsWith("/claim_due_promise_reminders")) {
        invocation++;
        return Response.json(invocation === 1 ? [reminder("audit")] : [reminder("audit"), reminder("bridge"), reminder("accepted", false)]);
      }
      if (url.pathname.endsWith("/mark_due_promise_reminders_provider_accepted")) {
        if (invocation === 1) return Response.json({ message: "simulated acceptance-write outage" }, { status: 503 });
        return Response.json(1);
      }
      if (url.pathname.endsWith("/finalize_due_promise_reminders")) return Response.json(1);
      throw new Error(`Unexpected offline request: ${request.url}`);
    }) as typeof fetch;
    const unauthorized = await handler(new Request("https://edge.example.invalid/promise-digest", {
      method: "POST", body: "{}",
    }));
    assertEquals(unauthorized.status, 401);
    assertEquals(invocation, 0);
    const request = () => new Request("https://edge.example.invalid/promise-digest", {
      method: "POST", headers: { "X-Service-Key": "offline-service-key", "Content-Type": "application/json" }, body: JSON.stringify({ date: "2030-06-01" }),
    });
    assertEquals((await handler(request())).status, 200);
    const response = await handler(request());
    assertEquals(response.status, 200);
    assertEquals(submissions, [
      "civic/reminder/reader/audit/2030-06-01",
      "civic/reminder/reader/audit/2030-06-01",
      "civic/reminder/reader/bridge/2030-06-01",
    ]);
    const result = await response.json();
    assertEquals(result.promises_notified, 3);
    assertEquals(result.users_notified, 1);
  } finally {
    Deno.serve = serveBefore;
    globalThis.fetch = fetchBefore;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
    }
  }
});
