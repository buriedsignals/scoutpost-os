import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { persistCivicDocumentItems } from "./civic_document_persistence.ts";
import { upsertCanonicalUnit } from "./unit_dedup.ts";

type Item = { statement: string; context: string; confidence: string };
function fixture() {
  const saved = new Map<string, Record<string, unknown>>();
  const alerts = new Set<string>();
  const attempted: string[] = [];
  const reads: URL[] = [];
  let failB = true;
  let incompleteRead = 0;
  const db = createClient("https://database.test", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (rawUrl, init) => {
        const url = new URL(String(rawUrl));
        if (url.pathname.endsWith("/civic_queue_item_results")) {
          reads.push(url);
          const data = [...saved.keys()].map((hash) => ({
            statement_hash: hash,
            created_canonical: true,
            merged_existing: false,
            occurrence_created: true,
          }));
          const count = data.length + (incompleteRead === reads.length ? 1 : 0);
          return Promise.resolve(
            Response.json(data, {
              headers: {
                "content-range": `0-${Math.max(0, data.length - 1)}/${count}`,
              },
            }),
          );
        }
        assertEquals(url.pathname, "/rest/v1/rpc/persist_civic_item");
        const body = JSON.parse(String((init as { body?: unknown })?.body));
        assertEquals(body.p_queue_id, "queue");
        const item = body.p_input as Record<string, unknown>;
        attempted.push(String(item.p_statement));
        if (item.p_statement === "B" && failB) {
          failB = false;
          return Promise.resolve(
            Response.json({ message: "injected B failure" }, { status: 400 }),
          );
        }
        const key = String(item.p_statement_hash);
        if (saved.has(key)) {
          return Promise.resolve(
            Response.json(
              { message: "Civic retry changed the accepted item" },
              { status: 400 },
            ),
          );
        }
        saved.set(key, item);
        alerts.add(key);
        return Promise.resolve(
          Response.json([{
            unit_id: key,
            created_canonical: true,
            merged_existing: false,
            occurrence_created: true,
            match_scope: "new",
          }]),
        );
      },
    },
  });
  const embedded: string[] = [];
  const persist = (items: Item[], contentHash: string) =>
    persistCivicDocumentItems(db, {
      queueId: "queue",
      userId: "owner",
      items,
      persistItem: async (item) => {
        // Same worker ordering: skip must happen before embedding and persistence.
        embedded.push(item.statement);
        return await upsertCanonicalUnit(db, {
          userId: "owner",
          scoutId: "scout",
          scoutType: "civic",
          scoutRunId: "run",
          statement: item.statement,
          contextExcerpt: item.context,
          contentSha256: contentHash,
          unitType: "promise",
          sourceType: "civic_promise",
          metadata: { date_confidence: item.confidence },
        }, { queueId: "queue", workerId: "worker" });
      },
    });
  return {
    saved,
    alerts,
    attempted,
    embedded,
    reads,
    persist,
    setIncompleteRead: (read: number) => {
      incompleteRead = read;
    },
  };
}

Deno.test("document retry retains accepted A evidence, skips changed A, stores B and counts both", async () => {
  const f = fixture();
  const a = {
    statement: "A",
    context: "First source excerpt",
    confidence: "high",
  };
  const b = {
    statement: "B",
    context: "Second source excerpt",
    confidence: "high",
  };
  await assertRejects(
    () => f.persist([a, b], "content-v1"),
    Error,
    "injected B failure",
  );
  assertEquals(f.saved.size, 1);
  const result = await f.persist([
    {
      ...a,
      statement: "  a  ",
      context: "Changed excerpt",
      confidence: "medium",
    },
    b,
    b,
  ], "content-v2");
  assertEquals(result, { inserted: 2, mergedExisting: 0 });
  assertEquals(f.attempted, ["A", "B", "B"]);
  assertEquals(f.embedded, ["A", "B", "B"]);
  assertEquals(f.alerts.size, 2);
  const first = [...f.saved.values()][0];
  assertEquals(first.p_context_excerpt, "First source excerpt");
  assertEquals(first.p_content_sha256, "content-v1");
  assertEquals(first.p_metadata, { date_confidence: "high" });
  assertEquals(await f.persist([], "content-v3"), result);
  for (const read of f.reads) {
    assertEquals(read.searchParams.get("queue_id"), "eq.queue");
    assertEquals(read.searchParams.get("user_id"), "eq.owner");
  }
});

Deno.test("incomplete preflight ledger fails before embedding or persistence", async () => {
  const f = fixture();
  f.setIncompleteRead(1);
  await assertRejects(
    () =>
      f.persist(
        [{ statement: "A", context: "source", confidence: "high" }],
        "content",
      ),
    Error,
    "inventory is incomplete",
  );
  assertEquals(f.embedded, []);
  assertEquals(f.saved.size, 0);
});

Deno.test("incomplete final ledger fails instead of returning partial document counts", async () => {
  const f = fixture();
  f.setIncompleteRead(2);
  await assertRejects(
    () =>
      f.persist(
        [{ statement: "A", context: "source", confidence: "high" }],
        "content",
      ),
    Error,
    "inventory is incomplete",
  );
  assertEquals(f.saved.size, 1);
});
