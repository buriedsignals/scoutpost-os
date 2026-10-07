import {
  assertEquals,
  assertMatch,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { AuthedUser } from "../_shared/auth.ts";
import { ConflictError, NotFoundError, ValidationError } from "../_shared/errors.ts";
import { createScout, getScout, runScout, testScout } from "./handlers.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const SCOUT_ID = "33333333-3333-4333-8333-333333333333";
const BODY_ID = "44444444-4444-4444-8444-444444444444";
const PAGE_URL = "https://example.com/council";
const user: AuthedUser = { id: OWNER, token: "", authMethod: "delegated" };
const page = {
  name: "Council notices",
  type: "web",
  url: PAGE_URL,
  topic: "housing",
  preferred_language: "en",
  archive_enabled: false,
  wayback_enabled: false,
};

function request(body: unknown): Request {
  return new Request("https://scoutpost.test/scouts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function withBoundary(
  fetcher: (url: URL, init: RequestInit) => Response,
  exercise: () => Promise<void>,
): Promise<void> {
  const settings = {
    SERVICE_SUPABASE_URL: "https://db.test",
    SERVICE_SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
    SUPABASE_ANON_KEY: "fixture-anon",
    SCRAPE_PROVIDER: "firecrawl",
    FIRECRAWL_API_KEY: "fixture-scrape",
    OPENROUTER_API_KEY: "fixture-model",
  };
  const previous = new Map(
    Object.keys(settings).map((key) => [key, Deno.env.get(key)]),
  );
  const originalFetch = globalThis.fetch;
  try {
    for (const [key, value] of Object.entries(settings)) Deno.env.set(key, value);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(fetcher(
        new URL(input instanceof Request ? input.url : String(input)),
        init ?? {},
      ))) as typeof fetch;
    await exercise();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function scrapeResponse(statusCode = 200): Response {
  return Response.json({
    data: {
      markdown: "The council published a housing committee agenda for October. " +
        "The committee will discuss affordable housing construction and tenant protections.",
      metadata: { sourceURL: PAGE_URL, statusCode },
    },
  });
}

Deno.test("Page preview distinguishes criteria mismatch, unavailable evaluation and no request", async () => {
  const cases = [
    { criteria: "housing", matches: true, evaluation: "matched", legacy: true },
    { criteria: "housing", matches: false, evaluation: "not_matched", legacy: false },
    { criteria: "housing", modelFailed: true, evaluation: "unavailable", legacy: false },
    { criteria: "housing", matches: "false", evaluation: "unavailable", legacy: true },
    { matches: true, evaluation: "not_requested", legacy: false },
    { modelFailed: true, evaluation: "not_requested", legacy: false },
    { criteria: "housing", unreachable: true, evaluation: "unavailable", legacy: false },
  ];
  for (const scenario of cases) {
    await withBoundary((url) => {
      if (url.hostname === "api.firecrawl.dev") {
        return scrapeResponse(scenario.unreachable ? 404 : 200);
      }
      if (url.hostname === "openrouter.ai") {
        if (scenario.modelFailed) return new Response("unauthorized", { status: 401 });
        return Response.json({
          choices: [{ message: { content: JSON.stringify({
            matches: scenario.matches,
            summary: "Council housing agenda.",
          }) } }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }, async () => {
      const response = await testScout(request({
        url: PAGE_URL,
        criteria: scenario.criteria,
      }), user);
      const result = await response.json();
      assertEquals(response.status, 200);
      assertEquals(result.ok, !scenario.unreachable);
      assertEquals(result.scraper_status, !scenario.unreachable);
      assertEquals(result.criteria_status, scenario.legacy);
      assertEquals(result.criteria_evaluation, scenario.evaluation);
      assertEquals(result.error_code, scenario.unreachable
        ? "unreachable"
        : scenario.evaluation === "not_matched" ? "criteria_not_met" : undefined);
    });
  }
});

Deno.test("Scout creation accepts only trusted IDs and derives owner from caller", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  await withBoundary((url, init) => {
    if (url.hostname === "api.firecrawl.dev") return scrapeResponse();
    if (url.pathname === "/rest/v1/scouts" && init.method === "POST") {
      const row = JSON.parse(String(init.body));
      inserted.push(row);
      return Response.json({ id: SCOUT_ID, ...row }, { status: 201 });
    }
    if (url.pathname === "/rest/v1/scout_runs") return Response.json(null);
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    const body = { ...page, id: BODY_ID, user_id: OTHER_OWNER };
    const publicResponse = await createScout(request(body), user);
    assertEquals(publicResponse.status, 201);
    await publicResponse.body?.cancel();
    assertEquals(inserted[0].id, undefined);
    assertEquals(inserted[0].user_id, OWNER);

    const trustedResponse = await createScout(request(body), user, { scoutId: SCOUT_ID });
    assertEquals(trustedResponse.status, 201);
    assertEquals((await trustedResponse.json()).id, SCOUT_ID);
    assertEquals(inserted[1].id, SCOUT_ID);
    assertEquals(inserted[1].user_id, OWNER);
  });
});

Deno.test("Scout creation rejects malformed trusted IDs before external work", async () => {
  let calls = 0;
  await withBoundary(() => {
    calls++;
    throw new Error("No external work is allowed");
  }, async () => {
    await assertRejects(
      () => createScout(request(page), user, { scoutId: "not-a-uuid" }),
      ValidationError,
      "invalid trusted scout ID",
    );
    assertEquals(calls, 0);
  });
});

Deno.test("Scout creation rejects invalid payloads before external work", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ name: "Bad type", type: "not-a-real-type", url: PAGE_URL }, /type/],
    [{ name: "Missing URL", type: "web", topic: "council" }, /url/],
    [{ name: "Unscoped", type: "web", url: PAGE_URL }, /topic/],
    [{ name: "Too many tags", type: "web", url: PAGE_URL, topic: "one, two, three, four" }, /at most 3/i],
    [{
      name: "Daily Beat",
      scout_type: "pulse",
      criteria: "housing policy",
      topic: "housing",
      regularity: "daily",
      time: "08:00",
    }, /weekly or monthly/i],
    [{
      name: "Multiline social target",
      type: "social",
      platform: "facebook",
      profile_handle: "zuck\nhttps://www.facebook.com/meta",
      monitor_mode: "summarize",
      topic: "technology",
    }, /single line/i],
    [{
      name: "Facebook group title",
      type: "social",
      platform: "facebook",
      profile_handle: "Du kommst aus dem Klettgau, wenn...",
      monitor_mode: "summarize",
      topic: "local news",
    }, /not its display name/i],
    [{
      name: "LinkedIn feed",
      type: "social",
      platform: "linkedin",
      profile_handle: "https://www.linkedin.com/feed/",
      monitor_mode: "summarize",
      topic: "technology",
    }, /linkedin\.com\/in\//i],
    [{
      name: "LinkedIn company",
      type: "social",
      platform: "linkedin",
      profile_handle: "https://www.linkedin.com/company/microsoft/",
      monitor_mode: "summarize",
      topic: "technology",
    }, /company pages/i],
    [{ name: "   ", type: "beat", topic: "housing" }, /name/],
    [{ name: "Empty location", type: "beat", location: {} }, /location/],
    [{ name: "Blank location", type: "beat", location: { displayName: " " } }, /location/],
  ];
  let calls = 0;
  await withBoundary(() => {
    calls++;
    throw new Error("No external work is allowed");
  }, async () => {
    for (const [payload, field] of cases) {
      const error = await assertRejects(
        () => createScout(request(payload), user),
        ValidationError,
      );
      assertMatch(error.message, field);
    }
  });
  assertEquals(calls, 0);
});

Deno.test("Page creation probes again after a successful preview before inserting", async () => {
  let scrapes = 0;
  let inserts = 0;
  await withBoundary((url, init) => {
    if (url.hostname === "api.firecrawl.dev") return scrapeResponse(++scrapes === 1 ? 200 : 404);
    if (url.hostname === "openrouter.ai") {
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        matches: true,
        summary: "Council housing agenda.",
      }) } }] });
    }
    if (url.pathname === "/rest/v1/scouts" && init.method === "POST") inserts++;
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    const preview = await testScout(request({ url: PAGE_URL }), user);
    assertEquals((await preview.json()).ok, true);
    const created = await createScout(request(page), user, { scoutId: SCOUT_ID });
    assertEquals(created.status, 422);
    const body = await created.json();
    assertEquals(body.ok, false);
    assertEquals(body.stage, "reach");
    assertEquals(body.error_code, "unreachable");
    assertEquals(scrapes, 2);
    assertEquals(inserts, 0);
  });
});

