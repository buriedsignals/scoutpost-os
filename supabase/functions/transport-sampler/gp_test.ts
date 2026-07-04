import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { refreshGpCache } from "./gp.ts";
import type { SupabaseClient } from "../_shared/supabase.ts";

// Minimal fake Supabase client + fetch stub to exercise refreshGpCache's
// control flow (304 / 403 / update) without a live CelesTrak call or DB.

function fakeSvc(
  lastFetched: string | null,
  upserts: unknown[][],
): SupabaseClient {
  return {
    from(_table: string) {
      return {
        select() {
          return {
            order() {
              return {
                limit() {
                  return {
                    maybeSingle() {
                      return Promise.resolve({
                        data: lastFetched ? { fetched_at: lastFetched } : null,
                        error: null,
                      });
                    },
                  };
                },
              };
            },
          };
        },
        upsert(rows: unknown[]) {
          upserts.push(rows);
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient;
}

function stubFetch(response: Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(response);
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("refreshGpCache treats 304 Not Modified as keep-cache", async () => {
  const restore = stubFetch(new Response(null, { status: 304 }));
  try {
    const result = await refreshGpCache(fakeSvc("2024-01-01T00:00:00Z", []));
    assertEquals(result.status, "not_modified");
    assertEquals(result.cached, 0);
  } finally {
    restore();
  }
});

Deno.test("refreshGpCache treats 403 (one-download policy) as blocked, not fatal", async () => {
  const restore = stubFetch(new Response("blocked", { status: 403 }));
  try {
    const result = await refreshGpCache(fakeSvc(null, []));
    assertEquals(result.status, "blocked");
  } finally {
    restore();
  }
});

Deno.test("refreshGpCache upserts valid OMM records, skipping malformed ids", async () => {
  const body = JSON.stringify([
    { NORAD_CAT_ID: 25544, OBJECT_NAME: "ISS", EPOCH: "2024-01-01T00:00:00" },
    { NORAD_CAT_ID: "not-a-number", OBJECT_NAME: "junk" },
    { NORAD_CAT_ID: 39084, OBJECT_NAME: "LANDSAT 8" },
  ]);
  const restore = stubFetch(
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const upserts: unknown[][] = [];
  try {
    const result = await refreshGpCache(fakeSvc(null, upserts));
    assertEquals(result.status, "updated");
    assertEquals(result.cached, 2); // the junk id is dropped
    assertEquals(upserts.length, 1);
    assertEquals(
      (upserts[0] as { norad_id: number }[]).map((r) => r.norad_id),
      [
        25544,
        39084,
      ],
    );
  } finally {
    restore();
  }
});
