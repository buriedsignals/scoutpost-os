/**
 * Credit + entitlement helpers shared across Edge Functions.
 *
 * Ports the constants + 402 error shape from
 *   /Users/tomvaillant/buried_signals/tools/cojournalist/backend/app/utils/pricing.py
 *   /Users/tomvaillant/buried_signals/tools/cojournalist/backend/app/dependencies/billing.py
 *
 * Callers invoke decrementOrThrow() with a service-role client before executing a
 * scout. On insufficient credits it throws a tagged error; map to 402 via
 * insufficientCreditsResponse().
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Credit cost per operation — $0.01/credit at MuckRock Pro ($10 / 1000). */
export const CREDIT_COSTS = {
  website_extraction: 1,

  beat: 7,

  social_monitoring_instagram: 2,
  social_monitoring_x: 2,
  social_monitoring_facebook: 15,
  social_monitoring_tiktok: 2,
  // harvestapi actor bills $0.002/post; a full 20-post window is $0.04005
  // per run, so 7 credits ($0.07) ≈ 43% margin.
  social_monitoring_linkedin: 7,

  social_extraction: 2,
  instagram_extraction: 2,
  facebook_extraction: 15,
  tiktok_extraction: 2,
  instagram_comments_extraction: 15,

  feed_export: 1,

  // Civic scheduled-run cost. Covers up to 20 change-tracking scrapes +
  // up to 2 PDF parses + up to 2 Gemini extractions per run (see
  // MAX_DOCS_PER_RUN in civic-execute). ~$0.10-0.13 worst-case infra cost,
  // priced to sit a hair above break-even. Weekly-max enforced by scouts
  // Edge Function validation; the audit flagged the old 20/run as user-
  // hostile on daily schedules (now rejected at create time).
  civic: 10,
  civic_discover: 10,

  // Transport scout (vessel/aircraft/satellite) run. Base covers the
  // positional fetch + state diff; the addon is charged only when the scout
  // has free-text criteria (one batched LLM pass over entrants).
  transport: 1,
  transport_criteria_addon: 1,
} as const;

export type CreditOperation = keyof typeof CREDIT_COSTS;

export const SOCIAL_MONITORING_KEYS: Record<string, CreditOperation> = {
  instagram: "social_monitoring_instagram",
  x: "social_monitoring_x",
  twitter: "social_monitoring_x",
  facebook: "social_monitoring_facebook",
  tiktok: "social_monitoring_tiktok",
  linkedin: "social_monitoring_linkedin",
};

export const EXTRACTION_KEYS: Record<string, CreditOperation> = {
  website: "website_extraction",
  social: "social_extraction",
  instagram: "instagram_extraction",
  facebook: "facebook_extraction",
  instagram_comments: "instagram_comments_extraction",
  tiktok: "tiktok_extraction",
};

/** Beat cost is flat across modes; kept as a helper to mirror the Python API. */
export function getBeatCost(
  _sourceMode: string | null,
  _hasLocation: boolean,
): number {
  return CREDIT_COSTS.beat;
}

export function getSocialMonitoringCost(platform: string): number {
  const key = SOCIAL_MONITORING_KEYS[platform] ?? "social_monitoring_instagram";
  return CREDIT_COSTS[key];
}

export function getExtractionCost(channel: string): number {
  const key = EXTRACTION_KEYS[channel] ?? "website_extraction";
  return CREDIT_COSTS[key];
}

/**
 * Scheduled scouts compute lifetime cost from per-run cost × regularity.
 * Mirrors calculate_monitoring_cost() in pricing.py.
 */
export function calculateMonitoringCost(
  perRunCost: number,
  regularity: "daily" | "weekly" | "monthly" | "3h" | "6h" | "12h" | string,
): number {
  const multipliers: Record<string, number> = {
    // Transport sub-daily window (runs/month at 8, 4, and 2 runs/day).
    "3h": 240,
    "6h": 120,
    "12h": 60,
    daily: 30,
    weekly: 4,
    monthly: 1,
  };
  return perRunCost * (multipliers[regularity.toLowerCase()] ?? 1);
}

/** Per-run transport cost: base + criteria addon when free-text criteria set. */
export function getTransportCost(hasCriteria: boolean): number {
  return CREDIT_COSTS.transport +
    (hasCriteria ? CREDIT_COSTS.transport_criteria_addon : 0);
}

