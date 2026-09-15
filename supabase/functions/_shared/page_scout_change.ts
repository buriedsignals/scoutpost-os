import { canonicalizeWebMarkdown } from "./web_content_canonical.ts";
import { isConfiguredPageUrl } from "./subpage-filter.ts";

export const PAGE_SCOUT_MAX_CONTENT_CHARS = 150000;
export const PAGE_SCOUT_CONTENT_TOO_LONG_MESSAGE =
  "This page exceeds the Page Scout limit of 150,000 characters of normalized " +
  "extracted text. Choose a shorter or more specific page to monitor.";

export function isPageScoutContentTooLong(
  markdown: string | null | undefined,
): boolean {
  return canonicalizeWebMarkdown(markdown ?? "").length >
    PAGE_SCOUT_MAX_CONTENT_CHARS;
}

export type PageScoutAlertMode = "any" | "specific";

export interface PageContentOccurrence {
  text: string;
  /** Zero-based line index in the canonical before/after document. */
  index: number;
  previousCount: number;
  currentCount: number;
}

export interface PageContentMove {
  text: string;
  beforeText: string;
  afterText: string;
  /** One-based visible position or numbered-list rank. */
  from: number;
  /** One-based visible position or numbered-list rank. */
  to: number;
  beforeIndex: number;
  afterIndex: number;
  kind: "line" | "numbered";
}

export type PageContentChangeClass =
  | "none"
  | "same_scope_reorder"
  | "same_scope_duplicate_only"
  | "content";

export interface PageContentDiff {
  hasChanges: boolean;
  /** Deterministic alert classification after canonical comparison. */
  changeClass: PageContentChangeClass;
  before: string;
  after: string;
  added: string[];
  removed: string[];
  addedOccurrences: PageContentOccurrence[];
  removedOccurrences: PageContentOccurrence[];
  moves: PageContentMove[];
  summary: string;
}

const MAX_SUMMARY_LINES = 6;
const MAX_LINE_CHARS = 500;

/** Reject target error pages before their content can enter Page baselines. */
export function pageTargetErrorMessage(status: unknown): string | null {
  if (
    typeof status !== "number" || !Number.isInteger(status) || status < 400 ||
    status > 599
  ) {
    return null;
  }
  return `page returned HTTP ${status}`;
}

export const PAGE_RESPONSE_VALIDATION_VERSION = "page-response-v1";

export interface PageResponseInput {
  markdown?: string | null;
  status_code?: unknown;
  source_url?: string | null;
}

export type PageResponseOutcome =
  | "valid"
  | "target_http_error"
  | "empty_content"
  | "error_page"
  | "outside_configured_page";

export interface PageResponseValidation {
  version: typeof PAGE_RESPONSE_VALIDATION_VERSION;
  outcome: PageResponseOutcome;
  valid: boolean;
  message: string | null;
}

/**
 * Validate the complete capture, not the focused comparison projection.
 * Error-body recognition requires an entire diagnostic document, not a phrase
 * occurring in an article. Unknown templates remain eligible without a target
 * failure status; missing legacy status is not evidence of failure.
 */
