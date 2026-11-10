import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createScoutDispatchHandler } from "../scout-dispatch-drain/handler.ts";

Deno.test("scout-dispatch-drain sends a claimed social run to social-execute and parks its 202", async () => {
  const names = ["INTERNAL_SERVICE_KEY", "SUPABASE_URL"];
  const prior = names.map((n) => Deno.env.get(n));
  Deno.env.set("INTERNAL_SERVICE_KEY", "test-internal-key");
  Deno.env.set("SUPABASE_URL", "http://stack.test");
  const claim = {
    queue_id: crypto.randomUUID(),
    run_id: crypto.randomUUID(),
    scout_id: crypto.randomUUID(),
    user_id: crypto.randomUUID(),
    scout_type: "social",
    source: "scheduled",
    attempt: 1,
  };
  const rpcCalls: string[] = [];
  let claimed = false;
  const svc = {
    rpc(name: string) {
      rpcCalls.push(name);
      if (name === "claim_scout_dispatch_batch") {
        const rows = claimed ? [] : [claim];
        claimed = true;
        return Promise.resolve({ data: rows, error: null });
      }
      return Promise.resolve({ data: true, error: null });
    },
  };
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  const pending: Promise<unknown>[] = [];
  try {
    const handler = createScoutDispatchHandler({
      getServiceClient: () => svc as never,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        posted.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(
          Response.json({ status: "accepted" }, { status: 202 }),
        );
      }) as typeof fetch,
      logEvent: () => {},
      waitUntil: (p) => pending.push(p),
    });

    const res = await handler(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "X-Service-Key": "test-internal-key" },
      }),
    );
    await res.body?.cancel();
    await Promise.all(pending);

    assertEquals(posted.map((p) => p.url), [
      "http://stack.test/functions/v1/social-execute",
    ]);
    assertEquals(posted[0].body.run_id, claim.run_id);
    assertEquals(rpcCalls.includes("park_scout_dispatch"), true);
    assertEquals(rpcCalls.includes("finish_scout_dispatch"), false);
  } finally {
    names.forEach((n, i) => {
      if (prior[i] === undefined) Deno.env.delete(n);
      else Deno.env.set(n, prior[i]!);
    });
  }
});
