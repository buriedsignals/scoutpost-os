export type SocialPlatform =
  | "tiktok"
  | "instagram"
  | "x"
  | "facebook"
  | "linkedin";

const DEFAULT_THRESHOLDS: Record<SocialPlatform, number> = {
  tiktok: 0.7,
  instagram: 0.65,
  x: 0.55,
  facebook: 0.55,
  // Text-dominant platform, same posture as x/facebook.
  linkedin: 0.55,
};

export function socialCriteriaThreshold(
  platform: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined = null,
): number {
  const override = metadata?.criteria_threshold;
  if (typeof override === "number" && Number.isFinite(override)) {
    return clamp01(override);
  }
  if (typeof override === "string" && override.trim()) {
    const parsed = Number(override);
    if (Number.isFinite(parsed)) return clamp01(parsed);
  }
  const key = (platform ?? "").toLowerCase() as SocialPlatform;
  return DEFAULT_THRESHOLDS[key] ?? 0.55;
}

export function criteriaScoreFromUnit(unit: {
  criteria_score?: number | null;
  criteria_match?: boolean | null;
}): number {
  if (
    typeof unit.criteria_score === "number" &&
    Number.isFinite(unit.criteria_score)
  ) {
    return clamp01(unit.criteria_score);
  }
  return unit.criteria_match === false ? 0 : 1;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