export function validatePageResponse(
  response: PageResponseInput,
  configuredUrl?: string,
): PageResponseValidation {
  const result = (
    outcome: PageResponseOutcome,
    message: string | null,
  ): PageResponseValidation => ({
    version: PAGE_RESPONSE_VALIDATION_VERSION,
    outcome,
    valid: outcome === "valid",
    message,
  });
  if (
    configuredUrl &&
    !isConfiguredPageUrl(response.source_url ?? configuredUrl, configuredUrl)
  ) {
    return result(
      "outside_configured_page",
      "page scrape resolved outside the configured URL",
    );
  }
  const targetError = pageTargetErrorMessage(response.status_code);
  if (targetError) return result("target_http_error", targetError);
  const markdown = response.markdown?.trim() ?? "";
  if (!markdown) return result("empty_content", "page returned empty content");

  // Ignore standalone image/navigation markup, but never quotes, code fences,
  // or prose containing links. Remaining text must match the whole template.
  const body = markdown.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      !/^(?:!\[[^\[\]\n]*\]\([^\n()]*\)|\[(?:[^\[\]\n]*|!\[[^\[\]\n]*\]\([^\n()]*\))\]\([^\n()]*\))$/
        .test(line)
    )
    .map((line) => line.replace(/^#{1,6}\s+/, ""))
    .join(" ").replace(/\s+/g, " ").replace(/’/g, "'");
  const metaUnavailable =
    "This page isn't available The link may be broken, or the page may have been removed. Check to see if the link you're trying to open is correct.";
  const standardNotFound =
    /^(?:404(?: Error)?[: -]*Not Found|Not Found) The requested URL(?: [^\s]+)? was not found on this server\.?$/i;
  if (body === metaUnavailable || standardNotFound.test(body)) {
    return result("error_page", "page returned a confirmed error document");
  }
  return result("valid", null);
}

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
      changeClass: "none",
      before,
      after,
      added: [],
      removed: [],
      addedOccurrences: [],
      removedOccurrences: [],
      moves: [],
      summary: "",
    };
  }

  const beforeLines = pageContentLines(before);
  const afterLines = pageContentLines(after);
  const beforeSections = pageContentSectionLookup(beforeLines);
  const afterSections = pageContentSectionLookup(afterLines);
  const rawDiff = boundedLineDiff(
    beforeLines,
    afterLines,
    beforeSections,
    afterSections,
  );
  const numbered = reconcileNumberedMoves(
    rawDiff.removedOccurrences,
    rawDiff.addedOccurrences,
    beforeSections,
    afterSections,
  );
  const addedOccurrences = numbered.addedOccurrences;
  const removedOccurrences = numbered.removedOccurrences;
  const moves = numbered.moves.length > 0
    ? numbered.moves
    : addedOccurrences.length === 0 && removedOccurrences.length === 0
    ? exactLineMoves(beforeLines, afterLines)
    : [];
  const added = addedOccurrences.map((item) => item.text);
  const removed = removedOccurrences.map((item) => item.text);
  const changeClass = classifyPageContentChange(
    beforeLines,
    afterLines,
    beforeSections,
    afterSections,
  );
  const summaryAdded = addedOccurrences.slice(0, MAX_SUMMARY_LINES).map(
    summarizeOccurrence,
  );
  const summaryRemoved = removedOccurrences.slice(
    0,
    Math.max(0, MAX_SUMMARY_LINES - summaryAdded.length),
  ).map(summarizeOccurrence);
  const summaryMoves = moves.slice(
    0,
    Math.max(
      0,
      MAX_SUMMARY_LINES - summaryAdded.length - summaryRemoved.length,
    ),
  ).map((move) => `${move.text} (${move.from} → ${move.to})`);
  const summarySections = [
    renderSummarySection("Added", summaryAdded),
    renderSummarySection("Removed", summaryRemoved),
    renderSummarySection("Moved", summaryMoves),
  ].filter(Boolean);

  return {
    // Canonical inequality is the authoritative change signal. The arrays are
    // only a bounded representation and may omit distant changed passages.
    hasChanges: true,
    changeClass,
    before,
    after,
    added,
    removed,
    addedOccurrences,
    removedOccurrences,
    moves,
    summary: summarySections.join("\n\n"),
  };
}

function summarizeOccurrence(item: PageContentOccurrence): string {
  if (item.previousCount > 0 && item.currentCount > item.previousCount) {
    return `Additional occurrence (${item.previousCount} → ${item.currentCount}): ${item.text}`;
  }
  if (item.currentCount > 0 && item.previousCount > item.currentCount) {
    return `Removed occurrence (${item.previousCount} → ${item.currentCount}): ${item.text}`;
  }
  return item.text;
}

