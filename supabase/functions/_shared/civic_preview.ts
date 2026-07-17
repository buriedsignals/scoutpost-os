import { discoverCivicDocumentsFromTrackedPages } from "./civic_links.ts";
import { parseDocument } from "./docparse.ts";
import { openRouterExtract } from "./openrouter.ts";
import { compressContext } from "./taco_compress.ts";

const PREVIEW_MARKDOWN_MAX = 15_000;

const PREVIEW_EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    promises: {
      type: "array",
      items: {
        type: "object",
        properties: {
          promise_text: { type: "string" },
          context: { type: "string" },
          source_date: { type: "string", nullable: true },
          due_date: { type: "string", nullable: true },
          date_confidence: { type: "string" },
        },
        required: ["promise_text"],
      },
    },
  },
  required: ["promises"],
};

interface ExtractedPreviewPromise {
  promise_text: string;
  context?: string;
  source_date?: string | null;
  due_date?: string | null;
  date_confidence?: string;
}

export interface CivicPreviewPromise {
  promise_text: string;
  context: string;
  source_url: string;
  source_date: string;
  due_date?: string;
  date_confidence: string;
  criteria_match: boolean;
}

export interface CivicPreviewDocument {
  source_url: string;
  title?: string;
  promises: CivicPreviewPromise[];
}

export interface CivicPreviewBundle {
  documentsFound: number;
  documents: CivicPreviewDocument[];
}

export async function previewCivicTrackedUrls(
  trackedUrls: string[],
  criteria?: string,
  opts: { maxDocs?: number; maxPromisesPerDocument?: number } = {},
): Promise<CivicPreviewBundle> {
  const { documentUrls } = await discoverCivicDocumentsFromTrackedPages(
    trackedUrls,
    {
      maxDocs: opts.maxDocs ?? 5,
    },
  );

  const documents: CivicPreviewDocument[] = [];
  const maxPromisesPerDocument = Math.max(1, opts.maxPromisesPerDocument ?? 10);

  for (const documentUrl of documentUrls) {
    let scraped;
    try {
      // Doc-parse port: PDF → text, HTML → markdown. A scanned PDF throws
      // NeedsOcrError, caught here and skipped like any other parse failure.
      scraped = await parseDocument(documentUrl);
    } catch {
      continue;
    }

    const { text: markdown } = compressContext(
      (scraped.markdown ?? "").slice(0, PREVIEW_MARKDOWN_MAX),
    );
    if (!markdown.trim()) continue;

    const prompt = buildPreviewPrompt(markdown, documentUrl, criteria);
    let extraction: { promises: ExtractedPreviewPromise[] };
    try {
      extraction = await openRouterExtract(prompt, PREVIEW_EXTRACTION_SCHEMA);
    } catch {
      continue;
    }

    const sourceDateFromUrl = extractDateFromUrl(documentUrl);
    const promises =
      (Array.isArray(extraction.promises) ? extraction.promises : [])
        .filter((promise) =>
          promise && typeof promise.promise_text === "string" &&
          promise.promise_text.trim()
        )
        .slice(0, maxPromisesPerDocument)
        .map((promise): CivicPreviewPromise => ({
          promise_text: promise.promise_text.trim(),
          context: promise.context ?? "",
          source_url: documentUrl,
          source_date: normalizeDate(promise.source_date) ?? sourceDateFromUrl,
          due_date: normalizeDate(promise.due_date) ?? undefined,
          date_confidence: normalizeConfidence(promise.date_confidence) ??
            "low",
          criteria_match: true,
        }));

    documents.push({
      source_url: documentUrl,
      title: scraped.title,
      promises,
    });
  }

  return {
    documentsFound: documents.length,
    documents,
  };
}

function buildPreviewPrompt(
  markdown: string,
  sourceUrl: string,
  criteria?: string,
): string {
  const sourceDate = extractDateFromUrl(sourceUrl);
  const dateInstructions = [
    "- source_date: ISO date string (YYYY-MM-DD). Use the meeting/document date when mentioned; otherwise use null.",
    "- due_date: ISO date string (YYYY-MM-DD) for a future deadline if mentioned; otherwise null.",
    "- date_confidence: one of 'high', 'medium', or 'low' depending on how explicit the date is.",
  ].join("\n");

  if (criteria && criteria.trim()) {
    return [
      "You are a civic data analyst. Read the following council meeting text.",
      `Extract ONLY promises, commitments, decisions, or investments that are directly relevant to: "${criteria.trim()}".`,
      `If nothing in the document relates to "${criteria.trim()}", return an empty array [].`,
      "Do not return unrelated items.",
      "For each item return a JSON object with:",
      "- promise_text: short summary of the commitment",
      "- context: relevant supporting quote or excerpt",
      dateInstructions,
      "Return ONLY a JSON object matching the provided schema.",
      sourceDate ? `Document date from URL: ${sourceDate}` : "",
      markdown,
    ].filter(Boolean).join("\n\n");
  }

  return [
    "You are a civic data analyst. Read the following council meeting text.",
    "Extract every explicit promise, commitment, decision, vote, or planned investment with a future action or timeline.",
    "Keep context brief and evidence-based.",
    "For each item return a JSON object with:",
    "- promise_text: short summary of the commitment",
    "- context: relevant supporting quote or excerpt",
    dateInstructions,
    "Focus on budget approvals, infrastructure investments, construction projects, policy decisions, regulatory changes, and formal commitments.",
    "Return ONLY a JSON object matching the provided schema.",
    sourceDate ? `Document date from URL: ${sourceDate}` : "",
    markdown,
  ].filter(Boolean).join("\n\n");
}

function extractDateFromUrl(url: string): string {
  return url.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeConfidence(
  value: string | null | undefined,
): "high" | "medium" | "low" | null {
  if (!value) return null;
  const lowered = value.trim().toLowerCase();
  if (lowered === "high" || lowered === "medium" || lowered === "low") {
    return lowered;
  }
  return null;
}
