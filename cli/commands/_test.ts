// Deno tests for scout CLI
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert";
import {
  apiFetch,
  configDir,
  configPath,
  hostedSupabaseTargetWarning,
  KNOWN_HOSTED_SUPABASE_PROJECT_REF,
  loadConfig,
  printTable,
  readConfigFile,
  resolvePath,
  unwrapItems,
  writeConfigFile,
} from "../lib/client.ts";
import { VERSION } from "../lib/version.ts";
import { run as runIngest } from "./ingest.ts";
import { run as runScouts } from "./scouts.ts";
import { run as runSnapshots } from "./snapshots.ts";
import { run as runUser } from "./user.ts";

async function withTempHome(
  fn: () => void | Promise<void>,
): Promise<void> {
  const originalHome = Deno.env.get("HOME");
  const tmp = await Deno.makeTempDir({ prefix: "scout-test-" });
  Deno.env.set("HOME", tmp);
  try {
    await fn();
  } finally {
    if (originalHome === undefined) {
      Deno.env.delete("HOME");
    } else {
      Deno.env.set("HOME", originalHome);
    }
    try {
      await Deno.remove(tmp, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

Deno.test("config set + get round-trip", async () => {
  await withTempHome(() => {
    const path = configPath();
    assertStringIncludes(path, "/.scoutpost/config.json");

    // Initially absent
    const empty = readConfigFile();
    assertEquals(empty, {});

    // Write
    writeConfigFile({
      api_url: "https://example.test/api",
      auth_token: "abc123token",
    });

    // Read back
    const cfg = readConfigFile();
    assertEquals(cfg.api_url, "https://example.test/api");
    assertEquals(cfg.auth_token, "abc123token");

    // Overwrite single key
    writeConfigFile({ ...cfg, auth_token: "newtoken" });
    const cfg2 = readConfigFile();
    assertEquals(cfg2.api_url, "https://example.test/api");
    assertEquals(cfg2.auth_token, "newtoken");
  });
});

Deno.test("config write uses private POSIX permissions when modes are available", async () => {
  await withTempHome(() => {
    writeConfigFile({
      api_url: "https://example.test/api",
      api_key: "cj_secret",
    });

    const dirMode = Deno.statSync(configDir()).mode;
    const fileMode = Deno.statSync(configPath()).mode;
    if (dirMode !== null) {
      assertEquals(dirMode & 0o777, 0o700);
    }
    if (fileMode !== null) {
      assertEquals(fileMode & 0o777, 0o600);
    }
  });
});

Deno.test("printTable — header + separators + rows", () => {
  // Capture stdout via console.log spy
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    printTable(
      [
        { id: "1", name: "alpha", active: true },
        { id: "22", name: "beta", active: false },
      ],
      ["id", "name", "active"],
    );
  } finally {
    console.log = origLog;
  }

  // Header line should include all column names
  const header = lines[0];
  assertStringIncludes(header, "id");
  assertStringIncludes(header, "name");
  assertStringIncludes(header, "active");

  // Separator line should be dashes
  const sep = lines[1];
  assert(/^[-\s]+$/.test(sep), `separator row was: ${sep}`);

  // Data rows present
  assertStringIncludes(lines[2], "alpha");
  assertStringIncludes(lines[3], "beta");
  assertStringIncludes(lines[3], "false");

  // Column widths: id column width = max(2, 2) = 2, so "1 " padded
  assert(lines[2].startsWith("1 "), `row: '${lines[2]}'`);
});

Deno.test("printTable — empty rows prints (no rows)", () => {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    printTable([], ["id", "name"]);
  } finally {
    console.log = origLog;
  }
  assertEquals(lines, ["(no rows)"]);
});

Deno.test("resolvePath — bare Supabase URL keeps /functions/v1/ prefix", () => {
  const api = "https://newsroom-project.supabase.co";
  assertEquals(
    resolvePath("/functions/v1/scouts", api),
    "/functions/v1/scouts",
  );
  assertEquals(
    resolvePath("/functions/v1/units/abc?verified=true", api),
    "/functions/v1/units/abc?verified=true",
  );
});

Deno.test("resolvePath — base URL with /functions/v1 strips duplicate prefix", () => {
  const hosted = "https://scoutpost.ai/functions/v1";
  const supabase = "https://newsroom-project.supabase.co/functions/v1";
  assertEquals(resolvePath("/functions/v1/scouts", hosted), "/scouts");
  assertEquals(resolvePath("/functions/v1/scouts", supabase), "/scouts");
});

Deno.test("resolvePath — FastAPI URL strips /functions/v1/ prefix", () => {
  const api = "https://scoutpost.ai/api";
  assertEquals(resolvePath("/functions/v1/scouts", api), "/scouts");
  assertEquals(
    resolvePath("/functions/v1/projects/xyz", api),
    "/projects/xyz",
  );
  assertEquals(
    resolvePath("/functions/v1/units/search", api),
    "/units/search",
  );
});

Deno.test("resolvePath — leaves non-/functions/v1 paths alone on both backends", () => {
  const supa = "https://x.supabase.co/functions/v1";
  const fastapi = "https://scoutpost.ai/api";
  assertEquals(resolvePath("/health", supa), "/health");
  assertEquals(resolvePath("/health", fastapi), "/health");
  assertEquals(resolvePath("health", fastapi), "/health");
});

Deno.test("unwrapItems — accepts Edge items envelopes and legacy data envelopes", () => {
  assertEquals(unwrapItems<{ id: string }>([{ id: "array" }]), [{
    id: "array",
  }]);
  assertEquals(unwrapItems<{ id: string }>({ items: [{ id: "items" }] }), [{
    id: "items",
  }]);
  assertEquals(unwrapItems<{ id: string }>({ data: [{ id: "data" }] }), [{
    id: "data",
  }]);
  assertEquals(unwrapItems<{ id: string }>({ ok: true }), []);
});

Deno.test("VERSION — exports a non-empty string", () => {
  assert(typeof VERSION === "string");
  assert(VERSION.length > 0, "VERSION must not be empty");
});

// ---- api-key / supabase_anon_key auth path ------------------------------

Deno.test("loadConfig — accepts api_key only (no auth_token required)", async () => {
  await withTempHome(() => {
    writeConfigFile({
      api_url: "https://example.test/api",
      api_key: "cj_test_key",
    });
    const cfg = loadConfig();
    assertEquals(cfg.api_url, "https://example.test/api");
    assertEquals(cfg.api_key, "cj_test_key");
    assertEquals(cfg.auth_token, undefined);
  });
});

Deno.test("loadConfig — throws if neither api_key nor auth_token set", async () => {
  await withTempHome(() => {
    writeConfigFile({ api_url: "https://example.test/api" });
    assertThrows(() => loadConfig(), Error, "No credential set");
  });
});

Deno.test("loadConfig — throws if api_url missing", async () => {
  await withTempHome(() => {
    writeConfigFile({ api_key: "cj_test_key" });
    assertThrows(() => loadConfig(), Error, "api_url not set");
  });
});

Deno.test("hosted Supabase target warning only fires inside self-host checkout", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "scout-selfhost-cli-" });
  try {
    await Deno.mkdir(`${tmp}/supabase/functions`, { recursive: true });
    await Deno.mkdir(`${tmp}/frontend`, { recursive: true });
    const warning = hostedSupabaseTargetWarning(
      `https://${KNOWN_HOSTED_SUPABASE_PROJECT_REF}.supabase.co/functions/v1`,
      tmp,
    );
    assertStringIncludes(warning ?? "", "self-host checkout");
    assertEquals(
      hostedSupabaseTargetWarning(
        "https://newsroom-project.supabase.co/functions/v1",
        tmp,
      ),
      null,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("apiFetch — uses api_key over auth_token, sends apikey header for Supabase", async () => {
  await withTempHome(async () => {
    // Convention: api_url is the bare Supabase host. The /functions/v1/ prefix
    // lives in the path so resolvePath can strip it for the FastAPI backend.
    writeConfigFile({
      api_url: "https://x.supabase.co",
      auth_token: "legacy_token_should_be_ignored",
      api_key: "cj_preferred",
      supabase_anon_key: "anon_test_key",
    });

    let observed:
      | { url: string; auth: string | null; apikey: string | null }
      | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      observed = {
        url,
        auth: headers.get("Authorization"),
        apikey: headers.get("apikey"),
      };
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    try {
      await apiFetch("/functions/v1/units?limit=1");
    } finally {
      globalThis.fetch = origFetch;
    }

    assert(observed !== null, "fetch was not called");
    const obs = observed as unknown as {
      url: string;
      auth: string;
      apikey: string;
    };
    assertStringIncludes(obs.url, "x.supabase.co/functions/v1/units");
    assertEquals(obs.auth, "Bearer cj_preferred");
    assertEquals(obs.apikey, "anon_test_key");
  });
});

Deno.test("apiFetch — sends apikey header for hosted Edge Functions when configured", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://scoutpost.ai/functions/v1",
      api_key: "cj_preferred",
      supabase_anon_key: "anon_test_key",
    });

    let observed:
      | { url: string; auth: string | null; apikey: string | null }
      | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      observed = {
        url,
        auth: headers.get("Authorization"),
        apikey: headers.get("apikey"),
      };
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    try {
      await apiFetch("/functions/v1/units?limit=1");
    } finally {
      globalThis.fetch = origFetch;
    }

    assert(observed !== null, "fetch was not called");
    const obs = observed as unknown as {
      url: string;
      auth: string;
      apikey: string;
    };
    assertStringIncludes(obs.url, "scoutpost.ai/functions/v1/units");
    assertEquals(obs.auth, "Bearer cj_preferred");
    assertEquals(obs.apikey, "anon_test_key");
  });
});

