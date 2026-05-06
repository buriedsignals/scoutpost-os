/**
 * MuckRock entitlement → coJournalist tier resolution.
 *
 * Ports the logic from
 *   cojournalist/backend/app/services/user_service.py:55-86
 * plus the per-user + per-org upsert paths (get_or_create_user,
 * update_tier_from_org, update_org_credits, cancel_team_org).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  MuckrockEntitlement,
  MuckrockOrg,
  MuckrockUserInfo,
} from "./muckrock.ts";

export type Tier = "free" | "pro" | "team";

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, team: 2 };

export const DEFAULT_CAPS: Record<Tier, number> = {
  free: 100,
  pro: 1000,
  team: 5000,
};

export interface ResolvedTier {
  tier: Tier;
  monthlyCap: number;
  updateOn: string | null;
  orgUuid: string | null; // set only when tier === 'team'
  entitlementSource: string | null;
}

function normalizeEntitlementKey(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function entitlementMatches(
  ent: MuckrockEntitlement,
  canonical: string,
): boolean {
  return [ent.slug, ent.name].some((value) =>
    normalizeEntitlementKey(value) === canonical
  );
}

export function isCojournalistTeamEntitlement(
  ent: MuckrockEntitlement,
): boolean {
  return entitlementMatches(ent, "cojournalist-team");
}

function isCojournalistProEntitlement(ent: MuckrockEntitlement): boolean {
  return entitlementMatches(ent, "cojournalist-pro");
}

/**
 * Highest-of-all resolution across an array of MuckRock organizations.
 * Mirrors resolve_tier() in user_service.py.
 */
export function resolveTier(orgs: MuckrockOrg[] | undefined): ResolvedTier {
  let best: ResolvedTier = {
    tier: "free",
    monthlyCap: DEFAULT_CAPS.free,
    updateOn: null,
    orgUuid: null,
    entitlementSource: null,
  };

  for (const org of orgs ?? []) {
    for (const ent of org.entitlements ?? []) {
      const cap = ent.resources?.monthly_credits;
      if (
        isCojournalistTeamEntitlement(ent) &&
        TIER_RANK.team > TIER_RANK[best.tier]
      ) {
        best = {
          tier: "team",
          monthlyCap: typeof cap === "number" ? cap : DEFAULT_CAPS.team,
          updateOn: ent.update_on ?? null,
          orgUuid: org.uuid,
          entitlementSource: "cojournalist-team",
        };
      } else if (
        isCojournalistProEntitlement(ent) &&
        TIER_RANK.pro > TIER_RANK[best.tier]
      ) {
        best = {
          tier: "pro",
          monthlyCap: typeof cap === "number" ? cap : DEFAULT_CAPS.pro,
          updateOn: ent.update_on ?? null,
          orgUuid: null,
          entitlementSource: "cojournalist-pro",
        };
      }
    }
  }

  return best;
}

/** Admin email override: upgrade to pro if below, per ADMIN_EMAILS env var. */
export function applyAdminOverride(
  email: string | undefined,
  resolved: ResolvedTier,
): ResolvedTier {
  const adminRaw = Deno.env.get("ADMIN_EMAILS")?.trim() ?? "";
  if (!email || !adminRaw) return resolved;
  const admins = adminRaw.split(",").map((e) => e.trim().toLowerCase()).filter(
    Boolean,
  );
  if (!admins.includes(email.toLowerCase())) return resolved;
  if (TIER_RANK[resolved.tier] >= TIER_RANK.pro) return resolved;
  return {
    ...resolved,
    tier: "pro",
    monthlyCap: DEFAULT_CAPS.pro,
    entitlementSource: "admin-override",
  };
}

// ---------------------------------------------------------------------------
// Supabase upsert paths
// ---------------------------------------------------------------------------

/**
 * Create/update credit_accounts row for an individual user.
 *
 * Behaviour mirrors get_or_create_user() + update_tier_from_org():
 * - Creates a row with balance = monthly_cap on first sight
 * - On returning user: updates monthly_cap + tier + update_on and caps
 *   balance at the new cap (downgrade protection)
 */
