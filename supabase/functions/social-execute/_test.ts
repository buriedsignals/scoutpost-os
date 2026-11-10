/**
 * Tests for the queued social worker (processSocialRun, served by
 * social-execute).
 *
 * Runs in-process against the local Supabase stack (real Postgres, real
 * credit RPCs). Only the three external providers are stubbed at the network
 * edge: Apify, OpenRouter and Resend, plus the profile probe. The migration
 * 20261110120000 is not needed here; the dispatch queue is covered by
 * supabase/tests/social_queue_dispatch.sql.
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestUser,
  getTestingServiceRoleKey,
  SUPABASE_URL,
} from "../_shared/_testing.ts";
import { processSocialRun } from "../_shared/social_run.ts";

const COST = 2; // social_monitoring_x

function svc() {
  return createClient(SUPABASE_URL, getTestingServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface Stub {
  apify: Request[];
  openrouter: number;
  resend: number;
  apifyStatus: number;
  apifyRows: unknown[];
  profileStatus: number;
  resendBodies: string[];
  kickoffCalls: string[];
  /** Answers a request to the local Supabase stack instead of forwarding it. */
  supabaseHook:
    | ((request: Request) => Response | null | Promise<Response | null>)
    | null;
  /** Called per OpenRouter extraction; returns the units or throws. */
  extract: (call: number) => unknown[] | Promise<unknown[]>;
}

function post(id: string, minutes: number) {
  return {
    id,
    text: `Post ${id} about the budget vote at city hall`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, minutes)).toISOString(),
    url: `https://x.com/testhandle/status/${id}`,
  };
}

