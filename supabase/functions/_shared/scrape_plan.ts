/**
 * One place decides which renderer a URL tries first.
 *
 * The inline scrape port and the durable Page crawler used to make that call
 * separately; both now ask for a ScrapePlan. The only input beyond static
 * configuration is host memory: a host whose anti-bot protection blocked
 * crawl4ai three times in seven days (each time rescued by Firecrawl) is
 * routed straight to Firecrawl for fourteen days. Any crawl4ai success for the
 * host clears the record.
 */
import { logEvent } from "./log.ts";
import { getServiceClient } from "./supabase.ts";

export type ScrapePlanProvider = "crawl4ai" | "firecrawl";

export interface ScrapeHostPolicy {
  host: string;
  primary_provider: "firecrawl";
  reason: "anti_bot";
  evidence_count: number;
  expires_at: string | null;
}

export interface ScrapePlan {
  host: string | null;
  providers: ScrapePlanProvider[];
  /** The stored row, if any, whether or not it is currently enforced. */
  policy: ScrapeHostPolicy | null;
  /** True when the policy is enforced and the primary renderer is skipped. */
  skipPrimary: boolean;
}

export interface ScrapePlanDeps {
  readPolicy: (host: string) => Promise<ScrapeHostPolicy | null>;
  recordBlock: (host: string) => Promise<void>;
  clearBlock: (host: string) => Promise<void>;
  now: () => number;
  compatibilityMode: () => boolean;
  firecrawlConfigured: () => boolean;
}

const MEMO_TTL_MS = 5 * 60_000;

/** Host memory lives in the hosted database; a runtime without one keeps the static order silently. */
function serviceDatabaseConfigured(): boolean {
  return Boolean(
    Deno.env.get("SERVICE_SUPABASE_URL") || Deno.env.get("SUPABASE_URL") ||
      Deno.env.get("API_URL"),
  );
}
const memo = new Map<string, { policy: ScrapeHostPolicy | null; at: number }>();
// Concurrent scrapes of one host (Beat renders sources in parallel) share a
// single lookup instead of racing the memo.
const inflight = new Map<string, Promise<ScrapeHostPolicy | null>>();

export function scrapeHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function resetScrapePlanMemo(): void {
  memo.clear();
  inflight.clear();
}

export function policyEnforced(
  policy: ScrapeHostPolicy | null,
  nowMs: number,
): boolean {
  if (!policy?.expires_at) return false;
  const expires = Date.parse(policy.expires_at);
  return Number.isFinite(expires) && expires > nowMs;
}

async function readPolicyFromDb(
  host: string,
): Promise<ScrapeHostPolicy | null> {
  if (!serviceDatabaseConfigured()) return null;
  try {
    const { data, error } = await getServiceClient()
      .from("scrape_host_policy")
      .select("host,primary_provider,reason,evidence_count,expires_at")
      .eq("host", host)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as ScrapeHostPolicy | null) ?? null;
  } catch (e) {
    // Never let policy lookup failures block a scrape; fall back to the
    // static order and say so.
    logEvent({
      level: "warn",
      fn: "scrape-plan",
      event: "policy_lookup_failed",
      host,
      msg: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

async function recordBlockInDb(host: string): Promise<void> {
  if (!serviceDatabaseConfigured()) return;
  const { data, error } = await getServiceClient().rpc(
    "record_scrape_host_block",
    { p_host: host, p_reason: "anti_bot" },
  );
  if (error) throw new Error(error.message);
  const row = data as ScrapeHostPolicy | null;
  logEvent({
    level: "info",
    fn: "scrape-plan",
    event: row?.expires_at ? "host_block_enforced" : "host_block_evidence",
    host,
    evidence_count: row?.evidence_count ?? null,
    expires_at: row?.expires_at ?? null,
  });
}

async function clearBlockInDb(host: string): Promise<void> {
  if (!serviceDatabaseConfigured()) return;
  const { error } = await getServiceClient().rpc("clear_scrape_host_block", {
    p_host: host,
  });
  if (error) throw new Error(error.message);
  logEvent({
    level: "info",
    fn: "scrape-plan",
    event: "host_block_cleared",
    host,
  });
}

export const DEFAULT_SCRAPE_PLAN_DEPS: ScrapePlanDeps = {
  readPolicy: readPolicyFromDb,
  recordBlock: recordBlockInDb,
  clearBlock: clearBlockInDb,
  now: () => Date.now(),
  compatibilityMode: () => Deno.env.get("SCRAPE_PROVIDER") === "firecrawl",
  firecrawlConfigured: () => Boolean(Deno.env.get("FIRECRAWL_API_KEY")),
};

export async function resolveScrapePlan(
  url: string,
  deps: Partial<ScrapePlanDeps> = {},
): Promise<ScrapePlan> {
  const d = { ...DEFAULT_SCRAPE_PLAN_DEPS, ...deps };
  const host = scrapeHost(url);
  if (d.compatibilityMode()) {
    return { host, providers: ["firecrawl"], policy: null, skipPrimary: false };
  }
  const firecrawl = d.firecrawlConfigured();
  const staticOrder: ScrapePlanProvider[] = firecrawl
    ? ["crawl4ai", "firecrawl"]
    : ["crawl4ai"];
  if (!host || !firecrawl) {
    return { host, providers: staticOrder, policy: null, skipPrimary: false };
  }
  const nowMs = d.now();
  const cached = memo.get(host);
  let policy: ScrapeHostPolicy | null;
  if (cached && nowMs - cached.at < MEMO_TTL_MS) {
    policy = cached.policy;
  } else {
    let pending = inflight.get(host);
    if (!pending) {
      pending = d.readPolicy(host).finally(() => inflight.delete(host));
      inflight.set(host, pending);
    }
    policy = await pending;
    memo.set(host, { policy, at: nowMs });
  }
  if (policyEnforced(policy, nowMs)) {
    return { host, providers: ["firecrawl"], policy, skipPrimary: true };
  }
  return { host, providers: staticOrder, policy, skipPrimary: false };
}

/**
 * Called after Firecrawl rescued an anti-bot block of the primary renderer.
 * Best effort: evidence bookkeeping must never fail the scrape that
 * succeeded.
 */
export async function noteAntiBotRescue(
  host: string | null,
  deps: Partial<ScrapePlanDeps> = {},
): Promise<void> {
  if (!host) return;
  const d = { ...DEFAULT_SCRAPE_PLAN_DEPS, ...deps };
  memo.delete(host);
  try {
    await d.recordBlock(host);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "scrape-plan",
      event: "host_block_record_failed",
      host,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Called after the primary renderer succeeded for a host that has a stored
 * (expired or evidence-only) policy row. Best effort, same as above.
 */
export async function notePrimarySuccess(
  plan: ScrapePlan,
  deps: Partial<ScrapePlanDeps> = {},
): Promise<void> {
  if (!plan.host || !plan.policy) return;
  const d = { ...DEFAULT_SCRAPE_PLAN_DEPS, ...deps };
  memo.delete(plan.host);
  try {
    await d.clearBlock(plan.host);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "scrape-plan",
      event: "host_block_clear_failed",
      host: plan.host,
      msg: e instanceof Error ? e.message : String(e),
    });
  }
}