export async function upsertUserCredits(
  svc: SupabaseClient,
  userId: string,
  resolved: ResolvedTier,
): Promise<void> {
  // Insert-or-ignore to get initial balance right without clobbering existing.
  const { data: existing } = await svc
    .from("credit_accounts")
    .select("balance, monthly_cap")
    .eq("user_id", userId)
    .maybeSingle();

  if (!existing) {
    await svc.from("credit_accounts").insert({
      user_id: userId,
      tier: resolved.tier,
      monthly_cap: resolved.monthlyCap,
      balance: resolved.monthlyCap,
      update_on: resolved.updateOn,
      entitlement_source: resolved.entitlementSource,
    });
    return;
  }

  // Returning user — update cap/tier/update_on; cap balance on downgrade.
  const cappedBalance = Math.min(
    existing.balance as number,
    resolved.monthlyCap,
  );
  await svc
    .from("credit_accounts")
    .update({
      tier: resolved.tier,
      monthly_cap: resolved.monthlyCap,
      balance: cappedBalance,
      update_on: resolved.updateOn,
      entitlement_source: resolved.entitlementSource,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
}

/** Mirror user_preferences.tier + active_org_id with the resolved tier. */
export async function upsertUserPreferences(
  svc: SupabaseClient,
  userId: string,
  tier: Tier,
  activeOrgId: string | null,
): Promise<void> {
  await svc
    .from("user_preferences")
    .upsert(
      {
        user_id: userId,
        tier,
        active_org_id: activeOrgId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
}

/**
 * Ensure orgs + org_members rows exist for a team user, and seed the
 * team credit pool if new.
 */
export async function seedTeamOrg(
  svc: SupabaseClient,
  org: MuckrockOrg,
  userId: string,
  resolved: ResolvedTier,
  tierBeforeTeam: Tier,
): Promise<void> {
  if (resolved.tier !== "team" || !resolved.orgUuid) return;

  await svc
    .from("orgs")
    .upsert(
      {
        id: org.uuid,
        name: org.name ?? "Team",
        is_individual: org.individual ?? false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

  // Create the shared credit pool if missing; don't clobber live balance.
  const { data: pool } = await svc
    .from("credit_accounts")
    .select("balance")
    .eq("org_id", org.uuid)
    .maybeSingle();
  if (!pool) {
    await svc.from("credit_accounts").insert({
      org_id: org.uuid,
      tier: "team",
      monthly_cap: resolved.monthlyCap,
      balance: resolved.monthlyCap,
      update_on: resolved.updateOn,
      entitlement_source: "cojournalist-team",
    });
  }

  await svc
    .from("org_members")
    .upsert(
      {
        org_id: org.uuid,
        user_id: userId,
        tier_before_team: tierBeforeTeam === "team" ? "free" : tierBeforeTeam,
      },
      { onConflict: "org_id,user_id" },
    );
}

/**
 * Apply a single org's entitlements to its owning user (individual orgs).
 * Called by the webhook when an `organization` event arrives and the org is
 * individual (org.uuid === user.uuid).
 */
export async function applyIndividualOrgChange(
  svc: SupabaseClient,
  org: MuckrockOrg,
): Promise<void> {
  const resolved = resolveTier([org]);
  const userId = org.uuid;
  await upsertUserCredits(svc, userId, resolved);
  await upsertUserPreferences(svc, userId, resolved.tier, null);
}

/**
 * Top up / downsize a team org's shared pool. Mirrors
 *   user_service.update_org_credits(org_id, new_cap, update_on)
 * via the topup_team_credits RPC.
 */
export async function applyTeamOrgTopup(
  svc: SupabaseClient,
  org: MuckrockOrg,
  teamEnt: MuckrockEntitlement,
): Promise<void> {
  const newCap = (teamEnt?.resources?.monthly_credits as number | undefined) ??
    DEFAULT_CAPS.team;
  const updateOn = teamEnt?.update_on ?? null;

  // Ensure org row exists first.
  await svc
    .from("orgs")
    .upsert(
      { id: org.uuid, name: org.name ?? "Team", is_individual: false },
      { onConflict: "id" },
    );

  // Ensure credit pool exists.
  const { data: pool } = await svc
    .from("credit_accounts")
    .select("id")
    .eq("org_id", org.uuid)
    .maybeSingle();
  if (!pool) {
    await svc.from("credit_accounts").insert({
      org_id: org.uuid,
      tier: "team",
      monthly_cap: newCap,
      balance: newCap,
      update_on: updateOn,
      entitlement_source: "cojournalist-team",
    });
    return;
  }

  await svc.rpc("topup_team_credits", {
    p_org_id: org.uuid,
    p_new_cap: newCap,
    p_update_on: updateOn,
  });
}

/**
 * Cancel a team org: revert every member's tier to tier_before_team, cap their
 * balance at the free cap, and delete the org + members. Mirrors
 * user_service.cancel_team_org().
 */
export async function cancelTeamOrg(
  svc: SupabaseClient,
  orgUuid: string,
): Promise<void> {
  const { data: members } = await svc
    .from("org_members")
    .select("user_id, tier_before_team")
    .eq("org_id", orgUuid);

  for (const m of members ?? []) {
    const revertTier: Tier = (m.tier_before_team as Tier) ?? "free";
    const revertCap = DEFAULT_CAPS[revertTier];

    await svc.from("user_preferences").upsert(
      {
        user_id: m.user_id,
        tier: revertTier,
        active_org_id: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    // Cap balance at the reverted tier's monthly_cap.
    await svc
      .from("credit_accounts")
      .update({
        tier: revertTier,
        monthly_cap: revertCap,
        entitlement_source: revertTier === "free"
          ? null
          : `cojournalist-${revertTier}`,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", m.user_id);
    await svc
      .from("credit_accounts")
      .update({ balance: revertCap })
      .eq("user_id", m.user_id)
      .gt("balance", revertCap);
  }

  await svc.from("org_members").delete().eq("org_id", orgUuid);
  await svc.from("credit_accounts").delete().eq("org_id", orgUuid);
  await svc.from("orgs").delete().eq("id", orgUuid);
}

/**
 * Full user-event upsert path (webhook type=user). Fetches the full userinfo,
 * resolves tier, seeds team structures if needed, mirrors to credit_accounts +
 * user_preferences.
 */
export async function applyUserEvent(
  svc: SupabaseClient,
  userinfo: MuckrockUserInfo,
): Promise<void> {
  const resolved = applyAdminOverride(
    userinfo.email,
    resolveTier(userinfo.organizations),
  );
  const userId = userinfo.uuid;

  // Determine the user's tier-before-team for seat-claim tracking.
  const { data: prefs } = await svc
    .from("user_preferences")
    .select("tier")
    .eq("user_id", userId)
    .maybeSingle();
  const tierBeforeTeam = (prefs?.tier ?? "free") as Tier;

  // Team path: seed org + membership first so active_org_id resolves correctly.
  if (resolved.tier === "team" && resolved.orgUuid) {
    const teamOrg = userinfo.organizations?.find((o) =>
      o.uuid === resolved.orgUuid
    );
    if (teamOrg) {
      await seedTeamOrg(svc, teamOrg, userId, resolved, tierBeforeTeam);
    }
  }

  await upsertUserCredits(svc, userId, resolved);
  await upsertUserPreferences(svc, userId, resolved.tier, resolved.orgUuid);
}