async function withFixture(
  options: {
    posts?: number; // baseline size
    criteria?: boolean;
    baseline?: boolean;
    credits?: number;
  },
  body: (ctx: {
    db: ReturnType<typeof svc>;
    userId: string;
    scoutId: string;
    newRun: () => Promise<string>;
    stub: Stub;
    balance: () => Promise<number>;
    usage: (key: string) => Promise<number>;
  }) => Promise<void>,
) {
  const db = svc();
  const user = await createTestUser();
  const env = {
    APIFY_API_TOKEN: "test-apify",
    OPENROUTER_API_KEY: "test-openrouter",
    RESEND_API_KEY: "test-resend",
    COJO_CREDITS_ENABLED: "true",
  };
  const prior = Object.fromEntries(
    Object.keys(env).map((k) => [k, Deno.env.get(k)]),
  );
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const originalFetch = globalThis.fetch;
  const stub: Stub = {
    apify: [],
    openrouter: 0,
    resend: 0,
    apifyStatus: 200,
    apifyRows: [],
    profileStatus: 200,
    resendBodies: [],
    kickoffCalls: [],
    supabaseHook: null,
    extract: () => [{
      statement: "The city council voted on the budget.",
      type: "event",
      criteria_match: true,
      criteria_score: 0.9,
    }],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    // The old direct-path worker is faked so it never reaches a real function.
    if (url.pathname === "/functions/v1/social-kickoff") {
      stub.kickoffCalls.push(await request.text());
      return Response.json({ status: "started" }, { status: 202 });
    }
    if (request.url.startsWith(SUPABASE_URL)) {
      const hooked = await stub.supabaseHook?.(request.clone());
      return hooked ?? originalFetch(request);
    }
    if (url.hostname === "api.apify.com") {
      stub.apify.push(request.clone());
      return stub.apifyStatus === 200
        ? Response.json(stub.apifyRows)
        : new Response("apify down", { status: stub.apifyStatus });
    }
    if (
      url.hostname === "openrouter.ai" && url.pathname.endsWith("/embeddings")
    ) {
      return new Response("no embeddings in tests", { status: 500 });
    }
    if (url.hostname === "openrouter.ai") {
      stub.openrouter += 1;
      const units = await stub.extract(stub.openrouter);
      return Response.json({
        id: "gen-test",
        model: "google/gemini-3.5-flash-lite",
        openrouter_metadata: {
          endpoints: {
            available: [{
              provider: "Google Vertex AI",
              model: "google/gemini-3.5-flash-lite",
              selected: true,
            }],
          },
        },
        choices: [{ message: { content: JSON.stringify({ units }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    if (url.hostname === "api.resend.com") {
      stub.resend += 1;
      stub.resendBodies.push(await request.text());
      return Response.json({ id: `re_${stub.resend}` });
    }
    if (url.hostname === "x.com" || url.hostname === "twitter.com") {
      return new Response("", { status: stub.profileStatus });
    }
    throw new Error(`unexpected network call: ${request.url}`);
  }) as typeof fetch;

  const { data: scout, error } = await db.from("scouts").insert({
    user_id: user.id,
    name: `social-${crypto.randomUUID()}`,
    type: "social",
    platform: "x",
    profile_handle: "testhandle",
    schedule_cron: "0 6 * * *",
    is_active: true,
    baseline_established_at: new Date().toISOString(),
    monitor_mode: options.criteria ? "criteria" : "summarize",
    criteria: options.criteria ? "city budget decisions" : null,
    track_removals: true,
  }).select("id").single();
  if (error) throw new Error(error.message);
  const scoutId = scout.id as string;
  try {
    if (options.credits !== undefined) {
      await db.from("credit_accounts").update({ balance: options.credits })
        .eq("user_id", user.id);
    }
    if (options.baseline !== false) {
      const posts = Array.from(
        { length: options.posts ?? 2 },
        (_, i) => ({
          id: `old-${i}`,
          timestamp: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        }),
      );
      const { error: snapErr } = await db.from("post_snapshots").insert({
        user_id: user.id,
        scout_id: scoutId,
        platform: "x",
        handle: "testhandle",
        post_count: posts.length,
        posts,
      });
      if (snapErr) throw new Error(snapErr.message);
    }
    await body({
      db,
      userId: user.id,
      scoutId,
      stub,
      newRun: async () => {
        const { data, error: runErr } = await db.from("scout_runs").insert({
          scout_id: scoutId,
          user_id: user.id,
          status: "running",
          stage: "queued",
          started_at: new Date().toISOString(),
        }).select("id").single();
        if (runErr) throw new Error(runErr.message);
        return data.id as string;
      },
      balance: async () => {
        const { data } = await db.from("credit_accounts").select("balance")
          .eq("user_id", user.id).single();
        return data!.balance as number;
      },
      usage: async (key: string) => {
        const { count } = await db.from("usage_records")
          .select("id", { count: "exact", head: true })
          .eq("idempotency_key", key);
        return count ?? 0;
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await db.from("information_units").delete().eq("scout_id", scoutId);
    await db.from("post_snapshots").delete().eq("scout_id", scoutId);
    await db.from("scout_runs").delete().eq("scout_id", scoutId);
    await db.from("scouts").delete().eq("id", scoutId);
    await user.cleanup();
  }
}

async function failures(db: ReturnType<typeof svc>, scoutId: string) {
  const { data } = await db.from("scouts").select("consecutive_failures")
    .eq("id", scoutId).single();
  return (data!.consecutive_failures ?? 0) as number;
}

async function runRow(db: ReturnType<typeof svc>, runId: string) {
  const { data } = await db.from("scout_runs").select("*").eq("id", runId)
    .single();
  return data as Record<string, unknown>;
}

async function snapshotIds(db: ReturnType<typeof svc>, scoutId: string) {
  const { data } = await db.from("post_snapshots").select("posts")
    .eq("scout_id", scoutId).single();
  return (data!.posts as Array<{ id: string }>).map((p) => p.id).sort();
}

Deno.test("social worker: new post becomes a unit, baseline advances, one charge, one email", async () => {
  await withFixture({}, async (c) => {
    c.stub.apifyRows = [post("n1", 5), post("old-0", 0), post("old-1", 1)];
    const runId = await c.newRun();

    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });

    assertEquals(outcome.status, "success");
    const run = await runRow(c.db, runId);
    assertEquals(run.status, "success");
    assertEquals(run.units_created_count, 1);
    assertEquals(run.notification_status, "sent");
    assertEquals(c.stub.resend, 1);
    assertEquals(c.stub.apify.length, 1);
    assertEquals(await snapshotIds(c.db, c.scoutId), ["n1", "old-0", "old-1"]);
    assertEquals(await c.usage(`social:${runId}:charge`), 1);
    assertEquals(await c.balance(), 100 - COST);
    const { count } = await c.db.from("information_units")
      .select("id", { count: "exact", head: true }).eq("scout_id", c.scoutId);
    assertEquals(count, 1);
  });
});

Deno.test("social worker: a second delivery of the same run does nothing", async () => {
  await withFixture({}, async (c) => {
    c.stub.apifyRows = [post("n1", 5), post("old-0", 0), post("old-1", 1)];
    const runId = await c.newRun();
    const results = await Promise.all([
      processSocialRun(c.db as never, { scoutId: c.scoutId, runId }),
      processSocialRun(c.db as never, { scoutId: c.scoutId, runId }),
    ]);
    assertEquals(
      results.map((r) => r.status).sort(),
      ["claimed_elsewhere", "success"],
    );
    assertEquals(await c.usage(`social:${runId}:charge`), 1);
    assertEquals(c.stub.apify.length, 1);
    assertEquals(c.stub.resend, 1);
    assertEquals(await c.balance(), 100 - COST);
  });
});

Deno.test("social worker: an Apify failure errors the run and refunds exactly once", async () => {
  await withFixture({}, async (c) => {
    c.stub.apifyStatus = 500;
    const runId = await c.newRun();

    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });
    // A re-delivery after the failure must not refund again.
    const again = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });

    assertEquals(outcome.status, "error");
    assertEquals(again.status, "claimed_elsewhere");
    const run = await runRow(c.db, runId);
    assertEquals(run.status, "error");
    assertEquals(run.error_class, "provider");
    assertEquals(await c.usage(`social:${runId}:charge`), 1);
    assertEquals(await c.usage(`social:${runId}:refund`), 1);
    assertEquals(await c.balance(), 100);
    assertEquals(await snapshotIds(c.db, c.scoutId), ["old-0", "old-1"]);
    assertEquals(c.stub.resend, 0);
    // A provider failure after the charge counts toward the auto-pause.
    assertEquals(await failures(c.db, c.scoutId), 1);
  });
});

Deno.test("social worker: a truncated actor result keeps the baseline and reports no removals", async () => {
  await withFixture({ posts: 10 }, async (c) => {
    c.stub.apifyRows = [post("old-9", 9)]; // 1 of 10 previous: under 20 percent
    const runId = await c.newRun();

    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });

    assertEquals(outcome.status, "success");
    assertEquals((await snapshotIds(c.db, c.scoutId)).length, 10);
    assertEquals(c.stub.resend, 0);
    assertEquals((await runRow(c.db, runId)).notification_status, "skipped");
  });
});

Deno.test("social worker: posts not reached before the deadline stay out of the baseline and come back as new", async () => {
  await withFixture({ criteria: true }, async (c) => {
    c.stub.apifyRows = [
      post("n3", 8),
      post("n2", 7),
      post("n1", 6),
      post("old-0", 0),
      post("old-1", 1),
    ];
    // The first extraction "takes" 250 s: past the start cutoff (230 s), before
    // the hard stop (330 s).
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    c.stub.extract = (call) => {
      if (call === 1) offset += 250_000;
      return [{
        statement: `Budget item ${call}`,
        type: "event",
        criteria_match: true,
        criteria_score: 0.9,
      }];
    };
    try {
      const runId = await c.newRun();
      const outcome = await processSocialRun(c.db as never, {
        scoutId: c.scoutId,
        runId,
      });

      assertEquals(outcome.status, "success");
      assertEquals(c.stub.openrouter, 1);
      const run = await runRow(c.db, runId);
      assertEquals(run.units_created_count, 1);
      assertEquals(
        (run.metadata as Record<string, unknown>).deferred_posts,
        2,
      );
      // The alert and the run record count only what this run handled.
      assertEquals(c.stub.resend, 1);
      assert(c.stub.resendBodies[0].includes("1 new post"));
      assert(!c.stub.resendBodies[0].includes("3 new posts"));
      // Only the handled post (the first of the new ones) joined the baseline.
      const ids = await snapshotIds(c.db, c.scoutId);
      assertEquals(ids.length, 3);
      assert(ids.includes("old-0") && ids.includes("old-1"));
      const deferred = ["n1", "n2", "n3"].filter((id) => !ids.includes(id));
      assertEquals(deferred.length, 2);

      // The next run sees the deferred posts as new.
      offset = 0;
      c.stub.extract = () => [];
      const second = await c.newRun();
      const next = await processSocialRun(c.db as never, {
        scoutId: c.scoutId,
        runId: second,
      });
      assertEquals(next.status, "success");
      assert(next.status === "success" && next.newPosts === 2);
    } finally {
      Date.now = realNow;
    }
  });
});

Deno.test("social worker: one failed extraction does not stop the others or refund", async () => {
  await withFixture({ criteria: true }, async (c) => {
    c.stub.apifyRows = [
      post("n2", 7),
      post("n1", 6),
      post("old-0", 0),
      post("old-1", 1),
    ];
    // The primary and the fallback model both fail for the first post.
    c.stub.extract = (call) => {
      if (call <= 2) throw new Error("model unavailable");
      return [{
        statement: "Second post statement",
        type: "event",
        criteria_match: true,
        criteria_score: 0.9,
      }];
    };
    const runId = await c.newRun();

    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });

    assertEquals(outcome.status, "success");
    const run = await runRow(c.db, runId);
    assertEquals([run.units_created_count, run.units_merged_count], [1, 0]);
    assertEquals(c.stub.openrouter, 3);
    // Today's behaviour: a post whose extraction failed is still in the baseline.
    assertEquals((await snapshotIds(c.db, c.scoutId)).length, 4);
    assertEquals(await c.usage(`social:${runId}:refund`), 0);
  });
});