// -----------------------------------------------------------------------------
// RPC invocation
// -----------------------------------------------------------------------------

export interface DecrementResult {
  balance: number;
  owner: "user" | "org";
}

/**
 * Tagged error thrown by decrementOrThrow() when the RPC rejects with
 * insufficient credits. Callers should catch it and return 402.
 */
export class InsufficientCreditsError extends Error {
  readonly required: number;
  readonly current: number | null;
  constructor(required: number, current: number | null = null) {
    super("insufficient_credits");
    this.required = required;
    this.current = current;
  }
}

export function creditsEnabled(): boolean {
  return Deno.env.get("COJO_CREDITS_ENABLED") === "true";
}

/**
 * Atomic decrement via the decrement_credits RPC defined in 00025_credits.sql.
 * Must be called with a service-role client — the RPC's EXECUTE permission is
 * locked down to service_role only.
 */
export async function decrementOrThrow(
  client: SupabaseClient,
  params: {
    userId: string;
    cost: number;
    scoutId: string | null;
    scoutType: string | null;
    operation: CreditOperation;
  },
): Promise<DecrementResult> {
  if (!creditsEnabled()) {
    return { balance: Number.MAX_SAFE_INTEGER, owner: "user" };
  }

  const { data, error } = await client.rpc("decrement_credits", {
    p_user_id: params.userId,
    p_cost: params.cost,
    p_scout_id: params.scoutId,
    p_scout_type: params.scoutType,
    p_operation: params.operation,
  });

  if (error) {
    // P0002 is the sqlstate raised by the RPC on insufficient credits.
    // Postgres error payloads over postgrest use `code` or nested `details`.
    if (
      error.code === "P0002" ||
      (error.message ?? "").toLowerCase().includes("insufficient_credits")
    ) {
      const current = await fetchCurrentBalance(client, params.userId);
      throw new InsufficientCreditsError(params.cost, current);
    }
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return { balance: row.balance, owner: row.owner };
}

/**
 * Undo a prior decrementOrThrow for the same (user, cost, operation). Safe to
 * call on any error path — the RPC silently no-ops when the account is gone,
 * and the INSERT into usage_records preserves an audit trail (negative cost).
 * Never throws; errors are logged and swallowed so the caller's main failure
 * path stays unobstructed.
 */
export async function refundCredits(
  client: SupabaseClient,
  params: {
    userId: string;
    cost: number;
    scoutId: string | null;
    scoutType: string | null;
    operation: CreditOperation;
  },
): Promise<void> {
  if (!creditsEnabled()) return;

  try {
    const { error } = await client.rpc("refund_credits", {
      p_user_id: params.userId,
      p_cost: params.cost,
      p_scout_id: params.scoutId,
      p_scout_type: params.scoutType,
      p_operation: params.operation,
    });
    if (error) {
      console.warn(
        `[credits] refund_credits failed for ${params.userId}: ${error.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `[credits] refund_credits threw for ${params.userId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * Best-effort read of the caller's current balance (team pool if active, else
 * user pool) — used to populate the 402 error body. Failure returns null.
 */
export async function fetchCurrentBalance(
  client: SupabaseClient,
  userId: string,
): Promise<number | null> {
  try {
    const { data: prefs } = await client
      .from("user_preferences")
      .select("active_org_id")
      .eq("user_id", userId)
      .maybeSingle();
    const activeOrgId = (prefs as { active_org_id: string | null } | null)
      ?.active_org_id ?? null;

    const query = client.from("credit_accounts").select("balance").limit(1);
    const scoped = activeOrgId
      ? query.eq("org_id", activeOrgId)
      : query.eq("user_id", userId);
    const { data } = await scoped.maybeSingle();
    return (data as { balance: number } | null)?.balance ?? null;
  } catch {
    return null;
  }
}

/**
 * 402 JSON shape that matches the existing frontend insufficient-credits modal
 * contract from the source repo (backend/app/dependencies/billing.py).
 */
export function insufficientCreditsResponse(
  required: number,
  current: number | null,
): Response {
  const shortfall = current === null
    ? required
    : Math.max(0, required - current);
  const body = {
    error: "insufficient_credits",
    message: `Insufficient credits. Required: ${required}, Available: ${
      current ?? "?"
    }`,
    current_credits: current,
    required_credits: required,
    shortfall,
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
