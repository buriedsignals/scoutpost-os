import { discoverCivicDocumentsFromTrackedPages } from "./civic_links.ts";
import { parseDocument } from "./docparse.ts";
import { openRouterExtract } from "./openrouter.ts";
import { compressContext } from "./taco_compress.ts";
import { sha256Hex } from "./unit_dedup.ts";
import {
  buildCivicCandidatePrompt,
  buildCivicVerifierPrompt,
  CIVIC_CANDIDATE_SCHEMA,
  CIVIC_POLICY_VERSION,
  CIVIC_VERIFIER_SCHEMA,
  type CivicCandidate,
  type CivicEligibleItem,
  classifyCivicCandidates,
} from "./civic_accountability.ts";

const PREVIEW_MARKDOWN_MAX = 15_000;

export interface CivicPreviewPromise {
  promise_text: string;
  context: string;
  source_url: string;
  source_date: string;
  due_date?: string;
  date_confidence: string;
  criteria_match: boolean;
}

export type CivicPreviewItem = CivicEligibleItem & {
  source_url: string;
  source_title: string | null;
};

export interface CivicPreviewDocument {
  source_url: string;
  title?: string;
  content_hash: string;
  items: CivicPreviewItem[];
  promises: CivicPreviewPromise[];
  rejection_counts: Record<string, number>;
}

export interface CivicPreviewBundle {
  documentsFound: number;
  documentsResolved: number;
  sourceResults: Array<{
    url: string;
    outcome: "evaluated" | "no_documents" | "parse_failed" | "model_failed";
  }>;
  documents: CivicPreviewDocument[];
  policyVersion: string;
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
  const sourceResults: CivicPreviewBundle["sourceResults"] = [];
  if (documentUrls.length === 0) {
    for (const sourceUrl of trackedUrls) {
      sourceResults.push({ url: sourceUrl, outcome: "no_documents" });
    }
  }
  const maxPromisesPerDocument = Math.max(1, opts.maxPromisesPerDocument ?? 10);

  for (const documentUrl of documentUrls) {
    let scraped;
    try {
      // Doc-parse port: PDF → text, HTML → markdown. A scanned PDF throws
      // NeedsOcrError, caught here and skipped like any other parse failure.
      scraped = await parseDocument(documentUrl, { workloadClass: "utility" });
    } catch {
      sourceResults.push({ url: documentUrl, outcome: "parse_failed" });
      continue;
    }

    const rawMarkdown = (scraped.markdown ?? "").slice(0, 80_000);
    const { text: markdown } = compressContext(
      rawMarkdown.slice(0, PREVIEW_MARKDOWN_MAX),
    );
    if (!markdown.trim()) {
      sourceResults.push({ url: documentUrl, outcome: "parse_failed" });
      continue;
    }

    const prompt = buildCivicCandidatePrompt(markdown, {
      criteria,
      languageName: "English",
      referenceDate: extractDateFromUrl(documentUrl) || null,
    });
    let extraction: { candidates: CivicCandidate[] };
    try {
      extraction = await openRouterExtract(prompt, CIVIC_CANDIDATE_SCHEMA);
    } catch {
      sourceResults.push({ url: documentUrl, outcome: "model_failed" });
      continue;
    }

    let verification: { candidates: CivicCandidate[] };
    try {
      verification = await openRouterExtract(
        buildCivicVerifierPrompt(markdown, extraction.candidates ?? [], {
          criteria,
          languageName: "English",
          referenceDate: extractDateFromUrl(documentUrl) || null,
        }),
        CIVIC_VERIFIER_SCHEMA,
      );
    } catch {
      sourceResults.push({ url: documentUrl, outcome: "model_failed" });
      continue;
    }
    const sourceDateFromUrl = extractDateFromUrl(documentUrl);
    const classified = classifyCivicCandidates(
      Array.isArray(verification.candidates) ? verification.candidates : [],
      { today: new Date().toISOString().slice(0, 10), sourceText: markdown },
    );
    const items = classified.items.slice(0, maxPromisesPerDocument).map((
      item,
    ) => ({
      ...item,
      source_url: documentUrl,
      source_title: scraped.title ?? null,
    }));
    // Keep the historical promise-only projection for existing callers while
    // moving every new consumer to the discriminated `items` collection.
    const promises = items.flatMap((item): CivicPreviewPromise[] =>
      item.kind === "promise"
        ? [{
          promise_text: item.statement,
          context: item.context,
          source_url: documentUrl,
          source_date: item.meeting_date ?? sourceDateFromUrl,
          due_date: item.due_date,
          date_confidence: item.date_confidence,
          criteria_match: true,
        }]
        : []
    );

    documents.push({
      source_url: documentUrl,
      title: scraped.title,
      content_hash: await sha256Hex(rawMarkdown),
      items,
      promises,
      rejection_counts: classified.rejectionCounts,
    });
    sourceResults.push({ url: documentUrl, outcome: "evaluated" });
  }

  return {
    documentsFound: documents.length,
    documentsResolved: documentUrls.length,
    sourceResults,
    documents,
    policyVersion: CIVIC_POLICY_VERSION,
  };
}

function extractDateFromUrl(url: string): string {
  return url.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
}
