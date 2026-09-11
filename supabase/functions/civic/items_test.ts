import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Exercise the actual HTTP handler and Supabase query builder without a server.
let handle: (req: Request) => Promise<Response>;
const serve = Deno.serve;
Deno.serve = ((handler: typeof handle) => {
  handle = handler;
  return {};
}) as typeof Deno.serve;
try {
  await import("./index.ts");
} finally {
  Deno.serve = serve;
}

const owner = "00000000-0000-4000-8000-000000000001";
const active = "00000000-0000-4000-8000-000000000002";
const deleted = "00000000-0000-4000-8000-000000000003";
const foreign = "00000000-0000-4000-8000-000000000004";
const promoted = "00000000-0000-4000-8000-000000000005";
const civicScout = "00000000-0000-4000-8000-000000000006";
const pageScout = "00000000-0000-4000-8000-000000000007";
const pageOnly = "00000000-0000-4000-8000-000000000008";
const units = [
  { id: active, user_id: owner, deleted_at: null },
  { id: deleted, user_id: owner, deleted_at: "2026-09-01T00:00:00Z" },
  { id: foreign, user_id: "another-user", deleted_at: null },
  { id: promoted, user_id: owner, deleted_at: null },
  { id: pageOnly, user_id: owner, deleted_at: null },
].map((row) => ({
  ...row,
  scout_type: row.id === promoted || row.id === pageOnly ? "web" : "civic",
  scout_id: row.id === promoted || row.id === pageOnly ? pageScout : civicScout,
  type: row.id === promoted ? "promise" : "fact",
  civic_occurrences: row.id === pageOnly ? [] : [{
    user_id: row.user_id,
    scout_id: civicScout,
    scout_type: "civic",
    source_url: "https://council.test/minutes.pdf",
    source_title: row.id === promoted ? null : "Minutes",
    metadata: { civic_policy_version: "civic-v2", actor: "Council" },
  }],
  source_title: "Original Page title",
  source_url: "https://news.test/original",
  statement: "Adopted decision",
  metadata: {},
}));

async function request(path: string): Promise<Response> {
  const names = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SERVICE_SUPABASE_URL",
    "SERVICE_SUPABASE_SERVICE_ROLE_KEY",
  ];
  const previous = names.map((name) => Deno.env.get(name));
  names.forEach((name) => Deno.env.delete(name));
  Deno.env.set("SUPABASE_URL", "https://fixture.invalid");
  Deno.env.set("SUPABASE_ANON_KEY", "fixture-anon");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fixture-service");
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    let body: unknown;
    if (url.pathname === "/rest/v1/rpc/validate_api_key_identity") {
      body = [{ user_id: owner, key_id: "fixture-key" }];
    } else if (url.pathname === "/rest/v1/information_units") {
      assertEquals(
        url.searchParams.get("select")?.includes("unit_occurrences!inner"),
        true,
      );
      body = units.filter((unit) => {
        const types = url.searchParams.get("type");
        if (types && !types.slice(4, -1).split(",").includes(unit.type)) {
          return false;
        }
        if (
          !unit.civic_occurrences.some((occurrence) =>
            ["user_id", "scout_type", "scout_id"].every((field) => {
              const condition = url.searchParams.get(
                `civic_occurrences.${field}`,
              );
              return !condition ||
                condition ===
                  `eq.${occurrence[field as keyof typeof occurrence]}`;
            })
          )
        ) return false;
        for (
          const field of ["user_id", "id", "scout_type", "deleted_at"] as const
        ) {
          const condition = url.searchParams.get(field);
          if (condition === "is.null" && unit[field] !== null) return false;
          if (
            condition?.startsWith("eq.") && unit[field] !== condition.slice(3)
          ) return false;
        }
        return true;
      });
    } else if (url.pathname === "/rest/v1/promises") {
      body = [{
        id: "tracker",
        user_id: owner,
        unit_id: promoted,
        source_url: "https://council.test/earlier.pdf",
        status: "fulfilled",
        due_date: "2030-06-01",
        active_revision_id: "revision",
        context: "Council agreed to build the bridge.",
      }];
    } else {
      throw new Error(`Unexpected network call: ${url.pathname}`);
    }
    return Promise.resolve(Response.json(body));
  };
  try {
    return await handle(
      new Request(`https://fixture.invalid/civic${path}`, {
        headers: { Authorization: "Bearer cj_fixture" },
      }),
    );
  } finally {
    globalThis.fetch = fetchOriginal;
    names.forEach((name, i) =>
      previous[i] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, previous[i]!)
    );
  }
}

Deno.test("Civic list hides deleted and other-owner decisions", async () => {
  const response = await request("/items?kind=decision");
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.items.map((item: { unit_id: string }) => item.unit_id), [
    active,
  ]);
});

Deno.test("Civic detail hides deleted and other-owner items", async () => {
  for (const id of [deleted, foreign]) {
    const response = await request(`/items/${id}`);
    assertEquals(response.status, 404);
    await response.body?.cancel();
  }
  const response = await request(`/items/${active}`);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).item.unit_id, active);
});

Deno.test("Civic list and detail expose a promoted Page finding through Civic provenance", async () => {
  const response = await request(`/items?kind=promise&scout_id=${civicScout}`);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.items.length, 1);
  assertEquals(body.items[0].unit_id, promoted);
  assertEquals(body.items[0].scout_id, civicScout);
  assertEquals(body.items[0].source_url, "https://council.test/minutes.pdf");
  assertEquals(body.items[0].actor, "Council");
  assertEquals(body.items[0].status, "fulfilled");
  // The tracker retains an earlier source; do not attach its quote/date wording
  // to this later occurrence's citation.
  assertEquals(body.items[0].context, null);
  assertEquals(body.items[0].source_title, null);
  assertEquals(body.items[0].due_date_text, null);
  const detail = await request(`/items/${promoted}`);
  assertEquals(detail.status, 200);
  assertEquals((await detail.json()).item.unit_id, promoted);
  const wrongScout = await request(`/items?kind=promise&scout_id=${pageScout}`);
  assertEquals((await wrongScout.json()).items, []);
  assertEquals((await request(`/items/${pageOnly}`)).status, 404);
});