Deno.test("user me — fetches /user/me and prints account state", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://x.supabase.co",
      api_key: "cj_user",
      supabase_anon_key: "anon_test_key",
    });

    let observedUrl = "";
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    const lines: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      observedUrl = input instanceof Request ? input.url : String(input);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            user_id: "user-1",
            tier: "team",
            org_id: "org-1",
            team: { org_name: "MuckRock Staff" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };

    try {
      await runUser(["me"]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assertStringIncludes(observedUrl, "x.supabase.co/functions/v1/user/me");
    assertStringIncludes(lines.join("\n"), '"tier": "team"');
    assertStringIncludes(lines.join("\n"), "MuckRock Staff");
  });
});

Deno.test("apiFetch — falls back to auth_token when api_key absent, omits apikey header for non-Supabase", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://scoutpost.ai/api",
      auth_token: "cj_legacy",
    });

    let observed:
      | { url: string; auth: string | null; apikey: string | null }
      | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      observed = {
        url,
        auth: headers.get("Authorization"),
        apikey: headers.get("apikey"),
      };
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    try {
      await apiFetch("/functions/v1/units?limit=1");
    } finally {
      globalThis.fetch = origFetch;
    }

    assert(observed !== null);
    const obs = observed as unknown as {
      url: string;
      auth: string;
      apikey: string | null;
    };
    assertStringIncludes(obs.url, "scoutpost.ai/api/units");
    assertEquals(obs.auth, "Bearer cj_legacy");
    assertEquals(obs.apikey, null);
  });
});

