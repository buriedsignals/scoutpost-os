import { canonicalizeWebMarkdown } from "./web_content_canonical.ts";

export type PageScoutAlertMode = "any" | "specific";

export interface PageContentDiff {
  hasChanges: boolean;
  before: string;
  after: string;
  added: string[];
  removed: string[];
  summary: string;
}

const MAX_SUMMARY_LINES = 6;
const MAX_LINE_CHARS = 500;

/**
 * Build a bounded, deterministic line diff from the same canonical content
 * used by Page Scout's hash comparison. The hash remains the cheap gate; this
 * representation is the alert/matching payload when that gate changes.
 */
export function buildPageContentDiff(
  beforeMarkdown: string,
  afterMarkdown: string,
): PageContentDiff {
  const before = canonicalizeWebMarkdown(beforeMarkdown);
  const after = canonicalizeWebMarkdown(afterMarkdown);
  if (before === after) {
    return {
      hasChanges: false,
      before,
      after,
      added: [],
      removed: [],
      summary: "",
    };
  }

  const beforeLines = pageContentLines(before);
  const afterLines = pageContentLines(after);
  const { added, removed } = boundedLineDiff(beforeLines, afterLines);
  const summaryAdded = added.slice(0, MAX_SUMMARY_LINES);
  const summaryRemoved = removed.slice(
    0,
    Math.max(0, MAX_SUMMARY_LINES - summaryAdded.length),
  );
  const summarySections = [
    renderSummarySection("Added", summaryAdded),
    renderSummarySection("Removed", summaryRemoved),
  ].filter(Boolean);

  return {
    // Canonical inequality is the authoritative change signal. The arrays are
    // only a bounded representation and may omit distant changed passages.
    hasChanges: true,
    before,
    after,
    added,
    removed,
    summary: summarySections.join("\n\n"),
  };
}

function renderSummarySection(label: string, lines: string[]): string {
  if (lines.length === 0) return "";
  return `**${label}:**\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

export function decidePageScoutAlert(input: {
  mode: PageScoutAlertMode;
  changeStatus: "new" | "same" | "changed" | "removed";
  hasNormalizedDiff: boolean;
  criteriaMatched: boolean | null;
  initialBaseline: boolean;
}): boolean {
  if (input.initialBaseline || input.changeStatus === "same") return false;
  if (!input.hasNormalizedDiff) return false;
  return input.mode === "any" ? true : input.criteriaMatched === true;
}

export function pageContentLines(content: string): string[] {
  return content
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      const chunks: string[] = [];
      for (let start = 0; start < trimmed.length; start += MAX_LINE_CHARS) {
        chunks.push(trimmed.slice(start, start + MAX_LINE_CHARS));
      }
      return chunks;
    });
}

function boundedLineDiff(
  before: string[],
  after: string[],
): { added: string[]; removed: string[] } {
  const remainingBefore = counts(before);
  const added: string[] = [];
  for (const line of after) {
    const count = remainingBefore.get(line) ?? 0;
    if (count > 0) {
      remainingBefore.set(line, count - 1);
    } else {
      added.push(line);
    }
  }

  const remainingAfter = counts(after);
  const removed: string[] = [];
  for (const line of before) {
    const count = remainingAfter.get(line) ?? 0;
    if (count > 0) {
      remainingAfter.set(line, count - 1);
    } else {
      removed.push(line);
    }
  }
  return { added, removed };
}

function counts(lines: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of lines) {
    result.set(line, (result.get(line) ?? 0) + 1);
  }
  return result;
}
