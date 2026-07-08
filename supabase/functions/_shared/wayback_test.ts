import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  parseWaybackTimestamp,
  submitToWayback,
} from "./wayback.ts";

const CAPTURED_AT = "2026-07-07T12:00:00Z";
const KEYS = { accessKey: "ak", secretKey: "sk" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCleanEnv<T>(fn: () => T): T {
  const prev = Deno.env.get("SNAPSHOT_WAYBACK_ENABLED");
  Deno.env.delete("SNAPSHOT_WAYBACK_ENABLED");
  Deno.env.delete("SPN_ACCESS_KEY");
  Deno.env.delete("SPN_SECRET_KEY");
  try {
    return fn();
  } finally {
    if (prev !== undefined) Deno.env.set("SNAPSHOT_WAYBACK_ENABLED", prev);
  }
}

Deno.test("parseWaybackTimestamp parses 14-digit UTC timestamps", () => {
  assertEquals(parseWaybackTimestamp("20260707120000"), Date.UTC(2026, 6, 7, 12, 0, 0));
  assertEquals(parseWaybackTimestamp("bad"), null);
});

Deno.test("submitToWayback: disabled when per-scout off, kill switch, or no keys", async () => {
  await withCleanEnv(async () => {
    // per-scout off
    assertEquals(
      (await submitToWayback("https://x.com", CAPTURED_AT, false, KEYS)).status,
      "disabled",
    );
    // no keys
    assertEquals(
      (await submitToWayback("https://x.com", CAPTURED_AT, true, {})).status,
      "disabled",
    );
    // kill switch
    Deno.env.set("SNAPSHOT_WAYBACK_ENABLED", "false");
    assertEquals(
      (await submitToWayback("https://x.com", CAPTURED_AT, true, KEYS)).status,
      "disabled",
    );
    Deno.env.delete("SNAPSHOT_WAYBACK_ENABLED");
  });
});

Deno.test("submitToWayback: never makes a network call when disabled", async () => {
  await withCleanEnv(async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;
    await submitToWayback("https://x.com", CAPTURED_AT, false, { ...KEYS, fetchImpl });
    assert(!called);
  });
});

Deno.test("submitToWayback: save→status success yields success + archive url", async () => {
  await withCleanEnv(async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes("/save/status/")) {
        return Promise.resolve(jsonResponse({
          status: "success",
          timestamp: "20260707120500", // 5 min after captured_at
          original_url: "https://x.com",
        }));
      }
      return Promise.resolve(jsonResponse({ job_id: "spn2-abc" }));
    }) as unknown as typeof fetch;
    const r = await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl });
    assertEquals(r.status, "success");
    assertStringIncludes(r.waybackUrl!, "web.archive.org/web/20260707120500/https://x.com");
  });
});

Deno.test("submitToWayback: a capture predating captured_at is flagged stale (URL retained)", async () => {
  await withCleanEnv(async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes("/save/status/")) {
        return Promise.resolve(jsonResponse({
          status: "success",
          timestamp: "20260707100000", // 2h BEFORE captured_at
          original_url: "https://x.com",
        }));
      }
      return Promise.resolve(jsonResponse({ job_id: "spn2-abc" }));
    }) as unknown as typeof fetch;
    const r = await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl });
    assertEquals(r.status, "stale");
    assert(r.waybackUrl); // retained, just excluded from corroboration labeling
  });
});

Deno.test("submitToWayback: a dedup hit with an inline timestamp resolves without a status call", async () => {
  await withCleanEnv(async () => {
    let statusCalls = 0;
    const fetchImpl = ((url: string) => {
      if (url.includes("/save/status/")) {
        statusCalls++;
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({
        timestamp: "20260707120500",
        original_url: "https://x.com",
      }));
    }) as unknown as typeof fetch;
    const r = await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl });
    assertEquals(r.status, "success");
    assertEquals(statusCalls, 0);
  });
});

Deno.test("submitToWayback: pending status → submitted (no polling loop)", async () => {
  await withCleanEnv(async () => {
    const fetchImpl = ((url: string) => {
      if (url.includes("/save/status/")) {
        return Promise.resolve(jsonResponse({ status: "pending" }));
      }
      return Promise.resolve(jsonResponse({ job_id: "spn2-abc" }));
    }) as unknown as typeof fetch;
    const r = await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl });
    assertEquals(r.status, "submitted");
    assertEquals(r.waybackUrl, undefined);
  });
});