Deno.test("apiFetch — surfaces non-2xx as a thrown Error", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://x.supabase.co",
      api_key: "cj_test",
      supabase_anon_key: "anon",
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "nope" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;

    try {
      await assertRejects(
        () => apiFetch("/functions/v1/units"),
        Error,
        "401",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

Deno.test("apiFetch — non-string error bodies serialize, not '[object Object]'", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://x.supabase.co",
      api_key: "cj_test",
      supabase_anon_key: "anon",
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "boom", detail: "rpc failed" } }),
          {
            status: 502,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )) as typeof fetch;

    try {
      const err = await assertRejects(
        () => apiFetch("/functions/v1/scouts"),
        Error,
        "502",
      );
      assertStringIncludes(err.message, "boom");
      assertStringIncludes(err.message, "rpc failed");
      assert(
        !err.message.includes("[object Object]"),
        `expected error to be serialized, got: ${err.message}`,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

Deno.test("scouts add — forwards civic, schedule, and source-discovery fields", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://scoutpost.ai/functions/v1",
      api_key: "cj_test",
      supabase_anon_key: "anon",
    });

    let observedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    globalThis.fetch =
      ((_input: string | URL | Request, init?: RequestInit) => {
        observedBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          new Response(JSON.stringify({ id: "scout_1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as typeof fetch;
    console.log = () => {};

    try {
      await runScouts([
        "add",
        "--name",
        "Council housing",
        "--type",
        "civic",
        "--criteria",
        "housing votes",
        "--topic",
        "housing, council",
        "--description",
        "Watch council housing decisions.",
        "--root-domain",
        "example.gov",
        "--tracked-urls",
        "https://example.gov/minutes,https://example.gov/agendas",
        "--regularity",
        "monthly",
        "--time",
        "08:00",
        "--day",
        "1",
        "--priority-sources",
        "minutes.example.gov,agenda.example.gov",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assert(observedBody !== null, "fetch was not called");
    const body = observedBody as Record<string, unknown>;
    assertEquals(body.name, "Council housing");
    assertEquals(body.type, "civic");
    assertEquals(body.criteria, "housing votes");
    assertEquals(body.topic, "housing, council");
    assertEquals(body.description, "Watch council housing decisions.");
    assertEquals(body.root_domain, "example.gov");
    assertEquals(body.tracked_urls, [
      "https://example.gov/minutes",
      "https://example.gov/agendas",
    ]);
    assertEquals(body.regularity, "monthly");
    assertEquals(body.time, "08:00");
    assertEquals(body.day_number, 1);
    assertEquals(body.priority_sources, [
      "minutes.example.gov",
      "agenda.example.gov",
    ]);
  });
});

Deno.test("scouts add — forwards topic for scheduled web scouts", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://scoutpost.ai/functions/v1",
      api_key: "cj_test",
      supabase_anon_key: "anon",
    });

    let observedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    globalThis.fetch =
      ((_input: string | URL | Request, init?: RequestInit) => {
        observedBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          new Response(JSON.stringify({ id: "scout_1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as typeof fetch;
    console.log = () => {};

    try {
      await runScouts([
        "add",
        "--name",
        "Scheduled page baseline",
        "--type",
        "web",
        "--url",
        "https://example.com",
        "--topic",
        "baseline-fixture",
        "--criteria",
        "Track visible page changes.",
        "--cron",
        "0 23 * * *",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assert(observedBody !== null, "fetch was not called");
    const body = observedBody as Record<string, unknown>;
    assertEquals(body.name, "Scheduled page baseline");
    assertEquals(body.type, "web");
    assertEquals(body.url, "https://example.com");
    assertEquals(body.topic, "baseline-fixture");
    assertEquals(body.criteria, "Track visible page changes.");
    assertEquals(body.schedule_cron, "0 23 * * *");
  });
});

Deno.test("scouts add — Fleet Scout requires a circle and folds criteria into config", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://scoutpost.ai/functions/v1",
      api_key: "cj_test",
      supabase_anon_key: "anon",
    });

    let observedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    globalThis.fetch =
      ((_input: string | URL | Request, init?: RequestInit) => {
        observedBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          new Response(JSON.stringify({ id: "scout_1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as typeof fetch;
    console.log = () => {};

    try {
      await runScouts([
        "add",
        "--name",
        "Hormuz aircraft",
        "--type",
        "transport",
        "--mode",
        "aircraft",
        "--center-lat",
        "26.55",
        "--center-lon",
        "56.25",
        "--radius-km",
        "40.5",
        "--area-name",
        "Strait of Hormuz",
        "--watch-ids",
        "4ca123,ae01ce",
        "--categories",
        "military,government",
        "--criteria",
        "military transport jets",
        "--regularity",
        "3h",
        "--time",
        "09:00",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assert(observedBody !== null, "fetch was not called");
    const body = observedBody as Record<string, unknown>;
    assertEquals(body.type, "transport");
    assertEquals(body.regularity, "3h");
    // Transport criteria travels inside config, never as a top-level field.
    assertEquals("criteria" in body, false);
    const config = body.config as Record<string, unknown>;
    assertEquals(config.mode, "aircraft");
    assertEquals(config.geofence, { center: { lat: 26.55, lon: 56.25 }, radius_km: 40.5, display_name: "Strait of Hormuz" });
    assertEquals(config.watch_ids, ["4ca123", "ae01ce"]);
    assertEquals(config.categories, ["military", "government"]);
    assertEquals(config.criteria, "military transport jets");
  });
});

Deno.test("scouts add — Fleet Scout aircraft carries its required entry area", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://scoutpost.ai/functions/v1",
      api_key: "cj_test",
      supabase_anon_key: "anon",
    });

    let observedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    globalThis.fetch =
      ((_input: string | URL | Request, init?: RequestInit) => {
        observedBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          new Response(JSON.stringify({ id: "scout_4" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as typeof fetch;
    console.log = () => {};

    try {
      await runScouts([
        "add",
        "--name",
        "Tail number watch",
        "--type",
        "transport",
        "--mode",
        "aircraft",
        "--watch-ids",
        "abc123,def456",
        "--center-lat",
        "47.37",
        "--center-lon",
        "8.54",
        "--radius-km",
        "25",
        "--regularity",
        "12h",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assert(observedBody !== null, "fetch was not called");
    const body = observedBody as Record<string, unknown>;
    const config = body.config as Record<string, unknown>;
    assertEquals(config.mode, "aircraft");
    assertEquals(config.watch_ids, ["abc123", "def456"]);
    assertEquals(config.geofence, { center: { lat: 47.37, lon: 8.54 }, radius_km: 25 });
    assertEquals(body.time, "09:00");
  });
});

Deno.test("scouts add — transport vessel: decimal center/radius survive (no parseInt truncation)", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://scoutpost.ai/functions/v1",
      api_key: "cj_test",
      supabase_anon_key: "anon",
    });

    let observedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    globalThis.fetch =
      ((_input: string | URL | Request, init?: RequestInit) => {
        observedBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          new Response(JSON.stringify({ id: "scout_2" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as typeof fetch;
    console.log = () => {};

    try {
      await runScouts([
        "add",
        "--name",
        "Hormuz vessels",
        "--type",
        "transport",
        "--mode",
        "vessel",
        "--center-lat",
        "26.55",
        "--center-lon",
        "56.25",
        "--radius-km",
        "40.5",
        "--watch-ids",
        "636019825",
        "--regularity",
        "6h",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assert(observedBody !== null, "fetch was not called");
    const body = observedBody as Record<string, unknown>;
    assertEquals(body.regularity, "6h");
    // No --time given: CLI defaults to 09:00 so the backend can synthesize a
    // cron; without it the scout would be created inactive and never run.
    assertEquals(body.time, "09:00");
    const config = body.config as Record<string, unknown>;
    assertEquals(config.mode, "vessel");
    assertEquals(config.geofence, {
      center: { lat: 26.55, lon: 56.25 },
      radius_km: 40.5,
    });
  });
});

Deno.test("scouts add — Fleet Scout satellite: watch IDs + entry area, daily schedule", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://scoutpost.ai/functions/v1",
      api_key: "cj_test",
      supabase_anon_key: "anon",
    });

    let observedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    globalThis.fetch =
      ((_input: string | URL | Request, init?: RequestInit) => {
        observedBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          new Response(JSON.stringify({ id: "scout_3" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as typeof fetch;
    console.log = () => {};

    try {
      await runScouts([
        "add",
        "--name",
        "ISS overpass",
        "--type",
        "transport",
        "--mode",
        "satellite",
        "--center-lat",
        "26.55",
        "--center-lon",
        "56.25",
        "--radius-km",
        "40",
        "--watch-ids",
        "25544,48274",
        "--regularity",
        "daily",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assert(observedBody !== null, "fetch was not called");
    const body = observedBody as Record<string, unknown>;
    assertEquals(body.regularity, "daily");
    assertEquals(body.time, "09:00");
    const config = body.config as Record<string, unknown>;
    assertEquals(config.mode, "satellite");
    assertEquals(config.watch_ids, ["25544", "48274"]);
    assertEquals(config.geofence, { center: { lat: 26.55, lon: 56.25 }, radius_km: 40 });
  });
});

Deno.test("ingest text — sends API-compatible text field", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://scoutpost.ai/functions/v1",
      api_key: "cj_test",
      supabase_anon_key: "anon",
    });

    const file = await Deno.makeTempFile({
      prefix: "scout-ingest-",
      suffix: ".txt",
    });
    await Deno.writeTextFile(
      file,
      "The city council approved a housing plan on 2026-04-27 with a documented implementation timeline.",
    );

    let observedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    globalThis.fetch =
      ((_input: string | URL | Request, init?: RequestInit) => {
        observedBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          new Response(
            JSON.stringify({ ingest_id: "ingest_1", units: [] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }) as typeof fetch;
    console.log = () => {};

    try {
      await runIngest([
        "text",
        "--title",
        "Council note",
        "--criteria",
        "housing plan",
        "--file",
        file,
      ]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
      await Deno.remove(file);
    }

    assert(observedBody !== null, "fetch was not called");
    const body = observedBody as Record<string, unknown>;
    assertEquals(body.kind, "text");
    assertEquals(body.title, "Council note");
    assertEquals(body.criteria, "housing plan");
    assertEquals(typeof body.text, "string");
    assertEquals("content" in body, false);
  });
});

// ---- Page Archive: snapshots command + archive toggle parity --------------

Deno.test("snapshots list — GETs /snapshots and prints a row per snapshot", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://x.supabase.co",
      api_key: "cj_snap",
      supabase_anon_key: "anon_test_key",
    });

    let observedUrl = "";
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    const lines: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      observedUrl = input instanceof Request ? input.url : String(input);
      // Match the deployed snapshots EF envelope (jsonPaginated → {items, pagination}).
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{
              id: "snap-1",
              scout_id: "scout-1",
              capture_kind: "change",
              fidelity: "full",
              captured_at: "2026-07-08T00:00:00Z",
              artifacts: ["mhtml", "screenshot", "markdown"],
              trust: { tsa_status: "ok", wayback_status: "success" },
            }],
            pagination: { total: 1, offset: 0, limit: 50, has_more: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));

    try {
      await runSnapshots(["list", "--scout", "scout-1"]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assertStringIncludes(observedUrl, "/functions/v1/snapshots?scout_id=scout-1");
    assertStringIncludes(lines.join("\n"), "snap-1");
    assertStringIncludes(lines.join("\n"), "mhtml,screenshot,markdown");
  });
});

Deno.test("snapshots url — POSTs {artifact} to /:id/url and prints the signed URL", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://x.supabase.co",
      api_key: "cj_snap",
      supabase_anon_key: "anon_test_key",
    });

    let observedUrl = "";
    let observedBody: Record<string, unknown> | null = null;
    let observedMethod = "";
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    const lines: string[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      observedUrl = input instanceof Request ? input.url : String(input);
      observedMethod = init?.method ?? "GET";
      observedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            url: "https://x.supabase.co/storage/v1/object/sign/page-snapshots/abc?token=t",
            artifact: "mhtml",
            content_type: "multipart/related",
            expires_in: 300,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));

    try {
      await runSnapshots(["url", "snap-1", "--artifact", "mhtml"]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assertStringIncludes(observedUrl, "/functions/v1/snapshots/snap-1/url");
    assertEquals(observedMethod, "POST");
    assertEquals((observedBody as unknown as { artifact: string }).artifact, "mhtml");
    assertStringIncludes(lines.join("\n"), "storage/v1/object/sign/page-snapshots");
  });
});

Deno.test("snapshots download — signs then writes the artifact bytes to disk", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://x.supabase.co",
      api_key: "cj_snap",
      supabase_anon_key: "anon_test_key",
    });

    const out = await Deno.makeTempFile({ suffix: ".mhtml" });
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/snapshots/") && url.endsWith("/url")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              url: "https://signed.example/object?token=t",
              artifact: "mhtml",
              content_type: "multipart/related",
              expires_in: 300,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      // The signed-URL fetch → raw artifact bytes.
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
      );
    }) as typeof fetch;
    console.log = () => {};

    try {
      await runSnapshots(["download", "snap-1", "--artifact", "mhtml", "--out", out]);
      const written = await Deno.readFile(out);
      assertEquals([...written], [1, 2, 3, 4]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
      await Deno.remove(out);
    }
  });
});

Deno.test("scouts add — --archive-enabled/--wayback-enabled reach the create body", async () => {
  await withTempHome(async () => {
    writeConfigFile({
      api_url: "https://x.supabase.co",
      api_key: "cj_snap",
      supabase_anon_key: "anon_test_key",
    });

    let observedBody: Record<string, unknown> | null = null;
    const origFetch = globalThis.fetch;
    const origLog = console.log;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      observedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return Promise.resolve(
        new Response(JSON.stringify({ id: "scout-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;
    console.log = () => {};

    try {
      await runScouts([
        "add",
        "--name",
        "Evidence page",
        "--type",
        "web",
        "--url",
        "https://example.com",
        "--topic",
        "evidence",
        "--archive-enabled",
        "true",
        "--wayback-enabled",
        "false",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
    }

    assert(observedBody !== null, "fetch was not called");
    const body = observedBody as Record<string, unknown>;
    assertEquals(body.archive_enabled, true);
    assertEquals(body.wayback_enabled, false);
  });
});
