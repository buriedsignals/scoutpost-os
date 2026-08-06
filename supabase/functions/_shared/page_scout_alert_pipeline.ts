import type { AiUsageContext } from "./openrouter.ts";
import {
  evaluatePageScoutCriteria,
  type PageScoutCriteriaResult,
} from "./page_scout_criteria.ts";
import {
  decidePageScoutAlert,
  type PageContentDiff,
  pageContentLines,
} from "./page_scout_change.ts";

export interface PageScoutAlertAnalysisInput {
  criteria: string | null;
  diff: PageContentDiff;
  changeStatus: "new" | "same" | "changed" | "removed";
  initialBaseline: boolean;
  timeoutMs: number;
  usage?: AiUsageContext;
}

interface MatchingDeltaEnrichmentInput {
  criteria: string;
  delta: string;
  decision: PageScoutCriteriaResult;
}

export interface PageScoutAlertAnalysisDependencies<TEnrichment> {
  evaluateCriteria?: typeof evaluatePageScoutCriteria;
  enrichMatchingDelta?: (
    input: MatchingDeltaEnrichmentInput,
  ) => Promise<TEnrichment>;
}

export interface PageScoutAlertAnalysis<TEnrichment> {
  criteriaDecision: PageScoutCriteriaResult | null;
  enrichment: TEnrichment | null;
  alertEligible: boolean;
  criteriaDelta: string;
}

/**
 * Resolve the semantic Page Scout alert gate once, before optional unit
 * enrichment. The criteria agent owns the multilingual match judgment; this
 * function only enforces how that judgment propagates through the pipeline.
 */
export async function analyzePageScoutAlert<TEnrichment = never>(
  input: PageScoutAlertAnalysisInput,
  deps: PageScoutAlertAnalysisDependencies<TEnrichment> = {},
): Promise<PageScoutAlertAnalysis<TEnrichment>> {
  const criteria = input.criteria?.trim() ?? "";
  const hasCriteria = criteria.length > 0;
  const criteriaDelta = renderPageScoutCriteriaDelta(input.diff);
  const shouldEvaluate = hasCriteria &&
    input.diff.hasChanges &&
    input.changeStatus !== "same" &&
    !input.initialBaseline;

  const evaluateCriteria = deps.evaluateCriteria ?? evaluatePageScoutCriteria;
  const criteriaDecision = shouldEvaluate
    ? await evaluateCriteria({
      criteria,
      delta: criteriaDelta,
      timeoutMs: input.timeoutMs,
      usage: input.usage,
    })
    : null;

  const alertEligible = decidePageScoutAlert({
    mode: hasCriteria ? "specific" : "any",
    changeStatus: input.changeStatus,
    hasNormalizedDiff: input.diff.hasChanges,
    criteriaMatched: criteriaDecision?.matches ?? null,
    initialBaseline: input.initialBaseline,
  });

  const enrichment = criteriaDecision?.matches && deps.enrichMatchingDelta
    ? await deps.enrichMatchingDelta({
      criteria,
      delta: criteriaDelta,
      decision: criteriaDecision,
    })
    : null;

  return {
    criteriaDecision,
    enrichment,
    alertEligible,
    criteriaDelta,
  };
}

export function renderPageScoutCriteriaDelta(diff: PageContentDiff): string {
  const removed = renderContextualChanges("REMOVED", diff.removed, diff.before);
  const added = renderContextualChanges("ADDED", diff.added, diff.after);
  return [
    "Evaluate only these normalized page changes against the user's criteria.",
    removed,
    added,
  ].filter(Boolean).join("\n\n");
}

const CONTEXT_LINE_WINDOW = 3;

function renderContextualChanges(
  label: "REMOVED" | "ADDED",
  changes: string[],
  content: string,
): string {
  const lines = pageContentLines(content);
  const changedLines = new Set(changes);
  let searchFrom = 0;

  return changes.map((change, changeIndex) => {
    const evidenceId = `${label === "REMOVED" ? "R" : "A"}${changeIndex + 1}`;
    let index = lines.indexOf(change, searchFrom);
    if (index < 0) index = lines.indexOf(change);
    if (index < 0) return `${label}[${evidenceId}]: ${change}`;
    searchFrom = index + 1;

    const before = lines
      .slice(Math.max(0, index - CONTEXT_LINE_WINDOW), index)
      .filter((line) => !changedLines.has(line));
    const after = lines
      .slice(index + 1, index + 1 + CONTEXT_LINE_WINDOW)
      .filter((line) => !changedLines.has(line));
    return [
      ...before.map((line) => `CONTEXT: ${line}`),
      `${label}[${evidenceId}]: ${change}`,
      ...after.map((line) => `CONTEXT: ${line}`),
    ].join("\n");
  }).join("\n\n");
}
