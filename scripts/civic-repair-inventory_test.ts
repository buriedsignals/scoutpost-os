import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { collectInventory, parseUserId } from "./civic-repair-inventory.ts";

const USER = "11111111-1111-4111-8111-111111111111";
type Row = Record<string, unknown>;
function database(
  tables: Record<string, Row[]>,
  failTable?: string,
  fault?: "truncate" | "count-change",
) {
  const requests: URL[] = [];
  const client = createClient("https://inventory.invalid", "test-service-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        assertEquals((init as RequestInit)?.method, "GET");
        assertEquals(url.searchParams.get("user_id"), `eq.${USER}`);
        assertEquals(url.searchParams.get("order"), "id.asc");
        const table = url.pathname.split("/").at(-1)!;
        if (table === "scouts") {
          assertEquals(url.searchParams.get("select"), "id,type");
        }
        if (table === failTable) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: "query failed" }), {
              status: 400,
            }),
          );
        }
        const rows = (tables[table] ?? []).filter((row) => row.user_id === USER)
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const offset = Number(url.searchParams.get("offset"));
        // Simulate a server cap smaller than the requested page size.
        const limit = Math.min(100, Number(url.searchParams.get("limit")));
        const page = fault === "truncate" && offset > 0
          ? []
          : rows.slice(offset, offset + limit);
        const count = rows.length +
          (fault === "count-change" && offset > 0 ? 1 : 0);
        return Promise.resolve(
          new Response(JSON.stringify(page), {
            headers: {
              "content-type": "application/json",
              "content-range": `${offset}-${offset + page.length - 1}/${count}`,
            },
          }),
        );
      },
    },
  });
  return { client, requests };
}
const promise = (id: string, extra: Row = {}): Row => ({
  id,
  user_id: USER,
  scout_id: null,
  unit_id: null,
  due_date: null,
  meeting_date: null,
  date_confidence: null,
  status: "new",
  due_notified_at: null,
  source_url: "https://example.org/meeting",
  source_title: "Private title",
  ...extra,
});
const unit = (id: string, extra: Row = {}): Row => ({
  id,
  user_id: USER,
  scout_type: "civic",
  type: "promise",
  deleted_at: null,
  ...extra,
});

Deno.test("inventory includes null-scout promises even without surviving Civic scouts", async () => {
  const { client } = database({
    promises: [promise("orphan"), promise("foreign", { user_id: "other" })],
  });
  const report = await collectInventory(client, USER);
  assertEquals(report.promises_null_scout_and_unit.ids, ["orphan"]);
  assertEquals(report.promises_null_due_date.count, 1);
  assertEquals(report.civic_scouts, 0);
  assertEquals(JSON.stringify(report).includes("Private title"), false);
  assertEquals(JSON.stringify(report).includes("https://example.org"), false);
});

Deno.test("inventory joins complete account rows beyond both display and server caps", async () => {
  const promises = Array.from(
    { length: 502 },
    (_, i) =>
      promise(`p${String(i).padStart(4, "0")}`, {
        unit_id: `u${String(501 - i).padStart(4, "0")}`,
      }),
  );
  const units = Array.from(
    { length: 502 },
    (_, i) => unit(`u${String(i).padStart(4, "0")}`),
  );
  const { client, requests } = database({ promises, information_units: units });
  const report = await collectInventory(client, USER);
  assertEquals(report.civic_promise_units_without_tracker.count, 0);
  assertEquals(report.promise_trackers_without_owned_unit.count, 0);
  assertEquals(report.promises_null_due_date.count, 502);
  assertEquals(report.promises_null_due_date.ids.length, 500);
  assertEquals(report.promises_null_due_date.ids_truncated, true);
  assertEquals(
    requests.some((url) => url.searchParams.get("offset") === "500"),
    true,
  );
});

Deno.test("inventory separates deleted and non-Civic links from unproven missing owned units", async () => {
  const { client } = database({
    promises: [
      promise("deleted", { unit_id: "u1" }),
      promise("beat", { unit_id: "u2" }),
      promise("absent", { unit_id: "u3" }),
      promise("foreign", { unit_id: "u4" }),
    ],
    information_units: [
      unit("u1", { deleted_at: "2026-01-01" }),
      unit("u2", { scout_type: "beat" }),
      unit("u4", { user_id: "other" }),
    ],
  });
  const report = await collectInventory(client, USER);
  assertEquals(report.promise_trackers_linked_to_deleted_unit.ids, ["deleted"]);
  assertEquals(report.promise_trackers_linked_to_non_civic_promise_unit.ids, [
    "beat",
  ]);
  assertEquals(report.promise_trackers_without_owned_unit.ids, [
    "absent",
    "foreign",
  ]);
  assertEquals(report.civic_promise_units_without_tracker.count, 0);
});

Deno.test("inventory aborts on failed reads instead of claiming empty cohorts", async () => {
  const { client } = database({}, "promises");
  await assertRejects(
    () => collectInventory(client, USER),
    Error,
    "promises: query failed",
  );
});

Deno.test("inventory requires one explicit account UUID before any database read", () => {
  assertEquals(parseUserId(["--user-id", USER]), USER);
  assertThrows(() => parseUserId([]), Error, "--user-id");
  assertThrows(() => parseUserId(["--user-id", "not-a-uuid"]));
  assertThrows(() => parseUserId(["--user-id", USER, "--apply"]));
});

Deno.test("inventory refuses truncated pages or changing account counts", async () => {
  const promises = Array.from(
    { length: 101 },
    (_, i) => promise(`p${String(i).padStart(4, "0")}`),
  );
  const truncated = database({ promises }, undefined, "truncate");
  await assertRejects(
    () => collectInventory(truncated.client, USER),
    Error,
    "incomplete results",
  );
  const changed = database({ promises }, undefined, "count-change");
  await assertRejects(
    () => collectInventory(changed.client, USER),
    Error,
    "account changed during inventory",
  );
});

Deno.test("inventory counts Civic scouts using the deployed type column", async () => {
  const { client } = database({
    scouts: [
      { id: "civic", user_id: USER, type: "civic" },
      { id: "beat", user_id: USER, type: "beat" },
    ],
  });
  assertEquals((await collectInventory(client, USER)).civic_scouts, 1);
});
