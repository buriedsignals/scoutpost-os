/** Shared hosted-tier gate for Fleet Scout creation and live testing. */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { creditsEnabled } from "./credits.ts";
import { ApiError } from "./errors.ts";
import { logEvent } from "./log.ts";

export async function assertTransportEntitled(
  svc: SupabaseClient,
  userId: string,
  caller = "scouts",
): Promise<void> {
  if (!creditsEnabled()) return;
  const { data, error } = await svc
    .from("credit_accounts")
    .select("tier")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    logEvent({
      level: "warn",
      fn: caller,
      event: "transport_entitlement_tier_read_failed",
      user_id: userId,
      msg: error.message,
    });
  }
  const tier = error ? undefined : (data as { tier?: string } | null)?.tier;
  if (tier !== "pro" && tier !== "team") {
    throw new ApiError(
      "Fleet Scout is a Pro/Team feature — upgrade to alert when watched objects enter an area.",
      403,
      "transport_forbidden",
    );
  }
}
