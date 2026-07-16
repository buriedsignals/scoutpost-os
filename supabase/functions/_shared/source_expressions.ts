import type { SupabaseClient } from "./supabase.ts";
import { sha256Hex } from "./unit_dedup.ts";

export const SOURCE_EXPRESSION_LOCATOR_VERSION = "raw-md-utf8-byte-v1";
export const SOURCE_EXPRESSION_SEGMENTATION_VERSION = "line-window-v1";

export interface SourceExpressionAnchor {
  exactText: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  capturePayloadSha256: string;
  passageSha256: string;
}

export interface SourceExpressionWindow {
  text: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

export type SourceExpressionAnchorResult =
  | { ok: true; anchor: SourceExpressionAnchor }
  | { ok: false; reason: "empty_quote" | "not_found" | "ambiguous_quote" };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function lineForPrefix(value: string): number {
  return 1 + (value.match(/\n/g)?.length ?? 0);
}

/**
 * Deterministic line windows make extraction coverage explicit without
 * changing stored source text. A long line remains intact rather than being
 * cut through a UTF-8 sequence.
 */
export function segmentSourceExpressionContent(
  content: string,
  maxWindowBytes = 8_000,
): SourceExpressionWindow[] {
  if (!content) return [];
  const lines = content.match(/.*(?:\n|$)/g)?.filter((line) => line !== "") ??
    [];
  const windows: SourceExpressionWindow[] = [];
  let text = "";
  let startByte = 0;
  let startLine = 1;
  let cursorBytes = 0;
  let cursorLine = 1;

  const push = () => {
    if (!text) return;
    windows.push({
      text,
      startByte,
      endByte: startByte + byteLength(text),
      startLine,
      endLine: startLine + (text.match(/\n/g)?.length ?? 0),
    });
    text = "";
  };

  for (const line of lines) {
    if (text && byteLength(text) + byteLength(line) > maxWindowBytes) {
      push();
      startByte = cursorBytes;
      startLine = cursorLine;
    }
    if (!text) {
      startByte = cursorBytes;
      startLine = cursorLine;
    }
    text += line;
    cursorBytes += byteLength(line);
    cursorLine += line.match(/\n/g)?.length ?? 0;
  }
  push();
  return windows;
}

export async function findExactSourceExpression(
  captureContent: string,
  quoteCandidate: string | null | undefined,
): Promise<SourceExpressionAnchorResult> {
  const quote = quoteCandidate ?? "";
  if (!quote) return { ok: false, reason: "empty_quote" };
  const start = captureContent.indexOf(quote);
  if (start < 0) return { ok: false, reason: "not_found" };
  if (captureContent.indexOf(quote, start + quote.length) >= 0) {
    return { ok: false, reason: "ambiguous_quote" };
  }
  const exactText = quote;
  const startByte = byteLength(captureContent.slice(0, start));
  const endByte = startByte + byteLength(exactText);
  const startLine = lineForPrefix(captureContent.slice(0, start));
  const endLine = startLine + (exactText.match(/\n/g)?.length ?? 0);
  return {
    ok: true,
    anchor: {
      exactText,
      startByte,
      endByte,
      startLine,
      endLine,
      capturePayloadSha256: await sha256Hex(captureContent),
      passageSha256: await sha256Hex(exactText),
    },
  };
}

export interface RecordSourceExpressionInput {
  userId: string;
  rawCaptureId: string;
  unitId: string;
  unitOccurrenceId?: string | null;
  anchor: SourceExpressionAnchor;
  relationKind?: "supports" | "contradicts" | "context";
  language?: string | null;
  attribution?: string | null;
  isDirectQuote?: boolean;
  extractorVersion?: string | null;
  promptVersion?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordSourceExpression(
  db: SupabaseClient,
  input: RecordSourceExpressionInput,
): Promise<string> {
  const { data, error } = await db.rpc("record_source_expression", {
    p_user_id: input.userId,
    p_raw_capture_id: input.rawCaptureId,
    p_unit_id: input.unitId,
    p_unit_occurrence_id: input.unitOccurrenceId ?? null,
    p_start_byte: input.anchor.startByte,
    p_end_byte: input.anchor.endByte,
    p_relation_kind: input.relationKind ?? "supports",
    p_language: input.language ?? null,
    p_attribution: input.attribution ?? null,
    p_is_direct_quote: input.isDirectQuote ?? false,
    p_extractor_version: input.extractorVersion ?? null,
    p_prompt_version: input.promptVersion ?? null,
    p_metadata: input.metadata ?? {},
  });
  if (error) throw new Error(error.message);
  if (typeof data !== "string") {
    throw new Error("recordSourceExpression: missing expression id");
  }
  return data;
}
