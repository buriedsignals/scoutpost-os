import {
  assert,
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { DATA_EXPORT_LIMIT, DATA_EXPORT_SECTIONS } from "./data_export.ts";

// Request boundary: the deployed `user` entrypoint runs with real supabase-js;
// only HTTP storage is faked, by a small PostgREST that honors the select
// list, `eq`/`gt` filters, `or` logic trees, ordering and a 1,000-row cap.

type Row = Record<string, unknown>;
type Handler = (request: Request) => Promise<Response>;

const callerId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const database = "database.example.invalid";
const MAX_ROWS = 1000;
const OTHER = "OTHER-USER-ROW";
const SENTINEL = "EXCLUDED-FIELD";

/** Owner columns the export must filter on; everything else is `user_id`. */
const OWNER_COLUMN: Record<string, string> = {
  cli_device_authorizations: "approved_by",
};

/** Stored fields that must never leave the database through the export. */
const EXCLUDED_FIELDS: Record<string, string[]> = {
  information_units: ["embedding", "embedding_v2", "fts"],
  entities: ["embedding", "embedding_v2"],
  reflections: ["embedding", "embedding_v2"],
  execution_records: ["embedding", "embedding_v2"],
  api_keys: ["key_hash"],
  mcp_oauth_clients: ["client_secret_hash"],
  cli_device_authorizations: ["device_code_hash", "user_code_hash"],
  raw_captures: ["content_md", "comparison_md", "storage_path"],
  page_snapshots: ["response_headers", "rawhtml_path", "screenshot_path"],
  post_snapshots: ["posts"],
  scout_runs: ["workflow_lease_token"],
};

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function useEnv(settings: Record<string, string>): () => void {
  const before = Object.fromEntries(
    Object.keys(settings).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(settings)) Deno.env.set(key, value);
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  };
}

async function servedHandler(load: () => Promise<unknown>): Promise<Handler> {
  const serve = Deno.serve;
  let handler: Handler | undefined;
  Deno.serve = ((callback: unknown) => {
    handler = callback as Handler;
    return {};
  }) as typeof Deno.serve;
  try {
    await load();
  } finally {
    Deno.serve = serve;
  }
  assert(handler, "entrypoint did not register a handler");
  return handler;
}