Deno.test("social worker: exits before the charge leave credits untouched", async () => {
  // No baseline.
  await withFixture({ baseline: false }, async (c) => {
    const runId = await c.newRun();
    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });
    assertEquals(outcome.status, "error");
    assertEquals((await runRow(c.db, runId)).error_class, "no_baseline");
    assertEquals(await c.usage(`social:${runId}:charge`), 0);
    assertEquals(await c.balance(), 100);
    assertEquals(c.stub.apify.length, 0);
  });
  // Profile gone.
  await withFixture({}, async (c) => {
    c.stub.profileStatus = 404;
    const runId = await c.newRun();
    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });
    assertEquals(outcome, { status: "skipped", reason: "profile_missing" });
    assertEquals((await runRow(c.db, runId)).status, "skipped");
    assertEquals(await c.balance(), 100);
    assertEquals(c.stub.apify.length, 0);
  });
  // Not enough credits.
  await withFixture({ credits: 1 }, async (c) => {
    const runId = await c.newRun();
    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });
    assertEquals(outcome, {
      status: "skipped",
      reason: "insufficient_credits",
    });
    const run = await runRow(c.db, runId);
    assertEquals([run.status, run.error_class], ["skipped", "quota"]);
    assertEquals(await c.balance(), 1);
    assertEquals(c.stub.apify.length, 0);
  });
  // Apify token missing: checked before the charge.
  await withFixture({}, async (c) => {
    Deno.env.delete("APIFY_API_TOKEN");
    const runId = await c.newRun();
    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });
    assertEquals(outcome.status, "error");
    assertEquals(await c.usage(`social:${runId}:charge`), 0);
    assertEquals(await c.usage(`social:${runId}:refund`), 0);
    assertEquals(await c.balance(), 100);
  });
});

