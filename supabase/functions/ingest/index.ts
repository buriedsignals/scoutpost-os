/**
 * ingest Edge Function — manual content ingestion pipeline.
 *
 * Accepts a URL or raw text, fetches/stores the content as a raw_capture,
 * then extracts atomic information_units through OpenRouter with embeddings.
 *
 * Route:
 *   POST /ingest
 *     body: { kind: "url"|"text", url?, text?, title?, criteria?, notes?, project_id? }
 *     -> 201 { ingest_id, raw_capture_id, units: [{id, statement}] }
 *
 * Auth: Supabase JWT or cj_ API key. API-key callers use the service client
 * with explicit user_id filters. Failures mark the ingests row status=error
 * with the truncated error message.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import {
  AuthedUser,
  getCallerClient,
  requireUserOrApiKey,
} from "../_shared/auth.ts";
import { getServiceClient, SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { normalizeDate } from "../_shared/date_utils.ts";
import { scrape } from "../_shared/scrape.ts";
import { EMBEDDING_MODEL_TAG, embedText } from "../_shared/embedding.ts";
import { openRouterExtract } from "../_shared/openrouter.ts";
import {
  compressContext,
  logCompressionStats,
} from "../_shared/taco_compress.ts";
import {
  type CanonicalUnitType,
  deriveSourceDomain,
  sha256Hex,
  upsertCanonicalUnit,
} from "../_shared/unit_dedup.ts";
import {
  findExactSourceExpression,
  recordSourceExpression,
  segmentSourceExpressionContent,
} from "../_shared/source_expressions.ts";

const IngestSchema = z
  .object({
    kind: z.enum(["url", "text"]),
    url: z.string().url().optional(),
    text: z.string().optional(),
    title: z.string().max(500).optional(),
    criteria: z.string().max(4000).optional(),
    notes: z.string().max(8000).optional(),
    project_id: z.string().uuid().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === "url" && !val.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "url is required when kind=url",
      });
    }
    if (val.kind === "text") {
      if (!val.text || val.text.length < 50) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["text"],
          message: "text is required (min 50 chars) when kind=text",
        });
      }
    }
  });

type IngestInput = z.infer<typeof IngestSchema>;

const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string" },
          type: { type: "string", enum: ["fact", "event", "entity_update"] },
          context_excerpt: { type: "string" },
          source_quote: {
            type: "string",
            description:
              "Exact contiguous text copied character-for-character from TEXT",
          },
          occurred_at: { type: ["string", "null"] },
          entities: { type: "array", items: { type: "string" } },
          criteria_match: {
            type: "boolean",
            description:
              "True only if this unit satisfies every explicit criterion; when no criteria is provided, true.",
          },
        },
        required: ["statement", "type", "criteria_match"],
        additionalProperties: false,
      },
    },
  },
  required: ["units"],
  additionalProperties: false,
};

interface ExtractedUnit {
  statement: string;
  type: "fact" | "event" | "entity_update";
  context_excerpt?: string;
  source_quote?: string;
  occurred_at?: string | null;
  entities?: string[];
  criteria_match?: boolean | null;
}

const RAW_CONTENT_MAX = 100_000;
const PROMPT_CONTENT_MAX = 12_000;

Deno.serve(async (req): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  let user: AuthedUser;
  try {
    user = await requireUserOrApiKey(req);
  } catch (e) {
    return jsonFromError(e);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/ingest/, "") || "/";

  if (path !== "/" || req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  try {
    return await handleIngest(req, user);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "ingest",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

async function handleIngest(req: Request, user: AuthedUser): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = IngestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  const input = parsed.data;

  const { db } = getCallerClient(user);

  // 1. Create ingests row (status=processing).
  const { data: ingest, error: insErr } = await db
    .from("ingests")
    .insert({
      user_id: user.id,
      kind: input.kind,
      source_url: input.kind === "url" ? input.url : null,
      title: input.title ?? null,
      criteria: input.criteria ?? null,
      notes: input.notes ?? null,
      project_id: input.project_id ?? null,
      status: "processing",
    })
    .select("*")
    .single();
  if (insErr) throw new Error(insErr.message);

  const ingestId = ingest.id as string;

  try {
    const result = await runPipeline(db, user, ingestId, input);

    await db
      .from("ingests")
      .update({ status: "success", completed_at: new Date().toISOString() })
      .eq("id", ingestId)
      .eq("user_id", user.id);

    logEvent({
      level: "info",
      fn: "ingest",
      event: "success",
      user_id: user.id,
      ingest_id: ingestId,
      raw_capture_id: result.raw_capture_id,
      unit_count: result.units.length,
    });

    return jsonOk(
      {
        ingest_id: ingestId,
        raw_capture_id: result.raw_capture_id,
        units: result.units,
      },
      201,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .from("ingests")
      .update({
        status: "error",
        error_message: msg.slice(0, 2000),
        completed_at: new Date().toISOString(),
      })
      .eq("id", ingestId)
      .eq("user_id", user.id);

    logEvent({
      level: "error",
      fn: "ingest",
      event: "failed",
      user_id: user.id,
      ingest_id: ingestId,
      msg,
    });
    throw e;
  }
}

interface PipelineResult {
  raw_capture_id: string;
  units: Array<{ id: string; statement: string }>;
}

async function runPipeline(
  db: SupabaseClient,
  user: AuthedUser,
  ingestId: string,
  input: IngestInput,
): Promise<PipelineResult> {
  const usageDb = getServiceClient();
  // 2. Fetch content.
  let content: string;
  let sourceUrl: string | null = null;
  let sourceTitle: string | null = input.title ?? null;

  if (input.kind === "url") {
    sourceUrl = input.url!;
    // Route through the scrape port so U7's SCRAPE_PROVIDER flip switches this
    // caller. HTML ingest is provider-agnostic (no PDF/changeTracking needs).
    const result = await scrape(sourceUrl);
    content = result.markdown ?? "";
    if (!sourceTitle && result.title) sourceTitle = result.title;
  } else {
    content = input.text!;
  }

  if (!content || !content.trim()) {
    throw new ValidationError("no content to ingest");
  }

  const truncated = content.slice(0, RAW_CONTENT_MAX);

  // 3. Hash + raw_capture insert.
  const contentHash = await sha256Hex(truncated);
  const sourceDomain = sourceUrl ? deriveSourceDomain(sourceUrl) : null;

  const { data: capture, error: capErr } = await db
    .from("raw_captures")
    .insert({
      user_id: user.id,
      ingest_id: ingestId,
      source_url: sourceUrl,
      source_domain: sourceDomain,
      content_md: truncated,
      content_sha256: contentHash,
      token_count: Math.ceil(truncated.length / 4),
      captured_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (capErr) throw new Error(capErr.message);
  const rawCaptureId = capture.id as string;

  // 4. Extract units through OpenRouter (TACO-compressed).
  const { text: compressedForPrompt, stats: ingestStats } = compressContext(
    truncated,
  );
  logCompressionStats("ingest", undefined, ingestStats);
  const promptText = compressedForPrompt.slice(0, PROMPT_CONTENT_MAX);
  const evidenceWindows = segmentSourceExpressionContent(truncated);
  const evidenceWindow = evidenceWindows[0]?.text ?? "";
  const evidenceCoverage = evidenceWindows.length <= 1 ? "full" : "partial";
  const criteriaBlock = input.criteria?.trim()
    ? `\nCRITERIA HARD FILTER: ${input.criteria}
Only return units that satisfy EVERY explicit criterion. If a fact only partially matches, return no unit for it.
For numeric, date, place, topic, source, role, status, threshold, inclusion, and exclusion criteria, exact requirements and limits are mandatory. Missing evidence is not a match.
Set criteria_match=false for any unit that fails or only partially satisfies the criteria.\n`
    : "";
  const prompt =
    "Extract up to 15 discrete factual statements from the following text. " +
    "For each, give a one-sentence `statement`, a `type` (fact|event|entity_update), " +
    "a `context_excerpt` (a short quoted snippet surrounding the statement), and " +
    "a `source_quote` copied character-for-character as one contiguous passage from " +
    "the SOURCE EVIDENCE WINDOW that supports the statement (omit it when no exact " +
    "passage is available), and " +
    "`occurred_at` as a date in ISO 8601 if one is stated (null otherwise), and " +
    "`entities` as a list of the named people, organizations, places, or policies mentioned. " +
    "Set `criteria_match` to true when no criteria are provided. " +
    "Return JSON matching the provided schema.\n" +
    criteriaBlock +
    "\nTEXT:\n" +
    promptText +
    "\n\nSOURCE EVIDENCE WINDOW (exact stored source text):\n" +
    evidenceWindow;

  const extraction = await openRouterExtract<{ units: ExtractedUnit[] }>(
    prompt,
    EXTRACTION_SCHEMA,
    {
      usage: {
        db: usageDb,
        userId: user.id,
        functionName: "ingest",
        operation: "ingest_extract_units",
        metadata: { ingest_id: ingestId },
      },
    },
  );
  const extracted = Array.isArray(extraction?.units) ? extraction.units : [];

  // 5. Embed + insert each unit.
  const inserted: Array<{ id: string; statement: string }> = [];
  for (const u of extracted) {
    if (!u || typeof u.statement !== "string" || !u.statement.trim()) continue;
    if (input.criteria?.trim() && u.criteria_match === false) continue;
    if (!["fact", "event", "entity_update"].includes(u.type)) continue;

    const embedding = await embedText(u.statement, "RETRIEVAL_DOCUMENT", {
      title: sourceTitle,
    });
    const unitType = u.type as CanonicalUnitType;
    const result = await upsertCanonicalUnit(db, {
      userId: user.id,
      statement: u.statement,
      unitType,
      entities: u.entities ?? [],
      embedding,
      embeddingModel: EMBEDDING_MODEL_TAG,
      sourceUrl,
      sourceDomain,
      sourceTitle,
      contextExcerpt: u.context_excerpt ?? null,
      occurredAt: normalizeDate(u.occurred_at),
      extractedAt: new Date().toISOString(),
      sourceType: "manual_ingest",
      contentSha256: contentHash,
      projectId: input.project_id ?? null,
      rawCaptureId,
      metadata: {
        ingest_id: ingestId,
        kind: input.kind,
      },
    });

    // Evidence recording is intentionally a second, best-effort operation.
    // A model-generated quote that is not an exact substring is rejected rather
    // than silently becoming evidence; a failed evidence insert never rolls
    // back the canonical unit.
    const anchor = await findExactSourceExpression(truncated, u.source_quote);
    if (anchor.ok) {
      try {
        await recordSourceExpression(usageDb, {
          userId: user.id,
          rawCaptureId,
          unitId: result.unitId,
          anchor: anchor.anchor,
          extractorVersion: "manual-ingest-v1",
          promptVersion: "manual-ingest-source-quote-v1",
          metadata: {
            ingest_id: ingestId,
            coverage: evidenceCoverage,
            evidence_window_count: evidenceWindows.length,
            candidate_capture_payload_sha256:
              anchor.anchor.capturePayloadSha256,
            candidate_passage_sha256: anchor.anchor.passageSha256,
          },
        });
      } catch (error) {
        logEvent({
          level: "warn",
          fn: "ingest",
          event: "source_expression_record_failed",
          user_id: user.id,
          ingest_id: ingestId,
          unit_id: result.unitId,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (u.source_quote) {
      logEvent({
        level: "info",
        fn: "ingest",
        event: "source_expression_not_recorded",
        user_id: user.id,
        ingest_id: ingestId,
        unit_id: result.unitId,
        reason: anchor.reason,
      });
    }

    if (result.createdCanonical) {
      inserted.push({
        id: result.unitId,
        statement: u.statement,
      });
    }
  }

  return { raw_capture_id: rawCaptureId, units: inserted };
}

// ---------------------------------------------------------------------------

// normalizeDate moved to ../_shared/date_utils.ts (imported at the top).