/** Splits a PostgREST logic-tree list on top-level commas. */
function splitTerms(list: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < list.length; i++) {
    const char = list[i];
    if (quoted && char === "\\") {
      current += char + list[++i];
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "(") depth++;
    if (!quoted && char === ")") depth--;
    if (!quoted && depth === 0 && char === ",") {
      terms.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  terms.push(current);
  return terms;
}

function compare(row: Row, column: string, op: string, raw: string): boolean {
  const value = raw.startsWith('"')
    ? raw.slice(1, -1).replace(/\\(.)/g, "$1")
    : raw;
  const stored = String(row[column]);
  if (op === "eq") return stored === value;
  if (op === "gt") return stored > value;
  throw new Error(`unsupported operator ${op}`);
}

function matchesTerm(row: Row, term: string): boolean {
  if (term.startsWith("and(")) {
    return splitTerms(term.slice(4, -1)).every((t) => matchesTerm(row, t));
  }
  const [column, op] = term.split(".", 2);
  return compare(row, column, op, term.slice(column.length + op.length + 2));
}

/** Evaluates a PostgREST table read against stored rows. */
function query(rows: Row[], url: URL): Row[] {
  const params = url.searchParams;
  let result = rows.filter((row) =>
    [...params].every(([key, value]) => {
      if (["select", "order", "limit"].includes(key)) return true;
      if (key === "or") {
        return splitTerms(value.slice(1, -1)).some((t) => matchesTerm(row, t));
      }
      const [op] = value.split(".", 1);
      return compare(row, key, op, value.slice(op.length + 1));
    })
  );
  const order = (params.get("order") ?? "").split(",").filter(Boolean)
    .map((part) => part.split(".")[0]);
  result = [...result].sort((a, b) => {
    for (const column of order) {
      const [x, y] = [String(a[column]), String(b[column])];
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
  const limit = Math.min(Number(params.get("limit") ?? MAX_ROWS), MAX_ROWS);
  const columns = (params.get("select") ?? "").split(",");
  return result.slice(0, limit).map((row) =>
    Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))
  );
}

/** One owned and one foreign row per exported table, plus bulk tables. */
function seed(): Record<string, Row[]> {
  const tables: Record<string, Row[]> = {};
  let n = 100;
  for (const section of DATA_EXPORT_SECTIONS) {
    const owner = OWNER_COLUMN[section.table] ?? "user_id";
    const row = (ownerId: string, text: string): Row => {
      const stored: Row = { [owner]: ownerId };
      for (const column of section.columns) stored[column] = text;
      for (const field of EXCLUDED_FIELDS[section.table] ?? []) {
        stored[field] = SENTINEL;
      }
      for (const column of section.key) {
        if (column !== owner) stored[column] = uuid(n++);
      }
      return stored;
    };
    tables[section.table] = [row(callerId, "owned"), row(otherId, OTHER)];
  }
  // Two page boundaries on a single-column key.
  for (let i = 0; i < 2000; i++) {
    tables.information_units.push({
      id: uuid(10_000 + i),
      user_id: callerId,
      statement: `Statement ${i}`,
      embedding_v2: SENTINEL,
    });
  }
  // One page boundary inside a single unit: the tie-break column carries the
  // pagination, with characters that are reserved in PostgREST filters.
  for (let i = 0; i < 1000; i++) {
    tables.unit_entities.push({
      unit_id: uuid(50_000),
      mention_text: `Mayor, "Jane" (${String(i).padStart(4, "0")}). \\ x`,
      user_id: callerId,
      entity_id: uuid(60_000 + i),
    });
  }
  return tables;
}

Deno.test("personal data export request boundary", async (t) => {
  const restoreEnv = useEnv({
    SERVICE_SUPABASE_URL: `https://${database}`,
    SERVICE_SUPABASE_SERVICE_ROLE_KEY: "offline-service-role",
    SUPABASE_ANON_KEY: "offline-anon",
  });
  const fetchBefore = globalThis.fetch;
  const tables = seed();
  const budget = new Map<string, number>();
  let reads: URL[] = [];
  let apiKeyChecks = 0;

  try {
    const handler = await servedHandler(() => import("../user/index.ts"));
    const exportRequest = (authorization?: string) =>
      handler(
        new Request("https://edge.example.invalid/user/data-export", {
          headers: authorization ? { Authorization: authorization } : {},
        }),
      );

    globalThis.fetch = (async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      assertEquals(url.hostname, database, `unexpected request: ${url}`);
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /auth/v1/user") {
        return req.headers.get("Authorization") === "Bearer offline-session"
          ? Response.json({ id: callerId, email: "owner@example.invalid" })
          : Response.json({ msg: "invalid JWT" }, { status: 401 });
      }
      if (route === "POST /rest/v1/rpc/validate_api_key_identity") {
        // Would admit the key if the route accepted API keys.
        apiKeyChecks++;
        return Response.json([{ user_id: callerId, key_id: uuid(9) }]);
      }
      if (route === "POST /rest/v1/rpc/consume_cli_auth_rate_limit") {
        const body = await req.json();
        const bucket = `${body.p_bucket_hash}:${body.p_action}`;
        const attempts = (budget.get(bucket) ?? 0) + 1;
        budget.set(bucket, attempts);
        return Response.json([{
          allowed: attempts <= body.p_limit,
          attempts,
          retry_after: 1800,
        }]);
      }
      if (route === `GET /auth/v1/admin/users/${callerId}`) {
        return Response.json({
          id: callerId,
          email: "owner@example.invalid",
          created_at: "2026-01-02T03:04:05Z",
          last_sign_in_at: "2026-10-01T00:00:00Z",
          user_metadata: { username: "owner" },
        });
      }
      const table = url.pathname.match(/^\/rest\/v1\/(\w+)$/)?.[1];
      if (req.method === "GET" && table && table in tables) {
        reads.push(url);
        return Response.json(query(tables[table], url));
      }
      throw new Error(`unexpected request: ${route}${url.search}`);
    }) as typeof fetch;

    await t.step(
      "API keys, service keys and missing sessions get 401",
      async () => {
        for (
          const authorization of [
            undefined,
            "Bearer cj_offline-agent-key",
            "Bearer offline-service-role",
          ]
        ) {
          const response = await exportRequest(authorization);
          assertEquals(response.status, 401);
          await response.body?.cancel();
        }
        assertEquals(apiKeyChecks, 0);
        assertEquals(reads, []);
        assertEquals(budget.size, 0);
      },
    );

    let body = "";
    await t.step("session export downloads every owned row", async () => {
      reads = [];
      const response = await exportRequest("Bearer offline-session");
      assertEquals(response.status, 200);
      assertMatch(
        response.headers.get("Content-Type") ?? "",
        /^application\/json/,
      );
      assertMatch(
        response.headers.get("Content-Disposition") ?? "",
        /^attachment; filename="scoutpost-data-\d{4}-\d{2}-\d{2}\.json"$/,
      );
      assertEquals(response.headers.get("Cache-Control"), "no-store");
      body = await response.text();
      const document = JSON.parse(body);

      assertEquals(document.account.id, callerId);
      assertEquals(document.account.created_at, "2026-01-02T03:04:05Z");
      const units = document.sections.information_units;
      assertEquals(units.count, 2001);
      assertEquals(units.rows.length, 2001);
      assertEquals(
        new Set(units.rows.map((row: Row) => row.id)).size,
        2001,
      );
      const mentions = document.sections.unit_entities;
      assertEquals(mentions.count, 1001);
      assertEquals(
        new Set(mentions.rows.map((row: Row) => row.mention_text)).size,
        1001,
      );
      for (const section of DATA_EXPORT_SECTIONS) {
        if (["information_units", "unit_entities"].includes(section.table)) {
          continue;
        }
        assertEquals(
          document.sections[section.name].count,
          1,
          `${section.table} owned rows`,
        );
      }
      const [apiKey] = document.sections.api_keys.rows;
      assertEquals([apiKey.name, apiKey.key_prefix], ["owned", "owned"]);
    });

    await t.step("every read is filtered to the caller", () => {
      assert(reads.length > DATA_EXPORT_SECTIONS.length);
      for (const url of reads) {
        const table = url.pathname.split("/").at(-1)!;
        const owner = OWNER_COLUMN[table] ?? "user_id";
        assertEquals(url.searchParams.get(owner), `eq.${callerId}`, table);
      }
      assert(!body.includes(OTHER), "another user's row was exported");
      assert(!body.includes(otherId), "another user's id was exported");
    });

    await t.step("vectors, secrets and capture bodies never leave", () => {
      assert(!body.includes(SENTINEL), "an excluded field was exported");
      for (const fields of Object.values(EXCLUDED_FIELDS)) {
        for (const field of fields) {
          assert(!body.includes(`"${field}"`), `${field} was exported`);
        }
      }
    });

    await t.step("exports are rate limited per user", async () => {
      for (let i = 1; i < DATA_EXPORT_LIMIT; i++) {
        const response = await exportRequest("Bearer offline-session");
        assertEquals(response.status, 200);
        await response.body?.cancel();
      }
      reads = [];
      const limited = await exportRequest("Bearer offline-session");
      assertEquals(limited.status, 429);
      const payload = await limited.json();
      assertEquals(payload.code, "rate_limit");
      assertEquals(payload.retry_after_seconds, 1800);
      assertEquals(reads, []);
    });
  } finally {
    globalThis.fetch = fetchBefore;
    restoreEnv();
  }
});
