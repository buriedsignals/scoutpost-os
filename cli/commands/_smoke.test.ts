// scout CLI live smoke test — runs the real CLI commands against deployed
// Supabase Edge Functions with a test API key. Skipped unless all of these env
// vars are set in CI (or locally for ad-hoc runs):
//
//   SCOUT_TEST_API_URL          — e.g. https://<project-ref>.supabase.co/functions/v1
//   SCOUT_TEST_API_KEY          — cj_… key with read-only test scope
//   SCOUT_TEST_SUPABASE_ANON_KEY — Supabase project anon key
//
// CI gating: the workflow declares `vars.SCOUT_SMOKE_ENABLED`,
// so missing secrets skip the job entirely. Locally, leaving any of the env
// vars unset skips at test-collection time — no network is touched.
//
// Each test drives the command a user runs (`scout units list`, …) so the
// smoke exercises exactly the route and method the CLI calls. The real fetch
// is wrapped only to record the response the command consumed; the assertions
// check the envelope the command's parsing depends on, because the commands
// themselves render an unknown shape as an empty table instead of failing.
//
// Read-only by design: never invokes mutating commands (delete/verify/reject).

import { assert, assertEquals } from "jsr:@std/assert";
import { writeConfigFile } from "../lib/client.ts";
import { run as runScouts } from "./scouts.ts";
import { run as runUnits } from "./units.ts";
import { run as runUser } from "./user.ts";

const API_URL = Deno.env.get("SCOUT_TEST_API_URL") ??
  Deno.env.get("COJO_TEST_API_URL");
const API_KEY = Deno.env.get("SCOUT_TEST_API_KEY") ??
  Deno.env.get("COJO_TEST_API_KEY");
const ANON_KEY = Deno.env.get("SCOUT_TEST_SUPABASE_ANON_KEY") ??
  Deno.env.get("COJO_TEST_SUPABASE_ANON_KEY");

const SKIP = !API_URL || !API_KEY || !ANON_KEY;

interface RecordedCall {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

async function withSmokeConfig(fn: () => Promise<void>): Promise<void> {
  const originalHome = Deno.env.get("HOME");
  const originalAppData = Deno.env.get("APPDATA");
  const tmp = await Deno.makeTempDir({ prefix: "scout-smoke-" });
  Deno.env.set("HOME", tmp);
  Deno.env.set("APPDATA", tmp);
  try {
    writeConfigFile({
      api_url: API_URL!,
      api_key: API_KEY!,
      supabase_anon_key: ANON_KEY!,
    });
    await fn();
  } finally {
    if (originalHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", originalHome);
    if (originalAppData === undefined) Deno.env.delete("APPDATA");
    else Deno.env.set("APPDATA", originalAppData);
    try {
      await Deno.remove(tmp, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

/** Runs a CLI command against the live API and returns every call it made. */
async function runCommand(
  command: (argv: string[]) => Promise<void>,
  argv: string[],
): Promise<RecordedCall[]> {
  const calls: RecordedCall[] = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const response = await realFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const text = await response.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the raw text for the assertion message */
    }
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      status: response.status,
      body,
    });
    return response;
  }) as typeof fetch;
  console.log = () => {};
  try {
    await withSmokeConfig(() => command(argv));
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert(calls.length > 0, "command made no API call");
  return calls;
}

function assertRoute(call: RecordedCall, method: string, suffix: string) {
  assertEquals(call.method, method);
  assert(
    call.path.endsWith(suffix),
    `expected ${method} …${suffix}, got ${call.method} ${call.path}`,
  );
  assertEquals(call.status, 200);
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} is not an object: ${JSON.stringify(value)}`,
  );
}

function assertPaginatedEnvelope(body: unknown): void {
  assertRecord(body, "response");
  assert(Array.isArray(body.items), "response.items is not an array");
  assertRecord(body.pagination, "response.pagination");
  const { total, offset, limit, has_more } = body.pagination;
  assertEquals(typeof total, "number");
  assertEquals(typeof offset, "number");
  assertEquals(typeof limit, "number");
  assertEquals(typeof has_more, "boolean");
}

Deno.test({
  name: "smoke: scout units list reads a paginated envelope",
  ignore: SKIP,
  fn: async () => {
    const [call] = await runCommand(runUnits, ["list", "--limit", "1"]);
    assertRoute(call, "GET", "/units");
    assertPaginatedEnvelope(call.body);
  },
});

Deno.test({
  name: "smoke: scout units search POSTs a query and reads its items",
  ignore: SKIP,
  fn: async () => {
    const [call] = await runCommand(runUnits, [
      "search",
      "--query",
      "council",
      "--limit",
      "1",
    ]);
    assertRoute(call, "POST", "/units/search");
    assertRecord(call.body, "response");
    assert(Array.isArray(call.body.items), "response.items is not an array");
  },
});

Deno.test({
  name: "smoke: scout scouts list pages through the user's scouts",
  ignore: SKIP,
  fn: async () => {
    const calls = await runCommand(runScouts, ["list", "--limit", "5"]);
    for (const call of calls) {
      assertRoute(call, "GET", "/scouts");
      assertPaginatedEnvelope(call.body);
    }
    const last = calls[calls.length - 1].body as {
      pagination: { has_more: boolean };
    };
    assertEquals(last.pagination.has_more, false);
  },
});

Deno.test({
  name: "smoke: scout user me returns the API key owner's account state",
  ignore: SKIP,
  fn: async () => {
    const [call] = await runCommand(runUser, ["me"]);
    assertRoute(call, "GET", "/user/me");
    assertRecord(call.body, "response");
    assertEquals(typeof call.body.user_id, "string");
    assert(
      ["free", "pro", "team"].includes(call.body.tier as string),
      `unexpected tier ${JSON.stringify(call.body.tier)}`,
    );
  },
});