Deno.test("Civic creation without a preview refuses tracked pages that expose no meetings", async () => {
  const trackedUrl = "https://city.example.gov/council/agendas";
  let scrapes = 0;
  let inserts = 0;
  await withBoundary((url, init) => {
    if (url.hostname === "api.firecrawl.dev") {
      scrapes++;
      const target = JSON.parse(String(init.body)).url;
      return Response.json({
        data: {
          markdown: "Council information",
          rawHtml: "<main><p>Council information</p></main>",
          metadata: { sourceURL: target, statusCode: 200 },
        },
      });
    }
    if (url.pathname === "/rest/v1/scouts" && init.method === "POST") inserts++;
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    const created = await createScout(request({
      name: "Civic gate",
      type: "civic",
      root_domain: "city.example.gov",
      tracked_urls: [trackedUrl],
      criteria: "housing",
      topic: "housing, council",
      preferred_language: "en",
    }), user);
    assertEquals(created.status, 422);
    const body = await created.json();
    assertEquals(body.ok, false);
    assertEquals(body.stage, "detect");
    assertEquals(body.error_code, "no_meetings_detected");
    assertEquals(typeof body.error, "string");
    assertEquals(body.invalid, [trackedUrl]);
    assertEquals(body.validated, []);
    assertEquals(Array.isArray(body.candidates), true);
  });
  assertEquals(scrapes > 0, true);
  assertEquals(inserts, 0);
});

