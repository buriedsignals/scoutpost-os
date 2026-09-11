import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { upsertCanonicalUnit } from "./unit_dedup.ts";

Deno.test("Civic persistence sends the normalized canonical payload in one leased RPC", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const db = createClient("https://database.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String((init as { body?: unknown })?.body)),
        });
        return Promise.resolve(
          new Response(
            JSON.stringify([{
              unit_id: "unit",
              created_canonical: true,
              merged_existing: false,
              match_scope: "new",
              occurrence_created: true,
            }]),
            { headers: { "content-type": "application/json" } },
          ),
        );
      },
    },
  });
  const result = await upsertCanonicalUnit(db, {
    userId: "owner",
    scoutId: "scout",
    scoutRunId: "run",
    scoutType: "civic",
    statement: "  Council will finish the bridge.  ",
    unitType: "promise",
    sourceType: "civic_promise",
    sourceUrl: "https://council.test/minutes.pdf?utm_source=test",
    metadata: {
      due_date: "2030-06-01",
      due_date_text: "by June 2030",
      date_confidence: "high",
    },
  }, { queueId: "queue", workerId: "lease-owner" });
  assertEquals(requests.length, 1);
  assertEquals(
    requests[0].url,
    "https://database.test/rest/v1/rpc/persist_civic_item",
  );
  assertEquals(requests[0].body.p_queue_id, "queue");
  assertEquals(requests[0].body.p_worker_id, "lease-owner");
  const payload = requests[0].body.p_input as Record<string, unknown>;
  assertEquals(payload.p_statement, "Council will finish the bridge.");
  assertEquals(
    payload.p_normalized_source_url,
    "https://council.test/minutes.pdf",
  );
  assertEquals(payload.p_statement_hash, result.statementHash);
  assertEquals(result.createdCanonical, true);
});

Deno.test("Civic persistence propagates transaction failure without a separate tracker write", async () => {
  let calls = 0;
  const db = createClient("https://database.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: () => {
        calls++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              message: "injected revision failure",
              code: "P0001",
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      },
    },
  });
  await assertRejects(
    () =>
      upsertCanonicalUnit(db, {
        userId: "owner",
        statement: "Council adopted the budget.",
        unitType: "fact",
        sourceType: "scout",
      }, { queueId: "queue", workerId: "worker" }),
    Error,
    "injected revision failure",
  );
  assertEquals(calls, 1);
});
