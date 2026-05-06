/**
 * Shared utilities for the scout benchmark scripts.
 *
 * Each `benchmark-{web|beat|civic|social}.ts` in this directory invokes
 * the live Supabase Edge Functions end-to-end against a linked project.
 *
 * Required env (usually loaded via `set -a; source .env; set +a`):
 *   Hosted/legacy:
 *     SUPABASE_URL
 *     SUPABASE_SERVICE_ROLE_KEY
 *   Local CLI (`supabase status -o env`):
 *     API_URL
 *     SERVICE_ROLE_KEY
 *
 * Optional:
 *   BENCH_OWNER_EMAIL             email of the test user to own the scouts
 *                                 (default: tom@buriedsignals.com)
 */

function envAny(...names: string[]): string | null {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  return null;
}

function mustEnv(...names: string[]): string {
  const value = envAny(...names);
  if (!value) {
    console.error(`missing env ${names.join(" or ")}. Source .env first:`);
    console.error("  set -a; source .env; set +a");
    Deno.exit(2);
  }
  return value;
}

export interface BenchCtx {
  supabaseUrl: string;
  serviceKey: string;
  apiKey: string;
  ownerEmail: string;
  userId: string;
}

export function assertSafeBenchmarkSupabaseUrl(supabaseUrl: string) {
  const host = new URL(supabaseUrl).hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" ||
    host === "kong" || host.endsWith(".localhost");
  if (!isLocal && Deno.env.get("COJO_BENCHMARK_PROJECT") !== "1") {
    throw new Error(
      "Refusing to run mutating benchmarks against a remote Supabase project without COJO_BENCHMARK_PROJECT=1. " +
        "Use a dedicated benchmark project, or set the flag intentionally.",
    );
  }
}

export function assertLiveBenchmarkAllowed(
  supabaseUrl: string,
  opts: { firecrawl?: boolean } = {},
) {
  if (Deno.env.get("COJO_LIVE_BENCHMARK") !== "1") {
    throw new Error(
      "Refusing to run live benchmarks without COJO_LIVE_BENCHMARK=1.",
    );
  }
  assertSafeBenchmarkSupabaseUrl(supabaseUrl);
  if (
    opts.firecrawl &&
    Deno.env.get("FIRECRAWL_API_KEY") &&
    Deno.env.get("COJO_ALLOW_PROD_FIRECRAWL") !== "1"
  ) {
    throw new Error(
      "Refusing to spend a Firecrawl key without COJO_ALLOW_PROD_FIRECRAWL=1. " +
        "Use a non-production key/project or set the override intentionally.",
    );
  }
}

export async function getCtx(): Promise<BenchCtx> {
  const supabaseUrl = mustEnv("SUPABASE_URL", "API_URL").replace(/\/$/, "");
  assertSafeBenchmarkSupabaseUrl(supabaseUrl);
  const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY");
  const apiKey = envAny(
    "SUPABASE_API_KEY",
    "SUPABASE_ANON_KEY",
    "PUBLISHABLE_KEY",
    "ANON_KEY",
  ) ??
    serviceKey;
  const ownerEmail = Deno.env.get("BENCH_OWNER_EMAIL") ??
    "tom@buriedsignals.com";
  const userId = await resolveUserId(supabaseUrl, serviceKey, ownerEmail);
  return { supabaseUrl, serviceKey, apiKey, ownerEmail, userId };
}

async function resolveUserId(
  supabaseUrl: string,
  serviceKey: string,
  email: string,
): Promise<string> {
  // Short-circuit on an explicit override — handy when GoTrue itself is
  // misbehaving or when running against a project that's seeded a specific
  // test user.
  const override = Deno.env.get("BENCH_OWNER_USER_ID");
  if (override) return override;

  // `GET /auth/v1/admin/users?email=` reliably 500s on Supabase under load
  // ("Database error finding users"; audit 2026-04-21 §4.1.3). Page through
  // the list endpoint instead — the filter lives client-side.
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const url =
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`;
    const res = await fetch(url, {
      headers: {
        apikey: envAny(
          "SUPABASE_API_KEY",
          "SUPABASE_ANON_KEY",
          "PUBLISHABLE_KEY",
          "ANON_KEY",
        ) ??
          serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `user lookup failed ${res.status}: ${detail.slice(0, 300)}`,
      );
    }
    const body = await res.json() as {
      users?: Array<{ id: string; email: string }>;
    };
    const users = body.users ?? [];
    const match = users.find((u) =>
      u.email?.toLowerCase() === email.toLowerCase()
    );
    if (match) return match.id;
    if (users.length < perPage) break; // last page, no match
  }
  throw new Error(
    `no auth.users row for ${email}. Create the user first or set BENCH_OWNER_USER_ID.`,
  );
}

export async function svcFetch(
  ctx: BenchCtx,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  // Some Edge Functions gate on Authorization: Bearer <service_role>, others
  // on X-Service-Key: <INTERNAL_SERVICE_KEY>. We pass both headers so the
  // same helper works against either auth shape.
  const headers: Record<string, string> = {
    apikey: ctx.apiKey,
    Authorization: `Bearer ${ctx.serviceKey}`,
    "Content-Type": "application/json",
  };
  const internalKey = Deno.env.get("INTERNAL_SERVICE_KEY");
  if (internalKey) headers["X-Service-Key"] = internalKey;

  const res = await fetch(`${ctx.supabaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

export async function pgSelectOne<T>(
  ctx: BenchCtx,
  table: string,
  filter: Record<string, string | number>,
  select = "*",
): Promise<T | null> {
  const qs = new URLSearchParams();
  qs.set("select", select);
  for (const [k, v] of Object.entries(filter)) qs.set(k, `eq.${v}`);
  qs.set("limit", "1");
  const res = await fetch(`${ctx.supabaseUrl}/rest/v1/${table}?${qs}`, {
    headers: {
      apikey: ctx.apiKey,
      Authorization: `Bearer ${ctx.serviceKey}`,
      Accept: "application/vnd.pgrst.object+json",
    },
  });
  if (res.status === 406) return null; // no rows
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`pg select failed ${res.status}: ${detail.slice(0, 300)}`);
  }
  return await res.json() as T;
}

export async function pgInsert<T>(
  ctx: BenchCtx,
  table: string,
  row: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${ctx.supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: ctx.apiKey,
      Authorization: `Bearer ${ctx.serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`pg insert failed ${res.status}: ${detail.slice(0, 500)}`);
  }
  const rows = await res.json() as T[];
  return rows[0];
}

export async function pgDelete(
  ctx: BenchCtx,
  table: string,
  filter: Record<string, string>,
): Promise<void> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) qs.set(k, `eq.${v}`);
  const res = await fetch(`${ctx.supabaseUrl}/rest/v1/${table}?${qs}`, {
    method: "DELETE",
    headers: {
      apikey: ctx.apiKey,
      Authorization: `Bearer ${ctx.serviceKey}`,
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`pg delete failed ${res.status}: ${detail.slice(0, 300)}`);
  }
}

export function hr(title: string): void {
  console.log("\n" + "=".repeat(60));
  console.log(title);
  console.log("=".repeat(60));
}

export function ok(label: string, detail = ""): void {
  console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`);
}

export function fail(label: string, detail = ""): void {
  console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
}

export function dur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