Deno.test("Delegated Scout lookup cannot read another owner's row", async () => {
  const row = { id: SCOUT_ID, user_id: OTHER_OWNER, name: "Private council" };
  await withBoundary((url) => {
    if (url.pathname === "/rest/v1/scouts") {
      const idMatches = url.searchParams.get("id") === `eq.${row.id}`;
      const ownerFilter = url.searchParams.get("user_id");
      return Response.json(idMatches && (!ownerFilter || ownerFilter === `eq.${row.user_id}`)
        ? row
        : null);
    }
    if (url.pathname === "/rest/v1/scout_runs") return Response.json(null);
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    await assertRejects(() => getScout(user, SCOUT_ID), NotFoundError);
    const ownResponse = await getScout({ ...user, id: OTHER_OWNER }, SCOUT_ID);
    assertEquals((await ownResponse.json()).name, "Private council");
  });
});

Deno.test("Scheduled Page baseline failure rolls back only the newly owned Scout", async () => {
  let inserted = false;
  let scheduled = false;
  const deleted: string[] = [];
  await withBoundary((url, init) => {
    if (url.hostname === "api.firecrawl.dev") return scrapeResponse();
    if (url.pathname === "/rest/v1/scouts" && init.method === "POST") {
      inserted = true;
      return Response.json(JSON.parse(String(init.body)), { status: 201 });
    }
    if (url.pathname === "/rest/v1/raw_captures") {
      return Response.json({ message: "baseline storage unavailable" }, { status: 500 });
    }
    if (url.pathname === "/rest/v1/scouts" && init.method === "DELETE") {
      deleted.push(url.searchParams.get("id") ?? "", url.searchParams.get("user_id") ?? "");
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/rest/v1/rpc/schedule_scout") scheduled = true;
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    await assertRejects(() => createScout(request({
      ...page,
      regularity: "weekly",
      day_number: 7,
      time: "09:00",
    }), user, { scoutId: SCOUT_ID }), Error, "baseline storage unavailable");
    assertEquals(inserted, true);
    assertEquals(scheduled, false);
    assertEquals(deleted, [`eq.${SCOUT_ID}`, `eq.${OWNER}`]);
  });
});

Deno.test("Run Now refuses a Beat Scout until its background baseline lands", async () => {
  let row: Record<string, unknown> = { id: SCOUT_ID, is_active: true, type: "beat", baseline_established_at: null };
  let triggered = 0;
  await withBoundary((url) => {
    if (url.pathname === "/rest/v1/scouts") return Response.json(row);
    if (url.pathname === "/rest/v1/rpc/trigger_scout_run") {
      triggered++;
      return Response.json(BODY_ID);
    }
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    await assertRejects(() => runScout(user, SCOUT_ID), ConflictError, "baseline");
    assertEquals(triggered, 0);
    row = { ...row, baseline_established_at: "2026-10-01T14:05:00Z" };
    const accepted = await runScout(user, SCOUT_ID);
    assertEquals(accepted.status, 202);
    assertEquals(triggered, 1);
  });
});
