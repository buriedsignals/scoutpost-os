import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleAbuseRiskAuditRequest } from "./index.ts";
import type { SupabaseClient } from "../_shared/supabase.ts";

const SERVICE_KEY = "abuse-review-test-key";

function request(body: Record<string, unknown>, authenticated = true): Request {
  return new Request("https://example.test/functions/v1/abuse-risk-audit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { "X-Service-Key": SERVICE_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
}

Deno.test("abuse-risk-audit rejects unauthenticated operator requests", async () => {
  const original = Deno.env.get("INTERNAL_SERVICE_KEY");
  Deno.env.set("INTERNAL_SERVICE_KEY", SERVICE_KEY);
  try {
    const response = await handleAbuseRiskAuditRequest(
      request({ action: "list" }, false),
    );
    assertEquals(response.status, 401);
  } finally {
    if (original === undefined) Deno.env.delete("INTERNAL_SERVICE_KEY");
    else Deno.env.set("INTERNAL_SERVICE_KEY", original);
  }
});

Deno.test("ordinary public-profile scouts produce no audit candidate or model call", async () => {
  const original = Deno.env.get("INTERNAL_SERVICE_KEY");
  Deno.env.set("INTERNAL_SERVICE_KEY", SERVICE_KEY);
  let modelCalls = 0;
  const db = {
    from(table: string) {
      if (table !== "scouts") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          const query = {
            order() {
              return query;
            },
            limit() {
              return Promise.resolve({
                data: [{
                  id: "00000000-0000-4000-8000-000000000010",
                  user_id: "00000000-0000-4000-8000-000000000001",
                  name: "Council posts",
                  type: "social",
                  description: "Public-interest reporting",
                  criteria: "Housing votes",
                  topic: "housing",
                  url: null,
                  platform: "instagram",
                  profile_handle: "citycouncil",
                  root_domain: null,
                  tracked_urls: null,
                }],
                error: null,
              });
            },
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseClient;

  try {
    const response = await handleAbuseRiskAuditRequest(
      request({ action: "run" }),
      {
        db,
        assess: () => {
          modelCalls += 1;
          return Promise.resolve([]);
        },
      },
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      scouts: 1,
      candidates: 0,
      findings: 0,
      high_pending: 0,
      model_failures: 0,
      emailed: 0,
    });
    assertEquals(modelCalls, 0);
  } finally {
    if (original === undefined) Deno.env.delete("INTERNAL_SERVICE_KEY");
    else Deno.env.set("INTERNAL_SERVICE_KEY", original);
  }
});
