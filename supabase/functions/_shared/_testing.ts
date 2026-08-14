/**
 * Test helpers for Deno.test() runs against a configured Supabase project.
 *
 * Usage:
 *   import { createTestUser, functionUrl } from "../_shared/_testing.ts";
 *   const { id, token, cleanup } = await createTestUser();
 *   try { ... } finally { await cleanup(); }
 *
 * Requires env vars:
 *   SUPABASE_URL              e.g. https://<project-ref>.supabase.co
 *   SUPABASE_ANON_KEY         anon publishable key
 *   SUPABASE_SERVICE_ROLE_KEY service-role secret key
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function envAny(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  const joined = names.join(", ");
  throw new Error(`Missing env var ${joined} for tests`);
}

export function getTestingSupabaseUrl(): string {
  return envAny("SUPABASE_URL", "API_URL");
}

export function getTestingAnonKey(): string {
  return envAny("SUPABASE_ANON_KEY", "ANON_KEY", "PUBLISHABLE_KEY");
}

export function getTestingServiceRoleKey(): string {
  return envAny(
    "SUPABASE_SERVICE_ROLE_KEY",
    "SECRET_KEY",
    "SERVICE_ROLE_KEY",
  );
}

export const SUPABASE_URL = getTestingSupabaseUrl();

export function functionUrl(name: string, path = ""): string {
  return `${SUPABASE_URL}/functions/v1/${name}${path}`;
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  cleanup: () => Promise<void>;
}

function serviceClient() {
  return createClient(
    SUPABASE_URL,
    getTestingServiceRoleKey(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function anonClient() {
  return createClient(
    SUPABASE_URL,
    getTestingAnonKey(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function resolveMagicLinkToken(actionLink: string): Promise<string> {
  const response = await fetch(actionLink, {
    method: "GET",
    redirect: "manual",
  });
  try {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("generateLink returned no redirect location");
    }

    const fragment = location.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    const token = params.get("access_token") ?? "";
    if (!token) {
      throw new Error("magiclink redirect returned no access_token");
    }
    return token;
  } finally {
    await response.body?.cancel();
  }
}

export async function createTestUser(): Promise<TestUser> {
  const email = `test-${crypto.randomUUID()}@cojournalist.test`;
  const password = "test-pw-" + crypto.randomUUID();
  const service = serviceClient();
  const anon = anonClient();

  const { data: created, error: createErr } = await service.auth.admin
    .createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createErr) {
    throw new Error(`failed to create test user: ${createErr.message}`);
  }
  const userId = created.user?.id;
  if (!userId) {
    throw new Error("failed to create test user: missing user id");
  }

  const { error: creditsErr } = await service.from("credit_accounts").upsert({
    user_id: userId,
    tier: "free",
    monthly_cap: 100,
    balance: 100,
    entitlement_source: "test-seed",
  }, { onConflict: "user_id" });
  if (creditsErr) {
    throw new Error(`failed to seed credit account: ${creditsErr.message}`);
  }

  const { data: signInData, error: signInErr } = await anon.auth
    .signInWithPassword({
      email,
      password,
    });
  if (signInErr) {
    throw new Error(`failed to sign in test user: ${signInErr.message}`);
  }
  const token = signInData.session?.access_token ?? "";
  if (!token) {
    throw new Error("failed to acquire test user token");
  }

  return {
    id: userId,
    email,
    token,
    cleanup: async () => {
      try {
        await service.auth.admin.deleteUser(userId);
      } catch {
        // Test users are unique and isolated, so cleanup remains best-effort
        // when a local Auth runtime is unavailable during teardown.
      }
    },
  };
}