Deno.test("submitToWayback: save 429/5xx → failed, single attempt", async () => {
  await withCleanEnv(async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls++;
      return Promise.resolve(new Response("slow down", { status: 429 }));
    }) as unknown as typeof fetch;
    const r = await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl });
    assertStringIncludes(r.status, "failed:save_http_429");
    assertEquals(calls, 1); // no retry storm
  });
});

Deno.test("submitToWayback: save network error → failed", async () => {
  await withCleanEnv(async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error("connection reset"))) as unknown as typeof fetch;
    const r = await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl });
    assertStringIncludes(r.status, "failed:save_network");
  });
});

Deno.test("submitToWayback: no job_id → failed:no_job; job error → failed:job_error", async () => {
  await withCleanEnv(async () => {
    const noJob = (() => Promise.resolve(jsonResponse({ message: "nope" }))) as unknown as typeof fetch;
    assertStringIncludes(
      (await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl: noJob })).status,
      "failed:no_job",
    );
    const jobErr = ((url: string) =>
      url.includes("/save/status/")
        ? Promise.resolve(jsonResponse({ status: "error" }))
        : Promise.resolve(jsonResponse({ job_id: "j" }))) as unknown as typeof fetch;
    assertStringIncludes(
      (await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl: jobErr })).status,
      "failed:job_error",
    );
  });
});

Deno.test("submitToWayback: status call failing → submitted (save already succeeded)", async () => {
  await withCleanEnv(async () => {
    const fetchImpl = ((url: string) =>
      url.includes("/save/status/")
        ? Promise.reject(new Error("status flaky"))
        : Promise.resolve(jsonResponse({ job_id: "j" }))) as unknown as typeof fetch;
    const r = await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl });
    assertEquals(r.status, "submitted");

    const status5xx = ((url: string) =>
      url.includes("/save/status/")
        ? Promise.resolve(new Response("busy", { status: 503 }))
        : Promise.resolve(jsonResponse({ job_id: "j" }))) as unknown as typeof fetch;
    assertEquals(
      (await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl: status5xx })).status,
      "submitted",
    );
  });
});

Deno.test("submitToWayback: inline timestamp without original_url uses the requested url", async () => {
  await withCleanEnv(async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse({ timestamp: "20260707120500" }))) as unknown as typeof fetch;
    const r = await submitToWayback("https://x.com/p", CAPTURED_AT, true, { ...KEYS, fetchImpl });
    assertEquals(r.status, "success");
    assertStringIncludes(r.waybackUrl!, "/20260707120500/https://x.com/p");
  });
});

Deno.test("submitToWayback: a save timeout → failed:save_timeout", async () => {
  await withCleanEnv(async () => {
    const fetchImpl = (() => {
      const e = new Error("aborted");
      (e as { name: string }).name = "AbortError";
      return Promise.reject(e);
    }) as unknown as typeof fetch;
    const r = await submitToWayback("https://x.com", CAPTURED_AT, true, { ...KEYS, fetchImpl });
    assertStringIncludes(r.status, "failed:save_timeout");
  });
});

Deno.test("waybackKillSwitchOn engages on any falsy-ish value, not just 'false'", async () => {
  const { waybackKillSwitchOn } = await import("./wayback.ts");
  for (const v of ["false", "False", "FALSE", "0", "no", "off", "disable", "disabled", " off "]) {
    Deno.env.set("SNAPSHOT_WAYBACK_ENABLED", v);
    assert(waybackKillSwitchOn(), `expected kill switch ON for ${JSON.stringify(v)}`);
  }
  for (const v of ["true", "1", "yes", "on", ""]) {
    Deno.env.set("SNAPSHOT_WAYBACK_ENABLED", v);
    assert(!waybackKillSwitchOn(), `expected kill switch OFF for ${JSON.stringify(v)}`);
  }
  Deno.env.delete("SNAPSHOT_WAYBACK_ENABLED");
  assert(!waybackKillSwitchOn()); // unset → default on
});
