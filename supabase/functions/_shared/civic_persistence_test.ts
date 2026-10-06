import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
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
  // SHA-256 of "council will finish the bridge." — the cross-run dedup key.
  assertEquals(
    payload.p_statement_hash,
    "05459663f1aa93d847b92d71be3a5d0604960450fd46d35140b8733fb92836af",
  );
  assertEquals(result.createdCanonical, true);
});