function renderSummarySection(label: string, lines: string[]): string {
  if (lines.length === 0) return "";
  return `**${label}:**\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

export function decidePageScoutAlert(input: {
  mode: PageScoutAlertMode;
  changeStatus: "new" | "same" | "changed" | "removed";
  hasAlertableDiff: boolean;
  criteriaMatched: boolean | null;
  initialBaseline: boolean;
}): boolean {
  if (input.initialBaseline || input.changeStatus === "same") return false;
  if (!input.hasAlertableDiff) return false;
  return input.mode === "any" ? true : input.criteriaMatched === true;
}

export function isAlertablePageContentDiff(diff: PageContentDiff): boolean {
  return diff.changeClass === "content";
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

/** Nearest preceding Markdown heading for each line, computed once per page. */
export function pageContentSectionLookup(lines: string[]): string[] {
  let section = "";
  return lines.map((line) => {
    if (/^#{1,6}\s+\S/.test(line)) section = line;
    return section;
  });
}

function boundedLineDiff(
  before: string[],
  after: string[],
  beforeSections: string[],
  afterSections: string[],
): {
  addedOccurrences: PageContentOccurrence[];
  removedOccurrences: PageContentOccurrence[];
} {
  const beforeCounts = counts(before);
  const afterCounts = counts(after);
  const beforeContexts = stableContextLookup(before, beforeCounts, afterCounts);
  const afterContexts = stableContextLookup(after, afterCounts, beforeCounts);
  const matchedBefore = new Set<number>();
  const matchedAfter = new Set<number>();
  matchQueuedOccurrences(
    before,
    after,
    beforeSections,
    afterSections,
    beforeContexts,
    afterContexts,
    matchedBefore,
    matchedAfter,
    true,
  );
  // Heading-free or entirely repeated text falls back to global ordinal
  // matching after the localized pass.
  matchQueuedOccurrences(
    before,
    after,
    beforeSections,
    afterSections,
    beforeContexts,
    afterContexts,
    matchedBefore,
    matchedAfter,
    false,
  );
  const addedOccurrences: PageContentOccurrence[] = [];
  for (const [index, line] of after.entries()) {
    if (!matchedAfter.has(index)) {
      addedOccurrences.push({
        text: line,
        index,
        previousCount: beforeCounts.get(line) ?? 0,
        currentCount: afterCounts.get(line) ?? 0,
      });
    }
  }

  const removedOccurrences: PageContentOccurrence[] = [];
  for (const [index, line] of before.entries()) {
    if (!matchedBefore.has(index)) {
      removedOccurrences.push({
        text: line,
        index,
        previousCount: beforeCounts.get(line) ?? 0,
        currentCount: afterCounts.get(line) ?? 0,
      });
    }
  }
  return { addedOccurrences, removedOccurrences };
}

function stableContextLookup(
  lines: string[],
  ownCounts: Map<string, number>,
  otherCounts: Map<string, number>,
): string[] {
  const stable = new Set<string>();
  for (const [line, count] of ownCounts) {
    if (count === otherCounts.get(line) && !/^#{1,6}\s+\S/.test(line)) {
      stable.add(line);
    }
  }
  const contexts = new Array<string>(lines.length).fill("");
  let nearest = "";
  for (let index = 0; index < lines.length; index++) {
    contexts[index] = nearest;
    if (stable.has(lines[index])) nearest = lines[index];
  }
  let following = "";
  for (let index = lines.length - 1; index >= 0; index--) {
    contexts[index] = `${contexts[index]}\u0000${following}`;
    if (stable.has(lines[index])) following = lines[index];
  }
  return contexts;
}

function occurrenceKey(
  line: string,
  section: string,
  context: string,
  scoped: boolean,
): string {
  return scoped ? `${line}\u0000${section}\u0000${context}` : line;
}

function matchQueuedOccurrences(
  before: string[],
  after: string[],
  beforeSections: string[],
  afterSections: string[],
  beforeContexts: string[],
  afterContexts: string[],
  matchedBefore: Set<number>,
  matchedAfter: Set<number>,
  scoped: boolean,
): void {
  const afterQueues = new Map<string, number[]>();
  for (const [index, line] of after.entries()) {
    if (matchedAfter.has(index)) continue;
    const key = occurrenceKey(
      line,
      afterSections[index],
      afterContexts[index],
      scoped,
    );
    const queue = afterQueues.get(key) ?? [];
    queue.push(index);
    afterQueues.set(key, queue);
  }
  const cursors = new Map<string, number>();
  for (const [index, line] of before.entries()) {
    if (matchedBefore.has(index)) continue;
    const key = occurrenceKey(
      line,
      beforeSections[index],
      beforeContexts[index],
      scoped,
    );
    const queue = afterQueues.get(key);
    const cursor = cursors.get(key) ?? 0;
    if (!queue || cursor >= queue.length) continue;
    matchedBefore.add(index);
    matchedAfter.add(queue[cursor]);
    cursors.set(key, cursor + 1);
  }
}

function counts(lines: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of lines) {
    result.set(line, (result.get(line) ?? 0) + 1);
  }
  return result;
}

function classifyPageContentChange(
  beforeLines: string[],
  afterLines: string[],
  beforeSections: string[],
  afterSections: string[],
): PageContentChangeClass {
  if (hasRepeatedHeading(beforeLines) || hasRepeatedHeading(afterLines)) {
    return "content";
  }
  const beforeCounts = scopedIdentityCounts(beforeLines, beforeSections);
  const afterCounts = scopedIdentityCounts(afterLines, afterSections);
  if (!sameIdentityKeys(beforeCounts, afterCounts)) return "content";

  for (const [key, count] of beforeCounts) {
    if (afterCounts.get(key) !== count) {
      return "same_scope_duplicate_only";
    }
  }
  return "same_scope_reorder";
}

function hasRepeatedHeading(lines: string[]): boolean {
  const seen = new Set<string>();
  for (const line of lines) {
    if (!/^#{1,6}\s+\S/.test(line)) continue;
    if (seen.has(line)) return true;
    seen.add(line);
  }
  return false;
}

function scopedIdentityCounts(
  lines: string[],
  sections: string[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    const identity = numberedLine(line)?.body ?? line;
    const key = `${sections[index] ?? ""}\u0000${identity}`;
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function sameIdentityKeys(
  before: Map<string, number>,
  after: Map<string, number>,
): boolean {
  if (before.size !== after.size) return false;
  for (const key of before.keys()) {
    if (!after.has(key)) return false;
  }
  return true;
}

interface NumberedLine {
  rank: number;
  body: string;
}

function numberedLine(value: string): NumberedLine | null {
  const match = /^(\d{1,3})[.)]\s+(.+)$/.exec(value);
  if (!match) return null;
  const rank = Number(match[1]);
  return Number.isInteger(rank) && rank > 0
    ? { rank, body: match[2].trim() }
    : null;
}

function reconcileNumberedMoves(
  removed: PageContentOccurrence[],
  added: PageContentOccurrence[],
  beforeSections: string[],
  afterSections: string[],
): {
  removedOccurrences: PageContentOccurrence[];
  addedOccurrences: PageContentOccurrence[];
  moves: PageContentMove[];
} {
  const consumedAdded = new Set<number>();
  const consumedRemoved = new Set<number>();
  const moves: PageContentMove[] = [];
  reconcileNumberedMoveQueues(
    removed,
    added,
    beforeSections,
    afterSections,
    true,
    consumedRemoved,
    consumedAdded,
    moves,
  );
  reconcileNumberedMoveQueues(
    removed,
    added,
    beforeSections,
    afterSections,
    false,
    consumedRemoved,
    consumedAdded,
    moves,
  );

  return {
    removedOccurrences: removed.filter((item) =>
      !consumedRemoved.has(item.index)
    ),
    addedOccurrences: added.filter((item) => !consumedAdded.has(item.index)),
    moves: moves.sort((a, b) => a.afterIndex - b.afterIndex),
  };
}

function reconcileNumberedMoveQueues(
  removed: PageContentOccurrence[],
  added: PageContentOccurrence[],
  beforeSections: string[],
  afterSections: string[],
  scoped: boolean,
  consumedRemoved: Set<number>,
  consumedAdded: Set<number>,
  moves: PageContentMove[],
): void {
  const addedByBody = new Map<
    string,
    Array<{ occurrence: PageContentOccurrence; parsed: NumberedLine }>
  >();
  for (const occurrence of added) {
    if (consumedAdded.has(occurrence.index)) continue;
    const parsed = numberedLine(occurrence.text);
    if (!parsed) continue;
    const key = occurrenceKey(
      parsed.body,
      afterSections[occurrence.index] ?? "",
      "",
      scoped,
    );
    const queue = addedByBody.get(key) ?? [];
    queue.push({ occurrence, parsed });
    addedByBody.set(key, queue);
  }
  const cursors = new Map<string, number>();
  for (const occurrence of removed) {
    if (consumedRemoved.has(occurrence.index)) continue;
    const parsed = numberedLine(occurrence.text);
    if (!parsed) continue;
    const key = occurrenceKey(
      parsed.body,
      beforeSections[occurrence.index] ?? "",
      "",
      scoped,
    );
    const queue = addedByBody.get(key);
    const cursor = cursors.get(key) ?? 0;
    const match = queue?.[cursor];
    if (!match || match.parsed.rank === parsed.rank) continue;
    consumedRemoved.add(occurrence.index);
    consumedAdded.add(match.occurrence.index);
    cursors.set(key, cursor + 1);
    moves.push({
      text: parsed.body,
      beforeText: occurrence.text,
      afterText: match.occurrence.text,
      from: parsed.rank,
      to: match.parsed.rank,
      beforeIndex: occurrence.index,
      afterIndex: match.occurrence.index,
      kind: "numbered",
    });
  }
}

function occurrenceTokens(lines: string[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = (seen.get(line) ?? 0) + 1;
    seen.set(line, occurrence);
    return `${line}\u0000${occurrence}`;
  });
}

function exactLineMoves(before: string[], after: string[]): PageContentMove[] {
  if (before.length !== after.length || before.length === 0) return [];
  const beforeTokens = occurrenceTokens(before);
  const beforeIndex = new Map(
    beforeTokens.map((token, index) => [token, index]),
  );
  const afterTokens = occurrenceTokens(after);
  const sequence = afterTokens.map((token) => beforeIndex.get(token) ?? -1);
  if (sequence.some((index) => index < 0)) return [];
  const stableAfterIndexes = longestIncreasingSubsequenceIndexes(sequence);
  return afterTokens.flatMap((token, afterIndex) => {
    const fromIndex = beforeIndex.get(token);
    if (
      fromIndex === undefined || fromIndex === afterIndex ||
      stableAfterIndexes.has(afterIndex)
    ) {
      return [];
    }
    return [{
      text: after[afterIndex],
      beforeText: before[fromIndex],
      afterText: after[afterIndex],
      from: fromIndex + 1,
      to: afterIndex + 1,
      beforeIndex: fromIndex,
      afterIndex,
      kind: "line" as const,
    }];
  });
}

function longestIncreasingSubsequenceIndexes(values: number[]): Set<number> {
  const tails: number[] = [];
  const tailIndexes: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  for (let index = 0; index < values.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle] < values[index]) low = middle + 1;
      else high = middle;
    }
    tails[low] = values[index];
    if (low > 0) previous[index] = tailIndexes[low - 1];
    tailIndexes[low] = index;
  }
  const result = new Set<number>();
  let cursor = tailIndexes[tails.length - 1] ?? -1;
  while (cursor >= 0) {
    result.add(cursor);
    cursor = previous[cursor];
  }
  return result;
}
