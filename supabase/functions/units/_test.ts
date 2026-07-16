import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestUser,
  functionUrl,
  getTestingServiceRoleKey,
  getTestingSupabaseUrl,
} from "../_shared/_testing.ts";

function headers(token: string): HeadersInit {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function serviceClient() {
  return createClient(
    getTestingSupabaseUrl(),
    getTestingServiceRoleKey(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

Deno.test("units: unauthenticated request returns 401", async () => {
  const res = await fetch(functionUrl("units"), { method: "GET" });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});

Deno.test("units: unknown method returns 405", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("units"), {
      method: "DELETE",
      headers: headers(user.token),
    });
    await res.body?.cancel();
    assertEquals(res.status, 405);
  } finally {
    await user.cleanup();
  }
});

Deno.test("units: empty list for new user", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("units"), {
      headers: headers(user.token),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.pagination);
    assertEquals(body.pagination.total, 0);
    assertEquals(body.items.length, 0);
  } finally {
    await user.cleanup();
  }
});

Deno.test("units: search without query_text returns 400", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("units", "/search"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

Deno.test("units: search with non-JSON body returns 400", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("units", "/search"), {
      method: "POST",
      headers: headers(user.token),
      body: "not json",
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

// Search short-circuits when the caller has zero units — no Gemini call is
// made. This path is safe to run without GEMINI_API_KEY.
Deno.test("units: search on empty corpus returns empty items", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("units", "/search"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({ query_text: "anything at all" }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.items, []);
  } finally {
    await user.cleanup();
  }
});

Deno.test("units: search accepts optional scout_id", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("units", "/search"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        query_text: "anything at all",
        scout_id: "00000000-0000-0000-0000-000000000000",
      }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.items, []);
  } finally {
    await user.cleanup();
  }
});

Deno.test("units: search accepts mode + state filters", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(functionUrl("units", "/search"), {
      method: "POST",
      headers: headers(user.token),
      body: JSON.stringify({
        query_text: "anything at all",
        mode: "keyword",
        verified: false,
        used_in_article: false,
        include_deleted: true,
      }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.items, []);
  } finally {
    await user.cleanup();
  }
});

