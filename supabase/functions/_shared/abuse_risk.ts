export const ABUSE_POLICY_VERSION = 1;
export const ABUSE_PROMPT_VERSION = "abuse-risk-v1";

export const ABUSE_RULE_SEVERITY = {
  "AUP-PRIVATE-ACCESS": "high",
  "AUP-STALKING-HARASSMENT-DOXXING": "high",
  "AUP-COERCIVE-DISCRIMINATORY-SURVEILLANCE": "high",
  "AUP-PROMPT-INJECTION": "medium",
  "AUP-RATE-LIMIT-ABUSE": "medium",
  "AUP-MISINFORMATION": "high",
} as const;

export type AbuseRuleId = keyof typeof ABUSE_RULE_SEVERITY;
export type FindingConfidence = "low" | "medium" | "high";

export interface ScoutAuditInput {
  id: string;
  user_id: string;
  name: string;
  type: string;
  description: string | null;
  criteria: string | null;
  topic: string | null;
  url: string | null;
  platform: string | null;
  profile_handle: string | null;
  root_domain: string | null;
  tracked_urls: string[] | null;
}

export interface AbuseSignal {
  id: string;
  kind: string;
  rule_id: AbuseRuleId;
  scout_ids: string[];
  summary: string;
}

export interface AbuseCandidate {
  userId: string;
  scouts: ScoutAuditInput[];
  signals: AbuseSignal[];
}

export interface ModelAbuseFinding {
  rule_id: string;
  confidence: string;
  evidence_signal_ids: string[];
  rationale: string;
}

export interface NormalizedAbuseFinding {
  ruleId: AbuseRuleId;
  severity: "medium" | "high";
  confidence: FindingConfidence;
  evidence: AbuseSignal[];
  scoutIds: string[];
  rationale: string;
}

interface ExistingNotificationState {
  confidence: string;
  config_fingerprint: string;
  notified_at: string | null;
}

const SIGNAL_PATTERNS: Array<{
  kind: string;
  rule_id: AbuseRuleId;
  pattern: RegExp;
  summary: string;
}> = [
  {
    kind: "private_access_intent",
    rule_id: "AUP-PRIVATE-ACCESS",
    pattern: /\b(private account|private profile|bypass (?:a )?(?:login|password)|circumvent (?:an )?access control|use (?:their )?(?:cookie|password|credential))\b/i,
    summary: "Account configuration expresses intent to access private or restricted content.",
  },
  {
    kind: "stalking_intent",
    rule_id: "AUP-STALKING-HARASSMENT-DOXXING",
    pattern: /\b(stalk|track my ex|watch my ex|ex-(?:partner|wife|husband|girlfriend|boyfriend))\b/i,
    summary: "Account configuration contains stalking or former-partner monitoring language.",
  },
  {
    kind: "doxxing_intent",
    rule_id: "AUP-STALKING-HARASSMENT-DOXXING",
    pattern: /\b(doxx?|home address|personal phone|private address)\b/i,
    summary: "Account configuration requests personal-location or doxxing material.",
  },
  {
    kind: "retaliation_intent",
    rule_id: "AUP-STALKING-HARASSMENT-DOXXING",
    pattern: /\b(retaliat(?:e|ion)|get back at|revenge)\b/i,
    summary: "Account configuration contains retaliation language.",
  },
  {
    kind: "coercive_employee_monitoring",
    rule_id: "AUP-COERCIVE-DISCRIMINATORY-SURVEILLANCE",
    pattern: /\b(problematic employee|monitor (?:my|our|the) employee|employee surveillance|screen (?:an )?(?:employee|applicant))\b/i,
    summary: "Account configuration describes coercive employee or applicant monitoring.",
  },
  {
    kind: "prompt_injection_intent",
    rule_id: "AUP-PROMPT-INJECTION",
    pattern: /\b(ignore (?:all |the )?(?:previous|prior|system) instructions|reveal (?:the )?system prompt|override (?:your|the) instructions)\b/i,
    summary: "Account-authored configuration contains an instruction-override attempt.",
  },
  {
    kind: "misinformation_intent",
    rule_id: "AUP-MISINFORMATION",
    pattern: /\b(generate|spread|amplify|publish) (?:a |the )?(?:false|fake|fabricated|misleading) (?:claim|story|information|report)\b/i,
    summary: "Account configuration expresses intent to generate or amplify misinformation.",
  },
];

function scoutText(scout: ScoutAuditInput): string {
  return [
    scout.name,
    scout.description,
    scout.criteria,
    scout.topic,
    scout.url,
    scout.profile_handle,
    scout.root_domain,
    ...(scout.tracked_urls ?? []),
  ].filter((value): value is string => typeof value === "string").join("\n");
}

