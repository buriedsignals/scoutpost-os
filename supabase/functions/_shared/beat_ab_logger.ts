import type { SupabaseClient } from "./supabase.ts";
import { logEvent } from "./log.ts";

export type BeatRetrievalPort = "firecrawl" | "exa";

export interface BeatAbHit {
  url: string;
  title?: string;
  description?: string;
  date?: string | null;
}

export interface BeatLocationMetrics {
  city?: string | null;
  country?: string | null;
  countryCode?: string | null;
}

export interface BeatAbRunMetrics {
  scoutId: string;
  runId: string;
  userId: string;
  retrieval: BeatRetrievalPort;
  rawHits: BeatAbHit[];
  finalHits: BeatAbHit[];
  unitsCreated: number;
  unitsMerged: number;
  location?: BeatLocationMetrics;
  totalCostDollars?: number | null;
  metadata?: Record<string, unknown>;
}

export interface BeatAbScoreSummary {
  rawHitCount: number;
  datedHitCount: number;
  finalHitCount: number;
  localityScore: number | null;
  freshnessScore: number | null;
}

export function summarizeBeatAbRun(
  metrics: Pick<BeatAbRunMetrics, "rawHits" | "finalHits" | "location">,
): BeatAbScoreSummary {
  const datedHitCount =
    metrics.rawHits.filter((hit) =>
      typeof hit.date === "string" && hit.date.trim().length > 0
    ).length;
  return {
    rawHitCount: metrics.rawHits.length,
    datedHitCount,
    finalHitCount: metrics.finalHits.length,
    localityScore: scoreLocality(metrics.finalHits, metrics.location),
    freshnessScore: metrics.rawHits.length === 0
      ? null
      : roundScore(datedHitCount / metrics.rawHits.length),
  };
}

export async function logBeatAbRun(
  db: SupabaseClient,
  metrics: BeatAbRunMetrics,
): Promise<boolean> {
  try {
    const summary = summarizeBeatAbRun(metrics);
    const { error } = await db.from("beat_ab_runs").insert({
      scout_id: metrics.scoutId,
      run_id: metrics.runId,
      user_id: metrics.userId,
      retrieval: metrics.retrieval,
      raw_hit_count: summary.rawHitCount,
      dated_hit_count: summary.datedHitCount,
      final_hit_count: summary.finalHitCount,
      units_created: metrics.unitsCreated,
      units_merged: metrics.unitsMerged,
      locality_score: summary.localityScore,
      freshness_score: summary.freshnessScore,
      total_cost_dollars: metrics.totalCostDollars ?? null,
      metadata: metrics.metadata ?? {},
    });
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "beat-ab-logger",
      event: "insert_failed",
      scout_id: metrics.scoutId,
      run_id: metrics.runId,
      retrieval: metrics.retrieval,
      msg: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

function scoreLocality(
  hits: BeatAbHit[],
  location: BeatLocationMetrics | undefined,
): number | null {
  const textNeedles = [
    location?.city,
    location?.country,
  ]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  const tlds = countryCodeTlds(location?.countryCode);
  if (hits.length === 0 && (textNeedles.length > 0 || tlds.length > 0)) {
    return null;
  }
  if (textNeedles.length === 0 && tlds.length === 0) return null;
  const localized = hits.filter((hit) => {
    const text = `${hit.title ?? ""} ${hit.description ?? ""} ${hit.url ?? ""}`
      .toLowerCase();
    return textNeedles.some((needle) => containsTerm(text, needle)) ||
      tlds.some((tld) => urlMatchesTld(hit.url, tld));
  }).length;
  return roundScore(localized / hits.length);
}

function countryCodeTlds(countryCode: string | null | undefined): string[] {
  const code = countryCode?.trim().toLowerCase();
  if (!code || !/^[a-z]{2}$/.test(code)) return [];
  if (code === "gb") return ["uk"];
  return [code];
}

function containsTerm(text: string, term: string): boolean {
  const normalized = term.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  const escaped = escapeRegex(normalized).replace(/\\ /g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function urlMatchesTld(url: string, tld: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === tld || hostname.endsWith(`.${tld}`);
  } catch {
    return false;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