const rpcFailure =
  (name: string, body: Record<string, unknown>) => (request: Request) =>
    new URL(request.url).pathname.endsWith(`/rpc/${name}`)
      ? Response.json(body, { status: 400 })
      : null;

Deno.test("social worker: credit-stage errors end the run readably and do not count as failures", async () => {
  for (
    const [code, message] of [
      ["XX000", "credit backend exploded"],
      ["P0003", "indicator_access_expired"],
    ]
  ) {
    await withFixture({}, async (c) => {
      c.stub.supabaseHook = rpcFailure("decrement_credits_once", {
        code,
        message,
        details: null,
        hint: null,
      });
      const runId = await c.newRun();

      const outcome = await processSocialRun(c.db as never, {
        scoutId: c.scoutId,
        runId,
      });

      assertEquals(outcome.status, "error");
      const run = await runRow(c.db, runId);
      assertEquals(run.status, "error");
      assert(!String(run.error_message).includes("[object Object]"));
      if (code === "XX000") assert(String(run.error_message).includes(message));
      assertEquals(await failures(c.db, c.scoutId), 0);
      assertEquals(await c.usage(`social:${runId}:refund`), 0);
      assertEquals(await c.balance(), 100);
      assertEquals(c.stub.apify.length, 0);
    });
  }
});

Deno.test("social worker: a database error before the charge ends the run without counting a failure", async () => {
  await withFixture({}, async (c) => {
    c.stub.supabaseHook = (request) =>
      request.method === "GET" &&
        new URL(request.url).pathname.endsWith("/rest/v1/post_snapshots")
        ? Response.json({ code: "XX000", message: "snapshots unavailable" }, {
          status: 500,
        })
        : null;
    const runId = await c.newRun();

    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });

    assertEquals(outcome.status, "error");
    assertEquals((await runRow(c.db, runId)).status, "error");
    assertEquals(await failures(c.db, c.scoutId), 0);
    assertEquals(await c.usage(`social:${runId}:charge`), 0);
    assertEquals(await c.balance(), 100);
  });
});