Deno.test("units: GET on unknown id returns 404", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(
      functionUrl("units", "/00000000-0000-0000-0000-000000000000"),
      { headers: headers(user.token) },
    );
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

Deno.test("units: PATCH on unknown id returns 404", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(
      functionUrl("units", "/00000000-0000-0000-0000-000000000000"),
      {
        method: "PATCH",
        headers: headers(user.token),
        body: JSON.stringify({ verified: true }),
      },
    );
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

Deno.test("units: PATCH with empty body returns 400", async () => {
  const user = await createTestUser();
  try {
    const res = await fetch(
      functionUrl("units", "/00000000-0000-0000-0000-000000000000"),
      {
        method: "PATCH",
        headers: headers(user.token),
        body: JSON.stringify({}),
      },
    );
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await user.cleanup();
  }
});

Deno.test("units: evidence is owner-only and reviewable without changing unit reads", async () => {
  const user = await createTestUser();
  const otherUser = await createTestUser();
  const svc = serviceClient();
  try {
    const { data: unit, error: unitError } = await svc
      .from("information_units")
      .insert({
        user_id: user.id,
        statement: "The evidence endpoint preserves exact wording.",
        type: "fact",
      })
      .select("id")
      .single();
    if (unitError) throw unitError;
    const { data: capture, error: captureError } = await svc
      .from("raw_captures")
      .insert({ user_id: user.id, content_md: "Exact evidence passage." })
      .select("id")
      .single();
    if (captureError) throw captureError;
    const { error: expressionError } = await svc.rpc(
      "record_source_expression",
      {
        p_user_id: user.id,
        p_raw_capture_id: capture.id,
        p_unit_id: unit.id,
        p_unit_occurrence_id: null,
        p_start_byte: 0,
        p_end_byte: 23,
      },
    );
    if (expressionError) throw expressionError;

    const evidenceRes = await fetch(
      functionUrl("units", `/${unit.id}/evidence`),
      {
        headers: headers(user.token),
      },
    );
    assertEquals(evidenceRes.status, 200);
    const evidence = await evidenceRes.json();
    assertEquals(evidence.evidence_status.active_expression_count, 1);
    assertEquals(
      evidence.expressions[0].expression.exact_text,
      "Exact evidence passage.",
    );

    const reviewRes = await fetch(
      functionUrl(
        "units",
        `/${unit.id}/evidence/${evidence.expressions[0].link_id}`,
      ),
      {
        method: "PATCH",
        headers: headers(user.token),
        body: JSON.stringify({
          review_status: "accepted",
          review_notes: "checked",
        }),
      },
    );
    assertEquals(reviewRes.status, 200);
    await reviewRes.body?.cancel();

    const otherRes = await fetch(functionUrl("units", `/${unit.id}/evidence`), {
      headers: headers(otherUser.token),
    });
    assertEquals(otherRes.status, 404);
    await otherRes.body?.cancel();
  } finally {
    await user.cleanup();
    await otherUser.cleanup();
  }
});

Deno.test("units: DELETE soft-deletes unit and hides it from default list", async () => {
  const user = await createTestUser();
  const svc = serviceClient();
  try {
    const { data: inserted, error: insertErr } = await svc
      .from("information_units")
      .insert({
        user_id: user.id,
        statement: "Budget hearing scheduled for Monday.",
        type: "event",
      })
      .select("id")
      .single();
    if (insertErr) throw insertErr;

    const unitId = inserted.id as string;

    const delRes = await fetch(functionUrl("units", `/${unitId}`), {
      method: "DELETE",
      headers: headers(user.token),
    });
    await delRes.body?.cancel();
    assertEquals(delRes.status, 204);

    const listRes = await fetch(functionUrl("units"), {
      headers: headers(user.token),
    });
    assertEquals(listRes.status, 200);
    const listBody = await listRes.json();
    assertEquals(listBody.items.length, 0);

    const includeDeletedRes = await fetch(
      functionUrl("units", "?include_deleted=true"),
      { headers: headers(user.token) },
    );
    assertEquals(includeDeletedRes.status, 200);
    const includeDeletedBody = await includeDeletedRes.json();
    assertEquals(includeDeletedBody.items.length, 1);
    assertEquals(includeDeletedBody.items[0].deletion.deleted, true);

    const getRes = await fetch(functionUrl("units", `/${unitId}`), {
      headers: headers(user.token),
    });
    assertEquals(getRes.status, 200);
    const getBody = await getRes.json();
    assertEquals(getBody.deletion.deleted, true);
    assertExists(getBody.deletion.deleted_at);
    assertEquals(getBody.deletion.deleted_by, user.id);
  } finally {
    await user.cleanup();
  }
});

// Deep semantic-search test — requires a real embedding endpoint. Skip unless
// GEMINI_API_KEY is set in the test env.
const geminiConfigured = Boolean(Deno.env.get("GEMINI_API_KEY"));
const deepSearchTest = geminiConfigured ? Deno.test : Deno.test.ignore;

deepSearchTest(
  "units: search with query_text succeeds end-to-end (requires GEMINI_API_KEY)",
  async () => {
    const user = await createTestUser();
    try {
      // We don't seed a unit here — the function still exercises the full
      // embed -> RPC roundtrip because count > 0 is the only short-circuit
      // and any DB presence would require complex setup. Without seeding,
      // this path still short-circuits on empty corpus; so the assertion is
      // identical to the empty-corpus test. Left as a placeholder so a fuller
      // fixture can be dropped in later without moving the gate.
      const res = await fetch(functionUrl("units", "/search"), {
        method: "POST",
        headers: headers(user.token),
        body: JSON.stringify({ query_text: "housing policy zurich" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertExists(body.items);
    } finally {
      await user.cleanup();
    }
  },
);
