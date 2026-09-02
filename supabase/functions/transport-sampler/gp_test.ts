import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { GpRefreshFailure, refreshGpCache } from "./gp.ts";
import type { SupabaseClient } from "../_shared/supabase.ts";

interface FakeState {
  enabled: boolean;
  halted: boolean;
  leaseToken: string | null;
  acquireError?: string;
  insertError?: string;
  rows: Array<Record<string, unknown>>;
  haltReason: string | null;
  haltStatus: number | null;
  haltBody: string | null;
  completedGeneration: string | null;
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    enabled: true,
    halted: false,
    leaseToken: null,
    rows: [],
    haltReason: null,
    haltStatus: null,
    haltBody: null,
    completedGeneration: null,
    ...overrides,
  };
}

function fakeSvc(control: FakeState): SupabaseClient {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "acquire_transport_gp_refresh_lease") {
        if (control.acquireError) {
          return { data: null, error: { message: control.acquireError } };
        }
        let reason = "acquired";
        let acquired = true;
        if (!control.enabled) {
          reason = "disabled";
          acquired = false;
        } else if (control.halted) {
          reason = "halted";
          acquired = false;
        } else if (control.leaseToken) {
          reason = "busy";
          acquired = false;
        } else {
          control.leaseToken = String(args.p_lease_token);
        }
        return {
          data: [{
            acquired,
            reason,
            current_generation_id: null,
            current_generation_fetched_at: null,
          }],
          error: null,
        };
      }
      if (name === "halt_transport_gp_refresh") {
        const matches = control.leaseToken === args.p_lease_token;
        if (matches) {
          control.halted = true;
          control.haltReason = String(args.p_reason);
          control.haltStatus = args.p_http_status as number | null;
          control.haltBody = args.p_error_body as string | null;
          control.leaseToken = null;
        }
        return { data: matches, error: null };
      }
      if (name === "complete_transport_gp_refresh") {
        if (control.leaseToken !== args.p_lease_token) {
          return { data: null, error: { message: "lease lost" } };
        }
        control.completedGeneration = String(args.p_generation_id);
        control.leaseToken = null;
        return {
          data: control.rows.filter((row) =>
            row.generation_id === args.p_generation_id
          ).length,
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from(table: string) {
      if (table !== "transport_gp_catalog") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        async insert(rows: Array<Record<string, unknown>>) {
          if (control.insertError) {
            return { error: { message: control.insertError } };
          }
          control.rows.push(...rows);
          return { error: null };
        },
        delete() {
          return {
            async eq(_column: string, generationId: string) {
              control.rows = control.rows.filter((row) =>
                row.generation_id !== generationId
              );
              return { error: null };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

function catalogResponse(): Response {
  return new Response(
    JSON.stringify([
      {
        NORAD_CAT_ID: 25544,
        OBJECT_NAME: "ISS",
        EPOCH: "2026-09-01T00:00:00Z",
      },
      { NORAD_CAT_ID: "not-a-number", OBJECT_NAME: "junk" },
      { NORAD_CAT_ID: 39084, OBJECT_NAME: "LANDSAT 8" },
    ]),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

Deno.test("disabled GP refresh performs no provider request", async () => {
  const control = state({ enabled: false });
  let fetches = 0;
  const result = await refreshGpCache(fakeSvc(control), {
    contactEmail: "ops@example.com",
    fetch: () => {
      fetches++;
      return Promise.resolve(catalogResponse());
    },
  });
  assertEquals(result, { status: "disabled", cached: 0 });
  assertEquals(fetches, 0);
});

Deno.test("approved GP refresh identifies its operator and publishes once", async () => {
  const control = state();
  let requestUrl = "";
  let requestHeaders = new Headers();
  const result = await refreshGpCache(fakeSvc(control), {
    contactEmail: "ops@example.com",
    fetch: (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return Promise.resolve(catalogResponse());
    },
  });
  assertEquals(result, { status: "updated", cached: 2 });
  assert(requestUrl.includes("GROUP=active"));
  assertEquals(
    requestHeaders.get("user-agent"),
    "Scoutpost/1.0 (+mailto:ops@example.com)",
  );
  assertEquals(requestHeaders.get("accept"), "application/json");
  assertEquals(control.rows.length, 2);
  assertEquals(
    control.completedGeneration,
    control.rows[0].generation_id as string,
  );
});

Deno.test("301 halts without following the redirect", async () => {
  const control = state();
  let fetches = 0;
  await assertRejects(
    () =>
      refreshGpCache(fakeSvc(control), {
        contactEmail: "ops@example.com",
        fetch: (_input, init) => {
          fetches++;
          assertEquals(init?.redirect, "manual");
          return Promise.resolve(
            new Response("Use the canonical CelesTrak URL", {
              status: 301,
              headers: {
                location:
                  "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json",
              },
            }),
          );
        },
      }),
    GpRefreshFailure,
    "CelesTrak responded 301",
  );
  assertEquals(fetches, 1);
  assertEquals(control.haltReason, "celestrak_http_301");
  assertEquals(control.haltStatus, 301);
  assertEquals(control.haltBody, "Use the canonical CelesTrak URL");
});

Deno.test("503 halts later refreshes and preserves bounded diagnostics", async () => {
  const control = state();
  let fetches = 0;
  const options = {
    contactEmail: "ops@example.com",
    fetch: () => {
      fetches++;
      return Promise.resolve(
        new Response("CelesTrak overloaded", { status: 503 }),
      );
    },
  };
  await assertRejects(
    () => refreshGpCache(fakeSvc(control), options),
    GpRefreshFailure,
    "CelesTrak responded 503",
  );
  assertEquals(control.haltReason, "celestrak_http_503");
  assertEquals(control.haltStatus, 503);
  assertEquals(control.haltBody, "CelesTrak overloaded");
  assertEquals(
    await refreshGpCache(fakeSvc(control), options),
    { status: "halted", cached: 0 },
  );
  assertEquals(fetches, 1);
});

Deno.test("concurrent refreshes coalesce behind the database lease", async () => {
  const control = state();
  let fetches = 0;
  let resolveFetch!: (response: Response) => void;
  const pendingResponse = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const options = {
    contactEmail: "ops@example.com",
    fetch: () => {
      fetches++;
      return pendingResponse;
    },
  };
  const first = refreshGpCache(fakeSvc(control), options);
  const second = await refreshGpCache(fakeSvc(control), options);
  assertEquals(second, { status: "busy", cached: 0 });
  resolveFetch(catalogResponse());
  assertEquals(await first, { status: "updated", cached: 2 });
  assertEquals(fetches, 1);
});

Deno.test("refresh control errors fail closed before fetch", async () => {
  const control = state({ acquireError: "database unavailable" });
  let fetches = 0;
  await assertRejects(
    () =>
      refreshGpCache(fakeSvc(control), {
        contactEmail: "ops@example.com",
        fetch: () => {
          fetches++;
          return Promise.resolve(catalogResponse());
        },
      }),
    GpRefreshFailure,
    "GP refresh control unavailable",
  );
  assertEquals(fetches, 0);
});

Deno.test("missing contact and timeout both halt provider access", async () => {
  const missingContact = state();
  let fetches = 0;
  await assertRejects(
    () =>
      refreshGpCache(fakeSvc(missingContact), {
        contactEmail: "invalid",
        fetch: () => {
          fetches++;
          return Promise.resolve(catalogResponse());
        },
      }),
    GpRefreshFailure,
    "CELESTRAK_CONTACT_EMAIL",
  );
  assertEquals(fetches, 0);
  assertEquals(missingContact.haltReason, "celestrak_contact_missing");

  const timeout = state();
  await assertRejects(
    () =>
      refreshGpCache(fakeSvc(timeout), {
        contactEmail: "ops@example.com",
        timeoutMs: 1,
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
            );
          }),
      }),
    GpRefreshFailure,
    "timed out",
  );
  assertEquals(timeout.haltReason, "celestrak_timeout");
});

Deno.test("catalog staging failure never publishes a partial generation", async () => {
  const control = state({ insertError: "disk full" });
  await assertRejects(
    () =>
      refreshGpCache(fakeSvc(control), {
        contactEmail: "ops@example.com",
        fetch: () => Promise.resolve(catalogResponse()),
      }),
    GpRefreshFailure,
    "catalog staging failed",
  );
  assertEquals(control.completedGeneration, null);
  assertEquals(control.rows, []);
  assertEquals(control.haltReason, "gp_catalog_write_failed");
});