function pushSignal(signals: AbuseSignal[], signal: AbuseSignal): void {
  if (!signals.some((existing) => existing.id === signal.id)) signals.push(signal);
}

export function buildAbuseCandidates(
  scouts: ScoutAuditInput[],
): AbuseCandidate[] {
  const byUser = new Map<string, ScoutAuditInput[]>();
  for (const scout of scouts) {
    const bucket = byUser.get(scout.user_id) ?? [];
    bucket.push(scout);
    byUser.set(scout.user_id, bucket);
  }

  const candidates: AbuseCandidate[] = [];
  for (const [userId, userScouts] of byUser) {
    const signals: AbuseSignal[] = [];
    for (const scout of userScouts) {
      const text = scoutText(scout);
      for (const definition of SIGNAL_PATTERNS) {
        if (!definition.pattern.test(text)) continue;
        pushSignal(signals, {
          id: `${definition.kind}:${scout.id}`,
          kind: definition.kind,
          rule_id: definition.rule_id,
          scout_ids: [scout.id],
          summary: definition.summary,
        });
      }
    }

    const socialScouts = userScouts.filter((scout) => scout.type === "social");
    if (socialScouts.length >= 8) {
      pushSignal(signals, {
        id: "high_social_profile_volume",
        kind: "high_social_profile_volume",
        rule_id: "AUP-STALKING-HARASSMENT-DOXXING",
        scout_ids: socialScouts.map((scout) => scout.id),
        summary: `Account has ${socialScouts.length} Social Scouts targeting personal profiles.`,
      });
    }

    const handles = new Map<string, ScoutAuditInput[]>();
    for (const social of socialScouts) {
      const handle = social.profile_handle?.trim().toLowerCase();
      if (!handle) continue;
      const bucket = handles.get(handle) ?? [];
      bucket.push(social);
      handles.set(handle, bucket);
    }
    for (const [handle, related] of handles) {
      if (new Set(related.map((scout) => scout.platform)).size < 2) continue;
      pushSignal(signals, {
        id: `cross_platform_target:${handle}`,
        kind: "cross_platform_target",
        rule_id: "AUP-STALKING-HARASSMENT-DOXXING",
        scout_ids: related.map((scout) => scout.id),
        summary: "The same profile handle is monitored across multiple platforms.",
      });
    }

    if (signals.length > 0) {
      candidates.push({
        userId,
        scouts: [...userScouts].sort((a, b) => a.id.localeCompare(b.id)),
        signals,
      });
    }
  }
  return candidates;
}

function confidence(value: string): FindingConfidence {
  return value === "high" || value === "medium" ? value : "low";
}

export function normalizeModelFindings(
  candidate: AbuseCandidate,
  modelFindings: ModelAbuseFinding[],
): NormalizedAbuseFinding[] {
  const signals = new Map(candidate.signals.map((signal) => [signal.id, signal]));
  const normalized: NormalizedAbuseFinding[] = [];
  for (const modelFinding of modelFindings) {
    if (!(modelFinding.rule_id in ABUSE_RULE_SEVERITY)) continue;
    const ruleId = modelFinding.rule_id as AbuseRuleId;
    const evidence = [...new Set(modelFinding.evidence_signal_ids)]
      .map((id) => signals.get(id))
      .filter((signal): signal is AbuseSignal =>
        Boolean(signal) && signal?.rule_id === ruleId
      );
    if (evidence.length === 0) continue;
    let level = confidence(modelFinding.confidence);
    if (level === "high" && evidence.length < 2) level = "medium";
    normalized.push({
      ruleId,
      severity: ABUSE_RULE_SEVERITY[ruleId],
      confidence: level,
      evidence,
      scoutIds: [...new Set(evidence.flatMap((signal) => signal.scout_ids))],
      rationale: modelFinding.rationale.trim().slice(0, 1000),
    });
  }
  return normalized;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintCandidate(
  candidate: AbuseCandidate,
): Promise<string> {
  const scouts = [...candidate.scouts].sort((a, b) => a.id.localeCompare(b.id));
  return await sha256(JSON.stringify(scouts));
}

export async function findingCaseKey(
  userId: string,
  ruleId: AbuseRuleId,
): Promise<string> {
  return await sha256(`${userId}:${ruleId}`);
}

export function shouldNotifyFinding(
  existing: ExistingNotificationState | null,
  confidenceValue: FindingConfidence,
  configFingerprint: string,
): boolean {
  if (confidenceValue !== "high") return false;
  if (!existing) return true;
  if (existing.confidence !== "high") return true;
  return existing.config_fingerprint !== configFingerprint;
}