Deno.test("social worker: the refund is issued even when marking the run failed throws", async () => {
  await withFixture({}, async (c) => {
    c.stub.apifyStatus = 500;
    // Fail only the update that marks the run as an error.
    c.stub.supabaseHook = async (request) => {
      if (
        request.method !== "PATCH" ||
        !new URL(request.url).pathname.endsWith("/rest/v1/scout_runs")
      ) return null;
      const body = await request.text();
      return body.includes('"status":"error"')
        ? Response.json({ code: "XX000", message: "marking unavailable" }, {
          status: 500,
        })
        : null;
    };
    const runId = await c.newRun();
    let threw = false;
    try {
      await processSocialRun(c.db as never, { scoutId: c.scoutId, runId });
    } catch {
      threw = true;
    }
    assert(threw, "markRunError failure escapes so the caller can retry it");
    assertEquals(await c.usage(`social:${runId}:refund`), 1);
    assertEquals(await c.balance(), 100);
  });
});

Deno.test("social worker: a claim query error neither runs nor closes the run", async () => {
  await withFixture({}, async (c) => {
    c.stub.supabaseHook = (request) =>
      request.method === "PATCH" &&
        new URL(request.url).pathname.endsWith("/rest/v1/scout_runs") &&
        new URL(request.url).searchParams.get("stage") === "eq.queued"
        ? Response.json({ code: "XX000", message: "claim unavailable" }, {
          status: 500,
        })
        : null;
    const runId = await c.newRun();

    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });

    assertEquals(outcome.status, "claim_failed");
    const run = await runRow(c.db, runId);
    assertEquals([run.status, run.stage], ["running", "queued"]);
    assertEquals(await c.usage(`social:${runId}:charge`), 0);
    assertEquals(c.stub.apify.length, 0);
  });
});

Deno.test("social worker: a post cut by the hard stop mid-way is deferred, not lost", async () => {
  await withFixture({ criteria: true }, async (c) => {
    c.stub.apifyRows = [
      post("n2", 7),
      post("n1", 6),
      post("old-0", 0),
      post("old-1", 1),
    ];
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    // The extraction answer arrives after the hard stop (330 s).
    c.stub.extract = () => {
      offset += 400_000;
      return [{
        statement: "Budget item",
        type: "event",
        criteria_match: true,
        criteria_score: 0.9,
      }];
    };
    try {
      const runId = await c.newRun();
      const outcome = await processSocialRun(c.db as never, {
        scoutId: c.scoutId,
        runId,
      });

      assertEquals(outcome.status, "success");
      assert(outcome.status === "success" && outcome.deferredPosts === 2);
      assertEquals((await runRow(c.db, runId)).units_created_count, 0);
      assertEquals(
        (await snapshotIds(c.db, c.scoutId)).filter((id) => id.startsWith("n")),
        [],
      );
      assertEquals(c.stub.resend, 0);
    } finally {
      Date.now = realNow;
    }
  });
});

Deno.test("social worker: a removal-only run sends the removal alert", async () => {
  await withFixture({ posts: 5 }, async (c) => {
    // old-4 is gone from a result that is still under the cap.
    c.stub.apifyRows = [0, 1, 2, 3].map((i) => post(`old-${i}`, i));
    const runId = await c.newRun();

    const outcome = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId,
    });

    assertEquals(outcome.status, "success");
    const run = await runRow(c.db, runId);
    assertEquals([run.status, run.notification_status], ["success", "sent"]);
    assertEquals(run.units_created_count, 0);
    assertEquals(c.stub.resend, 1);
    assert(c.stub.resendBodies[0].includes("1 post was removed"));
  });
});

Deno.test("social worker: a failure after extraction is refunded, and the next run re-extracts without duplicating units", async () => {
  await withFixture({}, async (c) => {
    c.stub.apifyRows = [post("n1", 5), post("old-0", 0), post("old-1", 1)];
    // The baseline write fails: the unit exists, the baseline is stale.
    c.stub.supabaseHook = (request) =>
      request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/rest/v1/post_snapshots")
        ? Response.json({ code: "XX000", message: "write unavailable" }, {
          status: 500,
        })
        : null;
    const first = await c.newRun();
    const failed = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId: first,
    });
    assertEquals(failed.status, "error");
    assertEquals(await c.usage(`social:${first}:refund`), 1);
    assertEquals(await failures(c.db, c.scoutId), 1);
    assertEquals(await snapshotIds(c.db, c.scoutId), ["old-0", "old-1"]);

    c.stub.supabaseHook = null;
    const second = await c.newRun();
    const next = await processSocialRun(c.db as never, {
      scoutId: c.scoutId,
      runId: second,
    });

    // The post is new again; its unit merges instead of duplicating.
    assert(next.status === "success" && next.newPosts === 1);
    const { count } = await c.db.from("information_units")
      .select("id", { count: "exact", head: true }).eq("scout_id", c.scoutId);
    assertEquals(count, 1);
    assertEquals(await snapshotIds(c.db, c.scoutId), ["n1", "old-0", "old-1"]);
    console.log(
      "next run after a crash before the baseline write:",
      JSON.stringify(next),
      "alerts sent:",
      c.stub.resend,
    );
  });
});

