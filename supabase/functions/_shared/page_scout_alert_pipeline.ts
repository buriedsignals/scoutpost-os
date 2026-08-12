import type { AiUsageContext } from "./openrouter.ts";
import {
  evaluatePageScoutCriteria,
  type PageScoutCriteriaResult,
} from "./page_scout_criteria.ts";
import {
  decidePageScoutAlert,
  type PageContentDiff,
  pageContentLines,
  type PageContentMove,
  type PageContentOccurrence,
  pageContentSectionLookup,
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
  const removed = renderContextualChanges(
    "REMOVED",
    diff.removedOccurrences,
    diff.before,
  );
  const added = renderContextualChanges(
    "ADDED",
    diff.addedOccurrences,
    diff.after,
  );
  const moved = renderMoves(diff.moves, diff.before, diff.after);
  return [
    "Evaluate only these normalized page changes against the user's criteria.",
    "SECTION lines identify the containing heading. OCCURRENCE lines distinguish additional copies of existing wording from new wording. MOVED lines are exact deterministic position changes.",
    removed,
    added,
    moved,
  ].filter(Boolean).join("\n\n");
}

const CONTEXT_LINE_WINDOW = 3;

function renderContextualChanges(
  label: "REMOVED" | "ADDED",
  changes: PageContentOccurrence[],
  content: string,
): string {
  const lines = pageContentLines(content);
  const sections = pageContentSectionLookup(lines);
  const changedLines = new Set(changes.map((change) => change.text));

  return changes.map((change, changeIndex) => {
    const evidenceId = `${label === "REMOVED" ? "R" : "A"}${changeIndex + 1}`;
    const index = change.index;
    if (index < 0 || index >= lines.length) {
      return `${label}[${evidenceId}]: ${change.text}`;
    }

    const before = lines
      .slice(Math.max(0, index - CONTEXT_LINE_WINDOW), index)
      .filter((line) => !changedLines.has(line));
    const after = lines
      .slice(index + 1, index + 1 + CONTEXT_LINE_WINDOW)
      .filter((line) => !changedLines.has(line));
    const section = sections[index] ?? "";
    const occurrence = change.previousCount > 0 && change.currentCount > 0 &&
        change.currentCount !== change.previousCount
      ? `OCCURRENCE: identical text count changed from ${change.previousCount} to ${change.currentCount}; this is ${
        label === "ADDED" ? "an additional" : "a removed"
      } occurrence, not new wording.`
      : "";
    return [
      section ? `SECTION: ${section}` : "",
      occurrence,
      ...before.map((line) => `CONTEXT: ${line}`),
      `${label}[${evidenceId}]: ${change.text}`,
      ...after.map((line) => `CONTEXT: ${line}`),
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function renderMoves(
  moves: PageContentMove[],
  beforeContent: string,
  afterContent: string,
): string {
  if (moves.length === 0) return "";
  const beforeLines = pageContentLines(beforeContent);
  const afterLines = pageContentLines(afterContent);
  const beforeSections = pageContentSectionLookup(beforeLines);
  const afterSections = pageContentSectionLookup(afterLines);
  return moves.map((move, index) => {
    const beforeSection = beforeSections[move.beforeIndex] ?? "";
    const afterSection = afterSections[move.afterIndex] ?? "";
    return [
      beforeSection ? `SECTION BEFORE: ${beforeSection}` : "",
      afterSection && afterSection !== beforeSection
        ? `SECTION AFTER: ${afterSection}`
        : "",
      `MOVED[M${index + 1}]: ${move.from} -> ${move.to} | ${move.text}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}
