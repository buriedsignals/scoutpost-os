/**
 * Unit tests for MuckRock entitlement → credit-pool resolution.
 *
 * Covers the team-pool invariants exercised at the MuckRock OAuth callback
 * (auth-muckrock EF, ticket #20) and the webhook event processor
 * (billing-webhook EF, ticket #21):
 *
 *   1. Tier resolution — highest-of-all across orgs; team beats pro beats free.
 *   2. Admin override — free user with email in ADMIN_EMAILS → pro.
 *   3. First-time team signup — orgs + credit_accounts(pool=cap) + org_members.
 *   4. Second team member — does NOT clobber the existing pool balance.
 *   5. Individual downgrade — balance capped at new cap; never raised.
 *   6. Team topup — calls topup_team_credits RPC, not a raw UPDATE.
 *   7. Cancel team org — reverts members to tier_before_team, caps balance.
 *
 * The tests use a hand-rolled `FakeSupabase` that records every call so
 * assertions can introspect state transitions without a live DB. This keeps
 * the suite runnable via `deno test` without `supabase start`.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { MuckrockOrg, MuckrockUserInfo } from "./muckrock.ts";
import {
  applyAdminOverride,
  applyTeamOrgTopup,
  applyUserEvent,
  cancelTeamOrg,
  DEFAULT_CAPS,
  isCojournalistTeamEntitlement,
  resolveTier,
  upsertUserCredits,
} from "./entitlements.ts";

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

interface Row extends Record<string, unknown> {}

interface Filter {
  kind: "eq" | "gt" | "in";
  col: string;
  val: unknown;
}

interface TableState {
  rows: Row[];
}

class FakeSupabase {
  tables: Record<string, TableState> = {
    orgs: { rows: [] },
    org_members: { rows: [] },
    credit_accounts: { rows: [] },
    user_preferences: { rows: [] },
  };
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  from(table: string) {
    if (!this.tables[table]) this.tables[table] = { rows: [] };
    return new FakeQuery(this.tables[table]);
  }

  async rpc(name: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    // Simulate topup_team_credits: update monthly_cap + update_on on the
    // matching org's credit pool without touching balance.
    if (name === "topup_team_credits") {
      const orgId = args.p_org_id as string;
      const newCap = args.p_new_cap as number;
      const updateOn = args.p_update_on as string | null;
      for (const row of this.tables.credit_accounts.rows) {
        if (row.org_id === orgId) {
          row.monthly_cap = newCap;
          if (updateOn !== undefined) row.update_on = updateOn;
        }
      }
    }
    return { data: null, error: null };
  }
}

type Op = "select" | "update" | "delete";

class FakeQuery {
  private state: TableState;
  private filters: Filter[] = [];
  private op: Op = "select";
  private patch: Row | null = null;
  private maybeSingleMode = false;

  constructor(state: TableState) {
    this.state = state;
  }

  select(_cols?: string) {
    this.op = "select";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }
  gt(col: string, val: unknown) {
    this.filters.push({ kind: "gt", col, val });
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push({ kind: "in", col, val: vals });
    return this;
  }
  maybeSingle() {
    this.maybeSingleMode = true;
    return this.execRead();
  }

  async insert(row: Row | Row[]) {
    const rows = Array.isArray(row) ? row : [row];
    this.state.rows.push(...rows);
    return { data: rows, error: null };
  }
  async upsert(row: Row | Row[], opts?: { onConflict?: string }) {
    const rows = Array.isArray(row) ? row : [row];
    const keys = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
    for (const r of rows) {
      const existing = this.state.rows.find((existing) =>
        keys.every((k) => existing[k] === r[k])
      );
      if (existing) Object.assign(existing, r);
      else this.state.rows.push(r);
    }
    return { data: rows, error: null };
  }

  // `update` / `delete` return the same builder so callers can chain `.eq(...)`
  // as the terminal. supabase-js resolves the chain with `await`.
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }

  private match(): Row[] {
    return this.state.rows.filter((row) => {
      for (const f of this.filters) {
        if (f.kind === "eq" && row[f.col] !== f.val) return false;
        if (f.kind === "gt" && !((row[f.col] as number) > (f.val as number))) {
          return false;
        }
        if (f.kind === "in" && !(f.val as unknown[]).includes(row[f.col])) {
          return false;
        }
      }
      return true;
    });
  }
  private execRead(): Promise<{ data: Row | Row[] | null; error: null }> {
    const matched = this.match();
    if (this.maybeSingleMode) {
      return Promise.resolve({ data: matched[0] ?? null, error: null });
    }
    return Promise.resolve({ data: matched, error: null });
  }
  private exec(): { data: Row[]; error: null } {
    const matched = this.match();
    if (this.op === "update" && this.patch) {
      for (const row of matched) Object.assign(row, this.patch);
    } else if (this.op === "delete") {
      this.state.rows = this.state.rows.filter((r) => !matched.includes(r));
    }
    return { data: matched, error: null };
  }
  // Resolves the chain when awaited (terminal eq/gt/in after update/delete/select).
  then<T>(resolve: (v: { data: Row[]; error: null }) => T) {
    return Promise.resolve(this.exec()).then(resolve);
  }
}

function svc(): SupabaseClient {
  // The cast is safe — every method used by entitlements.ts is implemented on FakeSupabase.
  return new FakeSupabase() as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";
const TEAM_ORG = "11111111-1111-1111-1111-111111111111";
const STAFF_ORG = "22222222-2222-2222-2222-222222222222";

function teamOrg(cap = 8000, updateOn = "2026-05-01"): MuckrockOrg {
  return {
    uuid: TEAM_ORG,
    name: "Team Tribune",
    individual: false,
    entitlements: [
      {
        name: "cojournalist-team",
        resources: { monthly_credits: cap },
        update_on: updateOn,
      },
    ],
  };
}

function muckrockStaffOrg(cap = 5000, updateOn = "2026-05-14"): MuckrockOrg {
  return {
    uuid: STAFF_ORG,
    name: "MuckRock Staff",
    individual: false,
    entitlements: [
      {
        name: "coJournalist Team",
        slug: "cojournalist-team",
        resources: { monthly_credits: cap },
        update_on: updateOn,
      },
    ],
  };
}

function freeUserinfo(uuid: string, email: string): MuckrockUserInfo {
  return { uuid, email, organizations: [] };
}

function teamUserinfo(
  uuid: string,
  email: string,
  org = teamOrg(),
): MuckrockUserInfo {
  return { uuid, email, organizations: [org] };
}

// ---------------------------------------------------------------------------
// 1. Tier resolution
// ---------------------------------------------------------------------------

Deno.test("resolveTier — highest-of-all across orgs", () => {
  const orgs: MuckrockOrg[] = [
    {
      uuid: "org-free",
      entitlements: [{
        name: "cojournalist-pro",
        resources: { monthly_credits: 1500 },
      }],
    },
    {
      uuid: TEAM_ORG,
      entitlements: [{
        name: "cojournalist-team",
        resources: { monthly_credits: 8000 },
        update_on: "2026-05-01",
      }],
    },
  ];
  const r = resolveTier(orgs);
  assertEquals(r.tier, "team");
  assertEquals(r.monthlyCap, 8000);
  assertEquals(r.orgUuid, TEAM_ORG);
  assertEquals(r.entitlementSource, "cojournalist-team");
});

Deno.test("resolveTier — MuckRock Staff display-name entitlement resolves as team", () => {
  const r = resolveTier([muckrockStaffOrg()]);
  assertEquals(r.tier, "team");
  assertEquals(r.monthlyCap, 5000);
  assertEquals(r.orgUuid, STAFF_ORG);
  assertEquals(r.updateOn, "2026-05-14");
  assertEquals(r.entitlementSource, "cojournalist-team");
});

Deno.test("isCojournalistTeamEntitlement — accepts display name without slug", () => {
  assertEquals(
    isCojournalistTeamEntitlement({ name: "coJournalist Team" }),
    true,
  );
  assertEquals(
    isCojournalistTeamEntitlement({ name: "cojournalist_team" }),
    true,
  );
  assertEquals(
    isCojournalistTeamEntitlement({
      name: "Professional",
      slug: "professional",
    }),
    false,
  );
});

Deno.test("resolveTier — no entitlements → free", () => {
  const r = resolveTier([]);
  assertEquals(r.tier, "free");
  assertEquals(r.monthlyCap, DEFAULT_CAPS.free);
  assertEquals(r.orgUuid, null);
});

// ---------------------------------------------------------------------------
// 2. Admin override
// ---------------------------------------------------------------------------

Deno.test("applyAdminOverride — free user with admin email → pro", () => {
  Deno.env.set("ADMIN_EMAILS", "admin@example.com, ops@example.com");
  try {
    const base = resolveTier([]);
    const r = applyAdminOverride("admin@example.com", base);
    assertEquals(r.tier, "pro");
    assertEquals(r.monthlyCap, DEFAULT_CAPS.pro);
    assertEquals(r.entitlementSource, "admin-override");
  } finally {
    Deno.env.delete("ADMIN_EMAILS");
  }
});

Deno.test("applyAdminOverride — team user with admin email → stays team", () => {
  Deno.env.set("ADMIN_EMAILS", "admin@example.com");
  try {
    const base = resolveTier([teamOrg()]);
    const r = applyAdminOverride("admin@example.com", base);
    assertEquals(r.tier, "team");
    assertEquals(r.monthlyCap, 8000);
  } finally {
    Deno.env.delete("ADMIN_EMAILS");
  }
});

// ---------------------------------------------------------------------------
// 3. First-time team signup
// ---------------------------------------------------------------------------

Deno.test("applyUserEvent — first team user seeds pool at cap", async () => {
  const s = new FakeSupabase();
  await applyUserEvent(
    s as unknown as SupabaseClient,
    teamUserinfo(USER_A, "a@example.com"),
  );

  assertEquals(s.tables.orgs.rows.length, 1);
  assertEquals(s.tables.orgs.rows[0].id, TEAM_ORG);
  assertEquals(s.tables.orgs.rows[0].is_individual, false);

  const pool = s.tables.credit_accounts.rows.find((r) => r.org_id === TEAM_ORG);
  assertEquals(pool?.balance, 8000);
  assertEquals(pool?.monthly_cap, 8000);
  assertEquals(pool?.entitlement_source, "cojournalist-team");

  const userAcct = s.tables.credit_accounts.rows.find((r) =>
    r.user_id === USER_A
  );
  assertEquals(userAcct?.tier, "team");
  assertEquals(userAcct?.balance, 8000);

  const member = s.tables.org_members.rows[0];
  assertEquals(member.user_id, USER_A);
  assertEquals(member.org_id, TEAM_ORG);
  assertEquals(member.tier_before_team, "free");
});

Deno.test("applyUserEvent — MuckRock Staff team entitlement seeds shared pool", async () => {
  const s = new FakeSupabase();
  await applyUserEvent(
    s as unknown as SupabaseClient,
    teamUserinfo(USER_A, "a@example.com", muckrockStaffOrg()),
  );

  const org = s.tables.orgs.rows.find((r) => r.id === STAFF_ORG);
  assertEquals(org?.name, "MuckRock Staff");

  const pool = s.tables.credit_accounts.rows.find((r) =>
    r.org_id === STAFF_ORG
  );
  assertEquals(pool?.tier, "team");
  assertEquals(pool?.monthly_cap, 5000);
  assertEquals(pool?.entitlement_source, "cojournalist-team");

  const prefs = s.tables.user_preferences.rows.find((r) =>
    r.user_id === USER_A
  );
  assertEquals(prefs?.tier, "team");
  assertEquals(prefs?.active_org_id, STAFF_ORG);
});

// ---------------------------------------------------------------------------
// 4. Second team member does not clobber pool balance
// ---------------------------------------------------------------------------

Deno.test("applyUserEvent — second member joins → pool balance preserved", async () => {
  const s = new FakeSupabase();
  await applyUserEvent(
    s as unknown as SupabaseClient,
    teamUserinfo(USER_A, "a@example.com"),
  );

  // Simulate: team has spent 2,500 credits since USER_A joined.
  const pool = s.tables.credit_accounts.rows.find((r) =>
    r.org_id === TEAM_ORG
  )!;
  pool.balance = 5500;

  // USER_B joins. Must not reset pool.balance to 8000.
  await applyUserEvent(
    s as unknown as SupabaseClient,
    teamUserinfo(USER_B, "b@example.com"),
  );

  const afterPool = s.tables.credit_accounts.rows.find((r) =>
    r.org_id === TEAM_ORG
  )!;
  assertEquals(afterPool.balance, 5500);
  assertEquals(s.tables.org_members.rows.length, 2);
});

// ---------------------------------------------------------------------------
// 5. Individual downgrade — balance capped at new cap
// ---------------------------------------------------------------------------

Deno.test("upsertUserCredits — downgrade caps balance; never raises", async () => {
  const s = new FakeSupabase();
  // Pro user with 1,000 cap and 900 remaining.
  s.tables.credit_accounts.rows.push({
    user_id: USER_A,
    tier: "pro",
    monthly_cap: 1000,
    balance: 900,
  });
  // MuckRock downgrades them to free (cap 100).
  await upsertUserCredits(s as unknown as SupabaseClient, USER_A, {
    tier: "free",
    monthlyCap: 100,
    updateOn: null,
    orgUuid: null,
    entitlementSource: null,
  });
  const row = s.tables.credit_accounts.rows.find((r) => r.user_id === USER_A)!;
  assertEquals(row.tier, "free");
  assertEquals(row.monthly_cap, 100);
  assertEquals(row.balance, 100); // capped from 900 → 100

  // Same call with the user now at balance=50 (below new cap) should NOT raise to 100.
  row.balance = 50;
  await upsertUserCredits(s as unknown as SupabaseClient, USER_A, {
    tier: "free",
    monthlyCap: 100,
    updateOn: null,
    orgUuid: null,
    entitlementSource: null,
  });
  const after = s.tables.credit_accounts.rows.find((r) =>
    r.user_id === USER_A
  )!;
  assertEquals(after.balance, 50);
});

// ---------------------------------------------------------------------------
// 6. Team topup uses RPC, not raw UPDATE
// ---------------------------------------------------------------------------

Deno.test("applyTeamOrgTopup — existing pool goes through topup_team_credits RPC", async () => {
  const s = new FakeSupabase();
  // Pre-seed the pool (so topup hits the RPC branch).
  s.tables.orgs.rows.push({
    id: TEAM_ORG,
    name: "Team Tribune",
    is_individual: false,
  });
  s.tables.credit_accounts.rows.push({
    org_id: TEAM_ORG,
    tier: "team",
    monthly_cap: 5000,
    balance: 2000,
    update_on: "2026-04-01",
  });

  const org = teamOrg(10000, "2026-06-01");
  await applyTeamOrgTopup(
    s as unknown as SupabaseClient,
    org,
    org.entitlements![0],
  );

  assertEquals(s.rpcCalls.length, 1);
  assertEquals(s.rpcCalls[0].name, "topup_team_credits");
  assertEquals(s.rpcCalls[0].args.p_org_id, TEAM_ORG);
  assertEquals(s.rpcCalls[0].args.p_new_cap, 10000);
  assertEquals(s.rpcCalls[0].args.p_update_on, "2026-06-01");

  const after = s.tables.credit_accounts.rows.find((r) =>
    r.org_id === TEAM_ORG
  )!;
  assertEquals(after.monthly_cap, 10000);
  // Balance stays at 2,000 — topup_team_credits tops up, doesn't reset.
  assertEquals(after.balance, 2000);
});

// ---------------------------------------------------------------------------
// 7. Cancel team org — revert members, delete rows
// ---------------------------------------------------------------------------

Deno.test("cancelTeamOrg — members revert to tier_before_team; rows deleted", async () => {
  const s = new FakeSupabase();
  // Seed a team org with two members (A was pro pre-team, B was free).
  s.tables.orgs.rows.push({
    id: TEAM_ORG,
    name: "Team Tribune",
    is_individual: false,
  });
  s.tables.credit_accounts.rows.push(
    { org_id: TEAM_ORG, tier: "team", monthly_cap: 8000, balance: 4000 },
    { user_id: USER_A, tier: "team", monthly_cap: 8000, balance: 8000 },
    { user_id: USER_B, tier: "team", monthly_cap: 8000, balance: 8000 },
  );
  s.tables.user_preferences.rows.push(
    { user_id: USER_A, tier: "team", active_org_id: TEAM_ORG },
    { user_id: USER_B, tier: "team", active_org_id: TEAM_ORG },
  );
  s.tables.org_members.rows.push(
    { org_id: TEAM_ORG, user_id: USER_A, tier_before_team: "pro" },
    { org_id: TEAM_ORG, user_id: USER_B, tier_before_team: "free" },
  );

  await cancelTeamOrg(s as unknown as SupabaseClient, TEAM_ORG);

  const prefA = s.tables.user_preferences.rows.find((r) =>
    r.user_id === USER_A
  )!;
  const prefB = s.tables.user_preferences.rows.find((r) =>
    r.user_id === USER_B
  )!;
  assertEquals(prefA.tier, "pro");
  assertEquals(prefA.active_org_id, null);
  assertEquals(prefB.tier, "free");
  assertEquals(prefB.active_org_id, null);

  const acctA = s.tables.credit_accounts.rows.find((r) =>
    r.user_id === USER_A
  )!;
  const acctB = s.tables.credit_accounts.rows.find((r) =>
    r.user_id === USER_B
  )!;
  assertEquals(acctA.tier, "pro");
  assertEquals(acctA.monthly_cap, DEFAULT_CAPS.pro);
  assertEquals(acctA.balance, DEFAULT_CAPS.pro); // capped from 8000 → 1000
  assertEquals(acctB.tier, "free");
  assertEquals(acctB.monthly_cap, DEFAULT_CAPS.free);
  assertEquals(acctB.balance, DEFAULT_CAPS.free); // capped from 8000 → 100

  // Org + pool + members rows gone.
  assertEquals(s.tables.orgs.rows.length, 0);
  assertEquals(s.tables.org_members.rows.length, 0);
  assertEquals(
    s.tables.credit_accounts.rows.find((r) => r.org_id === TEAM_ORG),
    undefined,
  );
});