/**
 * execute-scout's request handler, captured from its Deno.serve call and
 * invoked in-process (no port, no subprocess). The queue decision reads the
 * environment on every request, so each case just sets the secret.
 */
let executeScoutHandler: ((req: Request) => Promise<Response>) | null = null;
async function loadExecuteScout() {
  if (executeScoutHandler) return executeScoutHandler;
  const realServe = Deno.serve;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (...args: unknown[]) => {
    executeScoutHandler = args.find((a) => typeof a === "function") as never;
    return {};
  };
  try {
    await import("../execute-scout/index.ts");
  } finally {
    Deno.serve = realServe;
  }
  return executeScoutHandler!;
}

async function withExecuteScout(
  queueTypes: string,
  body: (dispatch: (scoutId: string) => Promise<Response>) => Promise<void>,
) {
  const handler = await loadExecuteScout();
  // CI exposes the stack as API_URL; the handler's direct path reads SUPABASE_URL.
  const names = [
    "SCOUT_DISPATCH_QUEUE_TYPES",
    "INTERNAL_SERVICE_KEY",
    "SUPABASE_URL",
  ];
  const prior = names.map((n) => Deno.env.get(n));
  Deno.env.set("SCOUT_DISPATCH_QUEUE_TYPES", queueTypes);
  Deno.env.set("INTERNAL_SERVICE_KEY", "test-internal-key");
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  try {
    await body((scoutId) =>
      handler(
        new Request("http://localhost/execute-scout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "test-internal-key",
          },
          body: JSON.stringify({ scout_id: scoutId }),
        }),
      )
    );
  } finally {
    names.forEach((n, i) => {
      if (prior[i] === undefined) Deno.env.delete(n);
      else Deno.env.set(n, prior[i]!);
    });
  }
}

async function queueRows(db: ReturnType<typeof svc>, scoutId: string) {
  const { data } = await db.from("scout_dispatch_queue")
    .select("scout_type, status").eq("scout_id", scoutId);
  return data ?? [];
}

Deno.test("execute-scout: social goes through the queue only when the secret lists it", async () => {
  await withFixture({}, async (c) => {
    await withExecuteScout("web,beat,civic,social", async (dispatch) => {
      const res = await dispatch(c.scoutId);
      const body = await res.json();
      assertEquals([res.status, body.queued], [202, "social"]);
      assertEquals(await queueRows(c.db, c.scoutId), [
        { scout_type: "social", status: "queued" },
      ]);
      assertEquals(c.stub.kickoffCalls.length, 0);
    });
    await c.db.from("scout_dispatch_queue").delete().eq("scout_id", c.scoutId);
    await c.db.from("scout_runs").delete().eq("scout_id", c.scoutId);

    // Secret unset, or listing only the other types: the old direct path.
    for (const types of ["", "web,beat,civic"]) {
      await withExecuteScout(types, async (dispatch) => {
        const before = c.stub.kickoffCalls.length;
        const res = await dispatch(c.scoutId);
        const body = await res.json();
        assertEquals([res.status, body.dispatched], [202, "social"]);
        assertEquals(c.stub.kickoffCalls.length, before + 1);
        assertEquals(await queueRows(c.db, c.scoutId), []);
      });
    }
  });
});

Deno.test("execute-scout: web scouts still queue with the secret unset", async () => {
  await withFixture({}, async (c) => {
    await c.db.from("scouts").update({
      type: "web",
      url: "https://example.com",
      platform: null,
      profile_handle: null,
    }).eq("id", c.scoutId);
    await withExecuteScout("", async (dispatch) => {
      const res = await dispatch(c.scoutId);
      const body = await res.json();
      assertEquals([res.status, body.queued], [202, "web"]);
    });
  });
});
