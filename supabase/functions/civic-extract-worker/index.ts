/**
 * civic-extract-worker Edge Function — drains civic_extraction_queue.
 *
 * Triggered by pg_cron every 2 minutes with empty body `{}`. The function
 * claims one queue row with an explicit renewable lease (SKIP LOCKED), scrapes
 * the source URL through Firecrawl, extracts promises/commitments via
 * OpenRouter (JSON-schema-constrained), persists a raw_capture plus N
 * promise rows, and finalizes the queue row while it still owns the lease.
 *
 * On failure an ownership-checked RPC releases retryable work or terminally
 * fails the final attempt. The failsafe reclaims expired worker leases.
 *
 * Auth: shared service auth (pg_cron uses X-Service-Key from Vault; service-
 *       role bearer remains a tooling fallback).
 */

import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient, SupabaseClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { AuthError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { NeedsOcrError, parseDocument } from "../_shared/docparse.ts";
import { EMBEDDING_MODEL_TAG, embedText } from "../_shared/embedding.ts";
import { openRouterExtract } from "../_shared/openrouter.ts";
import { languageName } from "../_shared/atomic_extract.ts";
import {
  compressContext,
  logCompressionStats,
} from "../_shared/taco_compress.ts";
import { sendCivicAlert } from "../_shared/notifications.ts";
import {
  deriveSourceDomain,
  sha256Hex,
  upsertCanonicalUnit,
} from "../_shared/unit_dedup.ts";
import {
  classifyRunError,
  markNotificationAttempted,
  markNotificationResult,
  markRunError,
  markRunStage,
  shouldIncrementScoutFailure,
} from "../_shared/run_lifecycle.ts";
import { incrementAndMaybeNotify } from "../_shared/scout_failures.ts";
import {
  buildCivicCandidatePrompt,
  buildCivicVerifierPrompt,
  CIVIC_CANDIDATE_SCHEMA,
  CIVIC_POLICY_VERSION,
  CIVIC_VERIFIER_SCHEMA,
  type CivicCandidate,
  type CivicEligibleItem,
  classifyCivicCandidates,
  retainCivicPromiseAlertItems,
  shouldAlertForNewCivicItem,
} from "../_shared/civic_accountability.ts";
import { upsertCivicDocumentMembership } from "../_shared/civic_document_membership.ts";

const RAW_CONTENT_MAX = 80_000;
const PROMPT_CONTENT_MAX = 40_000;
const ERROR_MAX = 2_000;
const PROCESSED_URLS_CAP = 100;
const DEFAULT_LEASE_SECONDS = 900;
const DEFAULT_MAX_ATTEMPTS = 3;
// raw_captures TTL — 30-day retention. Long enough to re-extract promises on
// a bug-fix deploy, short enough that we are not permanently storing civic
// PDFs' extracted markdown. The cleanup_raw_captures pg_cron job scheduled
// in migration 00014 runs daily at 03:20 UTC and deletes rows where
// expires_at < now(); setting the field here is what activates that job.
const RAW_CAPTURE_TTL_DAYS = 30;

interface QueueRow {
  id: string;
  user_id: string;
  scout_id: string;
  scout_run_id: string | null;
  source_url: string;
  doc_kind: string;
  attempts: number;
  lease_owner: string;
  lease_expires_at: string;
  heartbeat_at: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  try {
    requireServiceKey(req);
  } catch (e) {
    return jsonFromError(e instanceof AuthError ? e : new AuthError());
  }

  // Operators/benchmarks may target one run so a deterministic drain does not
  // consume unrelated fleet work. Empty body preserves the cron worker path.
  let requestedRunId: string | null = null;
  try {
    const body = await req.json().catch(() => ({})) as {
      scout_run_id?: unknown;
    };
    if (body.scout_run_id !== undefined) {
      if (
        typeof body.scout_run_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(body.scout_run_id)
      ) {
        return jsonError("scout_run_id must be a UUID", 400);
      }
      requestedRunId = body.scout_run_id;
    }
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const svc = getServiceClient();
  const workerId = crypto.randomUUID();
  const leaseSeconds = envInt(
    "CIVIC_QUEUE_LEASE_SECONDS",
    DEFAULT_LEASE_SECONDS,
    60,
    3600,
  );
  const maxAttempts = envInt(
    "CIVIC_QUEUE_MAX_ATTEMPTS",
    DEFAULT_MAX_ATTEMPTS,
    1,
    10,
  );

  // Claim one queue row (SKIP LOCKED; expired-lease recovery built in).
  let claimed: QueueRow | null;
  try {
    const { data, error } = await svc.rpc("claim_civic_queue_item", {
      p_worker_id: workerId,
      p_scout_run_id: requestedRunId,
      p_lease_seconds: leaseSeconds,
      p_max_attempts: maxAttempts,
    });
    if (error) throw new Error(error.message);
    const rows = Array.isArray(data) ? data : [];
    claimed = rows.length > 0 ? (rows[0] as QueueRow) : null;
  } catch (e) {
    logEvent({
      level: "error",
      fn: "civic-extract-worker",
      event: "claim_failed",
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }

  if (!claimed) {
    return jsonOk({ status: "idle" });
  }

  const queueId = claimed.id;

  try {
    const result = await processItem(svc, claimed, workerId, leaseSeconds);
    logEvent({
      level: "info",
      fn: "civic-extract-worker",
      event: "processed",
      user_id: claimed.user_id,
      scout_id: claimed.scout_id,
      queue_id: queueId,
      promises_extracted: result.promises_extracted,
      merged_existing_count: result.merged_existing_count,
    });
    return jsonOk({
      status: "processed",
      queue_id: queueId,
      promises_extracted: result.promises_extracted,
      merged_existing_count: result.merged_existing_count,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let failureStatus = "lease_lost";
    try {
      const { data, error } = await svc.rpc("fail_civic_queue_item", {
        p_queue_id: queueId,
        p_worker_id: workerId,
        p_error: msg.slice(0, ERROR_MAX),
        p_max_attempts: maxAttempts,
      });
      if (error) throw new Error(error.message);
      failureStatus = typeof data === "string" ? data : "lease_lost";
      if (failureStatus === "failed") {
        await markLinkedRunFailedIfSettled(svc, claimed, msg);
      }
    } catch (markErr) {
      logEvent({
        level: "error",
        fn: "civic-extract-worker",
        event: "mark_failed_failed",
        queue_id: queueId,
        msg: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
    logEvent({
      level: "error",
      fn: "civic-extract-worker",
      event: failureStatus === "failed"
        ? "failed"
        : failureStatus === "pending"
        ? "retry_scheduled"
        : "lease_lost",
      queue_id: queueId,
      scout_id: claimed.scout_id,
      attempts: claimed.attempts,
      msg,
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

async function markLinkedRunFailedIfSettled(
  svc: SupabaseClient,
  row: QueueRow,
  message: string,
): Promise<void> {
  if (!row.scout_run_id) return;

  const { data: activeRows, error: activeErr } = await svc
    .from("civic_extraction_queue")
    .select("id")
    .eq("scout_run_id", row.scout_run_id)
    .in("status", ["pending", "processing"])
    .limit(1);
  if (activeErr) throw new Error(activeErr.message);
  if ((activeRows ?? []).length > 0) return;

  const classified = classifyRunError(new Error(message), "extract");
  await markRunError(svc, row.scout_run_id, {
    stage: classified.stage,
    errorClass: classified.errorClass,
    message: classified.message,
  });
  if (shouldIncrementScoutFailure(classified.errorClass)) {
    await incrementAndMaybeNotify(svc, {
      scoutId: row.scout_id,
      userId: row.user_id,
      scoutName: "Civic Scout",
      scoutType: "civic",
      language: null,
    });
  }
}

interface ProcessResult {
  raw_capture_id: string;
  promises_extracted: number;
  merged_existing_count: number;
}

async function processItem(
  svc: SupabaseClient,
  row: QueueRow,
  workerId: string,
  leaseSeconds: number,
): Promise<ProcessResult> {
  // 1. Load the owning scout so we can stamp scout_id + user_id consistently
  //    on downstream rows (and confirm the scout still exists).
  const { data: scout, error: scoutErr } = await svc
    .from("scouts")
    .select("id, user_id, name, preferred_language, criteria, project_id")
    .eq("id", row.scout_id)
    .maybeSingle();
  if (scoutErr) throw new Error(scoutErr.message);
  if (!scout) throw new Error(`scout ${row.scout_id} not found`);

  const userId = (scout.user_id as string) ?? row.user_id;
  const { data: queueSemantics, error: queueSemanticsErr } = await svc
    .from("civic_extraction_queue")
    .select(
      "ingestion_mode, civic_policy_version, semantics_snapshot, preview_snapshot_id, repair_batch_id, repair_batch_item_id",
    )
    .eq("id", row.id)
    .maybeSingle();
  if (queueSemanticsErr) throw new Error(queueSemanticsErr.message);
  const ingestionMode = queueSemantics?.ingestion_mode === "initial" ||
      queueSemantics?.ingestion_mode === "repair"
    ? queueSemantics.ingestion_mode
    : "scheduled";
  await heartbeatCivicLease(svc, row.id, workerId, leaseSeconds);

  // 2. Parse the source document (PDF → text, or HTML → markdown) through the
  //    default self-hosted pdftotext/Crawl4AI service.
  if (row.scout_run_id) {
    await markRunStage(svc, row.scout_run_id, "scrape");
  }
  // The native Google PDF fallback through OpenRouter yields non-deterministic
  // text, but civic-execute suppresses re-enqueueing already-processed URLs
  // (scouts.processed_pdf_urls), so each doc is parsed once and does not cause
  // content_sha256 churn across runs.
  let scraped;
  try {
    scraped = await parseDocument(row.source_url, {
      workloadClass: "scout",
      tenantKey: userId,
    });
  } catch (e) {
    // A scanned (bitmap-only) PDF has no extractable text. Production has
    // never OCR'd, so this is the same outcome as the legacy empty-markdown
    // path — surface it with the identical message for run classification.
    if (e instanceof NeedsOcrError) {
      throw new Error("document parse returned empty markdown (needs OCR)");
    }
    throw e;
  }
  const markdown = (scraped.markdown ?? "").slice(0, RAW_CONTENT_MAX);
  if (!markdown.trim()) {
    throw new Error("document parse returned empty markdown");
  }

  const contentHash = await sha256Hex(markdown);
  const sourceDomain = deriveSourceDomain(row.source_url);
  if (ingestionMode === "repair") {
    if (
      !queueSemantics?.repair_batch_id || !queueSemantics.repair_batch_item_id
    ) {
      throw new Error(
        "repair queue row is missing its approved ledger reference",
      );
    }
    const { data: repairItem, error: repairItemError } = await svc
      .from("civic_repair_batch_items")
      .select("expected_content_sha256, status, batch_id")
      .eq("id", queueSemantics.repair_batch_item_id)
      .eq("batch_id", queueSemantics.repair_batch_id)
      .maybeSingle();
    if (repairItemError) throw new Error(repairItemError.message);
    if (!repairItem || repairItem.status !== "approved") {
      throw new Error("repair ledger item is not approved");
    }
    if (repairItem.expected_content_sha256 !== contentHash) {
      throw new Error(
        "repair source bytes no longer match the approved content hash",
      );
    }
  }
  await heartbeatCivicLease(svc, row.id, workerId, leaseSeconds);

  // 3. Insert raw_captures with a 30-day TTL so cleanup_raw_captures
  //    actually deletes this row (the cron job was effectively a no-op
  //    because expires_at was never populated on insert).
  const capturedAt = new Date();
  const expiresAt = new Date(
    capturedAt.getTime() + RAW_CAPTURE_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  const { data: capture, error: capErr } = await svc
    .from("raw_captures")
    .insert({
      user_id: userId,
      scout_id: row.scout_id,
      scout_run_id: row.scout_run_id,
      source_url: row.source_url,
      source_domain: sourceDomain,
      content_md: markdown,
      content_sha256: contentHash,
      token_count: Math.ceil(markdown.length / 4),
      captured_at: capturedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();
  if (capErr) throw new Error(capErr.message);
  const rawCaptureId = capture.id as string;

  // 4. Initial imports must use the exact reviewed preview items. Scheduled
  // work performs extraction normally. Neither path trusts client content.
  let candidateItems: CivicCandidate[] = [];
  let extracted: CivicEligibleItem[];
  if (ingestionMode === "initial") {
    extracted = await loadInitialSnapshotItems(svc, {
      snapshotId: queueSemantics?.preview_snapshot_id as string | null,
      userId,
      scoutId: row.scout_id,
      sourceUrl: row.source_url,
      contentHash,
      policyVersion: queueSemantics?.civic_policy_version as string | null,
    });
  } else {
    const { text: compressedMarkdown, stats: civicStats } = compressContext(
      markdown,
    );
    logCompressionStats("civic-extract-worker", undefined, civicStats);
    const promptText = compressedMarkdown.slice(0, PROMPT_CONTENT_MAX);
    const langCode = (scout.preferred_language as string | null) ?? "en";
    const langName = languageName(langCode);
    const userPrompt = buildCivicCandidatePrompt(promptText, {
      criteria: scout.criteria as string | null,
      languageName: langName,
      referenceDate: extractDateFromUrl(row.source_url),
    });

    if (row.scout_run_id) await markRunStage(svc, row.scout_run_id, "extract");
    await heartbeatCivicLease(svc, row.id, workerId, leaseSeconds);
    const extraction = await openRouterExtract<
      { candidates: CivicCandidate[] }
    >(
      userPrompt,
      CIVIC_CANDIDATE_SCHEMA,
      {
        usage: {
          db: svc,
          userId,
          scoutId: row.scout_id,
          runId: row.scout_run_id,
          functionName: "civic-extract-worker",
          operation: "civic_extract_promises",
        },
      },
    );
    candidateItems = Array.isArray(extraction?.candidates)
      ? extraction.candidates
      : [];
    await heartbeatCivicLease(svc, row.id, workerId, leaseSeconds);
    const verification = await openRouterExtract<
      { candidates: CivicCandidate[] }
    >(
      buildCivicVerifierPrompt(promptText, candidateItems, {
        criteria: scout.criteria as string | null,
        languageName: langName,
        referenceDate: extractDateFromUrl(row.source_url),
      }),
      CIVIC_VERIFIER_SCHEMA,
      {
        usage: {
          db: svc,
          userId,
          scoutId: row.scout_id,
          runId: row.scout_run_id,
          functionName: "civic-extract-worker",
          operation: "civic_verify_accountability",
        },
      },
    );
    candidateItems = Array.isArray(verification?.candidates)
      ? verification.candidates
      : [];
    extracted = classifyCivicCandidates(candidateItems, {
      today: new Date().toISOString().slice(0, 10),
      sourceText: promptText,
    }).items;
  }
  await heartbeatCivicLease(svc, row.id, workerId, leaseSeconds);

  // 5. Persist eligible promises as canonical promise units plus trackers and
  // material decisions as canonical fact leads. The policy has already
  // excluded schedules, procedural content, unsupported evidence, and
  // undated/past-due promises.
  let inserted = 0;
  let mergedExisting = 0;
  const alertItems: Array<{ unit_id: string; statement: string }> = [];
  if (row.scout_run_id) {
    await markRunStage(svc, row.scout_run_id, "insert_units");
  }
  for (let itemIndex = 0; itemIndex < extracted.length; itemIndex++) {
    const item = extracted[itemIndex];
    if (itemIndex % 5 === 0) {
      await heartbeatCivicLease(svc, row.id, workerId, leaseSeconds);
    }
    let embedding: number[] | null = null;
    try {
      embedding = await embedText(item.statement, "RETRIEVAL_DOCUMENT", {
        title: scraped.title ?? null,
      });
    } catch (e) {
      logEvent({
        level: "warn",
        fn: "civic-extract-worker",
        event: "embed_failed",
        queue_id: row.id,
        scout_id: row.scout_id,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
    const result = await upsertCanonicalUnit(svc, {
      userId,
      statement: item.statement,
      unitType: item.kind === "promise" ? "promise" : "fact",
      entities: [],
      embedding,
      embeddingModel: EMBEDDING_MODEL_TAG,
      sourceUrl: row.source_url,
      sourceDomain,
      sourceTitle: scraped.title ?? null,
      contextExcerpt: item.context,
      occurredAt: item.meeting_date,
      extractedAt: capturedAt.toISOString(),
      sourceType: item.kind === "promise" ? "civic_promise" : "scout",
      contentSha256: contentHash,
      scoutId: row.scout_id,
      scoutType: "civic",
      scoutRunId: row.scout_run_id,
      projectId: (scout.project_id as string | null) ?? null,
      rawCaptureId,
      metadata: {
        civic_policy_version: CIVIC_POLICY_VERSION,
        civic_kind: item.kind,
        doc_kind: row.doc_kind,
        meeting_date: item.meeting_date,
        ...(item.kind === "promise"
          ? {
            actor: item.actor,
            action: item.action,
            due_date: item.due_date,
            due_date_text: item.due_date_text,
            date_confidence: item.date_confidence,
          }
          : {
            adopting_body: item.adopting_body,
            decision_kind: item.decision_kind,
          }),
      },
    });

    if (item.kind === "promise") {
      await upsertPromiseTracker(svc, {
        unitId: result.unitId,
        userId,
        scoutId: row.scout_id,
        promiseText: item.statement,
        context: item.context,
        sourceUrl: row.source_url,
        sourceTitle: scraped.title ?? null,
        meetingDate: item.meeting_date,
        dueDate: item.due_date,
        dueDateText: item.due_date_text,
        dateConfidence: item.date_confidence,
      });
    }

    if (result.createdCanonical) {
      inserted += 1;
      if (shouldAlertForNewCivicItem(item, true)) {
        alertItems.push({ unit_id: result.unitId, statement: item.statement });
      }
    } else if (result.mergedExisting && result.occurrenceCreated) {
      mergedExisting += 1;
    }
  }
  if (row.scout_run_id) {
    await recordCivicExtractionDiagnostics(svc, row.scout_run_id, {
      pdfsParsed: row.doc_kind === "pdf" ? 1 : 0,
      candidateUnitsBeforeFilter: candidateItems.length,
      unitsStored: inserted + mergedExisting,
      emptySuccessReason: row.doc_kind === "pdf" &&
          inserted + mergedExisting === 0
        ? "semantic_zero"
        : null,
    });
  }

  // Persist newly stored promise IDs before queue completion. The last
  // document to settle reads this run-scoped ledger and sends one complete
  // "saved for later reminder" alert. Decisions never enter this ledger.
  if (
    row.scout_run_id && ingestionMode === "scheduled" && alertItems.length > 0
  ) {
    const { error: alertItemError } = await svc.from("civic_run_alert_items")
      .upsert(
        alertItems.map((item) => ({
          scout_run_id: row.scout_run_id,
          queue_id: row.id,
          user_id: userId,
          unit_id: item.unit_id,
          statement: item.statement,
          source_url: row.source_url,
          source_title: scraped.title ?? null,
        })),
        { onConflict: "queue_id,unit_id", ignoreDuplicates: true },
      );
    if (alertItemError) throw new Error(alertItemError.message);
  }

  await heartbeatCivicLease(svc, row.id, workerId, leaseSeconds);

  // 6. Finalize this document atomically. The RPC flips the queue row
  //    processing -> done and bumps the run's counts ADDITIVELY in one
  //    statement, gated on winning that transition. This makes per-document
  //    counts accumulate across a multi-document run and stay exactly-once
  //    under the 30-minute stale-processing re-claim — markRunSuccess used to
  //    absolute-SET the counts (last document overwrote the rest) and ran
  //    before the queue row was marked done.
  const { data: didFinalize, error: finalizeErr } = await svc.rpc(
    "finalize_civic_run_doc",
    {
      p_queue_id: row.id,
      p_worker_id: workerId,
      p_run_id: row.scout_run_id,
      p_created: inserted,
      p_merged: mergedExisting,
      p_raw_capture_id: rawCaptureId,
    },
  );
  if (finalizeErr) throw new Error(finalizeErr.message);
  if (didFinalize !== true) {
    // A concurrent or prior invocation already finalized this document
    // (stale-processing re-claim). Skip notification + URL bookkeeping so they
    // stay exactly-once too.
    logEvent({
      level: "info",
      fn: "civic-extract-worker",
      event: "already_finalized",
      queue_id: row.id,
      scout_id: row.scout_id,
      run_id: row.scout_run_id,
    });
    return {
      raw_capture_id: rawCaptureId,
      promises_extracted: inserted,
      merged_existing_count: mergedExisting,
    };
  }

  // Advance the durable URL+content baseline only after this fenced queue row
  // has reached success.  A failed parse/model attempt therefore remains
  // eligible for retry instead of being silently absorbed as "already seen".
  await upsertCivicDocumentMembership(svc, {
    scoutId: row.scout_id,
    userId,
    sourceUrl: row.source_url,
    contentHash,
  });

  // 7. Notify (fire-and-forget — a mail failure does not abort the queue row,
  //    which is already marked done by the finalize RPC above).
  // A document cannot alert until the fenced run-settlement RPC has observed
  // every sibling queue row. This prevents first-document notification from
  // falsely presenting a partial run as complete.
  const { data: settledRun, error: settledRunError } = row.scout_run_id
    ? await svc.from("scout_runs").select("status").eq("id", row.scout_run_id)
      .maybeSingle()
    : { data: null, error: null };
  if (settledRunError) throw new Error(settledRunError.message);
  if (
    row.scout_run_id && ingestionMode === "scheduled" &&
    settledRun?.status === "success"
  ) {
    try {
      const { data: claims, error: claimError } = await svc.rpc(
        "claim_civic_run_alert_delivery",
        {
          p_run_id: row.scout_run_id,
          p_worker_id: workerId,
          p_lease_seconds: leaseSeconds,
        },
      );
      if (claimError) throw new Error(claimError.message);
      const claim = claims?.[0] as {
        delivery_id: string;
        fencing_token: number;
        provider_idempotency_key: string;
        needs_provider_submission: boolean;
      } | undefined;
      if (!claim) {
        // Another worker owns (or has finished) the delivery. Continue with
        // this document's normal post-processing below.
      } else {
        const { data: pendingAlertItems, error: pendingAlertItemsError } =
          await svc
            .from("civic_run_alert_items")
            .select("id, unit_id, statement, source_url, source_title")
            .eq("scout_run_id", row.scout_run_id)
            .is("delivered_at", null);
        if (pendingAlertItemsError) {
          throw new Error(pendingAlertItemsError.message);
        }
        const candidateUnitIds = (pendingAlertItems ?? []).map((item) =>
          item.unit_id
        );
        const { data: promiseRows, error: promiseRowsError } = candidateUnitIds
            .length > 0
          ? await svc.from("promises").select("unit_id")
            .eq("user_id", userId)
            .in("unit_id", candidateUnitIds)
          : { data: [], error: null };
        if (promiseRowsError) throw new Error(promiseRowsError.message);
        const promiseAlertItems = retainCivicPromiseAlertItems(
          pendingAlertItems ?? [],
          (promiseRows ?? []).map((promise) => promise.unit_id),
        );

        if (promiseAlertItems.length === 0) {
          // Neutralize empty or legacy decision-only deliveries without ever
          // reaching the provider. The delivery schema predates a `skipped`
          // terminal state, so `sent` here means terminal/consumed; the run
          // keeps the accurate user-facing `skipped` notification status.
          if (pendingAlertItems?.length) {
            const { error: neutralizeError } = await svc.from(
              "civic_run_alert_items",
            )
              .update({ delivered_at: new Date().toISOString() })
              .in("id", pendingAlertItems.map((item) => item.id))
              .is("delivered_at", null);
            if (neutralizeError) throw new Error(neutralizeError.message);
          }
          await markNotificationResult(svc, row.scout_run_id, "skipped", {
            reason: "no_new_promises",
          });
          const { error: skippedFinalizeError } = await svc.rpc(
            "finalize_civic_run_alert_delivery",
            {
              p_delivery_id: claim.delivery_id,
              p_worker_id: workerId,
              p_fencing_token: claim.fencing_token,
              p_state: "sent",
              p_error: "skipped_no_new_promises",
            },
          );
          if (skippedFinalizeError) {
            throw new Error(skippedFinalizeError.message);
          }
        } else {
          if (!claim.needs_provider_submission) {
            const { error: reconciledError } = await svc.rpc(
              "finalize_civic_run_alert_delivery",
              {
                p_delivery_id: claim.delivery_id,
                p_worker_id: workerId,
                p_fencing_token: claim.fencing_token,
                p_state: "sent",
              },
            );
            if (reconciledError) throw new Error(reconciledError.message);
            return {
              raw_capture_id: rawCaptureId,
              promises_extracted: inserted,
              merged_existing_count: mergedExisting,
            };
          }
          await markNotificationAttempted(svc, row.scout_run_id).catch((e) =>
            logEvent({
              level: "warn",
              fn: "civic-extract-worker",
              event: "notification_status_failed",
              queue_id: row.id,
              scout_id: row.scout_id,
              run_id: row.scout_run_id,
              msg: e instanceof Error ? e.message : String(e),
            })
          );
          const summary = promiseAlertItems
            .slice(0, 10)
            .map((item) => {
              const title = (item.source_title ?? item.source_url).replace(
                /\]/g,
                "\\]",
              );
              return `- **${item.statement}** ([${title}](${item.source_url}))`;
            })
            .join("\n");
          const notification = await sendCivicAlert(svc, {
            userId,
            scoutId: row.scout_id,
            runId: row.scout_run_id,
            scoutName: (scout.name as string | null) ?? "Civic Scout",
            summary,
            providerIdempotencyKey: claim.provider_idempotency_key,
          });
          if (notification.ok) {
            const { error: acceptedError } = await svc.rpc(
              "mark_civic_run_alert_provider_accepted",
              {
                p_delivery_id: claim.delivery_id,
                p_worker_id: workerId,
                p_fencing_token: claim.fencing_token,
                p_provider_id: notification.providerId ?? null,
              },
            );
            if (acceptedError) throw new Error(acceptedError.message);
          }
          await markNotificationResult(
            svc,
            row.scout_run_id,
            notification.ok
              ? "sent"
              : notification.reason === "missing_email"
              ? "skipped"
              : "failed",
            notification.ok
              ? { providerId: notification.providerId ?? null }
              : {
                message: notification.error ?? notification.reason ??
                  "notification not sent",
                reason: notification.reason ?? "unknown",
              },
          ).catch((e) =>
            logEvent({
              level: "warn",
              fn: "civic-extract-worker",
              event: "notification_status_failed",
              queue_id: row.id,
              scout_id: row.scout_id,
              run_id: row.scout_run_id,
              msg: e instanceof Error ? e.message : String(e),
            })
          );
          if (notification.ok) {
            const { error: deliveredError } = await svc.from(
              "civic_run_alert_items",
            )
              .update({ delivered_at: new Date().toISOString() })
              .in("id", (pendingAlertItems ?? []).map((item) => item.id))
              .is("delivered_at", null);
            if (deliveredError) throw new Error(deliveredError.message);
          }
          const { error: deliveryFinalizeError } = await svc.rpc(
            "finalize_civic_run_alert_delivery",
            {
              p_delivery_id: claim.delivery_id,
              p_worker_id: workerId,
              p_fencing_token: claim.fencing_token,
              p_state: notification.ok ? "sent" : "failed",
              p_error: notification.ok
                ? null
                : notification.error ?? notification.reason ?? "send failed",
            },
          );
          if (deliveryFinalizeError) {
            throw new Error(deliveryFinalizeError.message);
          }
        }
      }
    } catch (e) {
      await markNotificationResult(
        svc,
        row.scout_run_id,
        "failed",
        e instanceof Error ? e.message : String(e),
      ).catch((markErr) =>
        logEvent({
          level: "warn",
          fn: "civic-extract-worker",
          event: "notification_status_failed",
          queue_id: row.id,
          scout_id: row.scout_id,
          run_id: row.scout_run_id,
          msg: markErr instanceof Error ? markErr.message : String(markErr),
        })
      );
      logEvent({
        level: "warn",
        fn: "civic-extract-worker",
        event: "notify_failed",
        queue_id: row.id,
        scout_id: row.scout_id,
        run_id: row.scout_run_id,
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 8. Mark the source URL as processed on the scout ONLY after the full
  //    extraction pipeline has succeeded. Previously this was done in
  //    civic-execute at enqueue time, which meant a failing Firecrawl call
  //    still flagged the URL as seen and it was never retried.
  const { error: appendErr } = await svc.rpc(
    "append_processed_pdf_url_capped",
    {
      p_scout_id: row.scout_id,
      p_url: row.source_url,
      p_cap: PROCESSED_URLS_CAP,
    },
  );
  if (appendErr) {
    // Non-fatal: at worst the URL could be re-extracted on a future run.
    // That's better than failing the whole queue row at this point.
    logEvent({
      level: "warn",
      fn: "civic-extract-worker",
      event: "append_processed_failed",
      queue_id: row.id,
      scout_id: row.scout_id,
      msg: appendErr.message,
    });
  }

  return {
    raw_capture_id: rawCaptureId,
    promises_extracted: inserted,
    merged_existing_count: mergedExisting,
  };
}

// ---------------------------------------------------------------------------

function extractDateFromUrl(url: string): string | null {
  return url.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

async function loadInitialSnapshotItems(
  svc: SupabaseClient,
  input: {
    snapshotId: string | null;
    userId: string;
    scoutId: string;
    sourceUrl: string;
    contentHash: string;
    policyVersion: string | null;
  },
): Promise<CivicEligibleItem[]> {
  if (!input.snapshotId) {
    throw new Error("initial civic queue item is missing preview snapshot");
  }
  if (input.policyVersion !== CIVIC_POLICY_VERSION) {
    throw new Error("initial civic queue item has incompatible policy version");
  }
  const { data: snapshot, error } = await svc
    .from("civic_preview_snapshots")
    .select("user_id, consumed_by_scout_id, policy_version, documents")
    .eq("id", input.snapshotId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!snapshot || snapshot.consumed_by_scout_id !== input.scoutId) {
    throw new Error(
      "initial civic preview snapshot does not belong to this scout",
    );
  }
  if (snapshot.policy_version !== CIVIC_POLICY_VERSION) {
    throw new Error("initial civic preview snapshot policy is incompatible");
  }
  const document = Array.isArray(snapshot.documents)
    ? snapshot.documents.find((value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const sourceUrl = (value as Record<string, unknown>).source_url;
      return typeof sourceUrl === "string" &&
        sameCivicUrl(sourceUrl, input.sourceUrl);
    })
    : null;
  if (!document || typeof document !== "object") {
    throw new Error(
      "initial civic preview does not contain this source document",
    );
  }
  const payload = document as Record<string, unknown>;
  if (payload.content_hash !== input.contentHash) {
    throw new Error(
      "initial civic source changed after preview; it must be processed as scheduled work",
    );
  }
  if (!Array.isArray(payload.items)) {
    throw new Error("initial civic preview items are invalid");
  }
  return payload.items.map((value) => rehydratePreviewItem(value));
}

function rehydratePreviewItem(value: unknown): CivicEligibleItem {
  if (!value || typeof value !== "object") {
    throw new Error("invalid civic preview item");
  }
  const item = value as Record<string, unknown>;
  const string = (key: string): string => {
    const candidate = item[key];
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new Error(`invalid civic preview ${key}`);
    }
    return candidate.trim();
  };
  const dateOrNull = (key: string): string | null =>
    item[key] === null ? null : string(key);
  if (item.kind === "promise") {
    const confidence = string("date_confidence");
    if (
      confidence !== "high" && confidence !== "medium" && confidence !== "low"
    ) {
      throw new Error("invalid civic preview date confidence");
    }
    return {
      kind: "promise",
      statement: string("statement"),
      context: string("context"),
      actor: string("actor"),
      action: string("action"),
      meeting_date: dateOrNull("meeting_date"),
      due_date: string("due_date"),
      due_date_text: string("due_date_text"),
      date_confidence: confidence,
    };
  }
  if (item.kind === "decision") {
    return {
      kind: "decision",
      statement: string("statement"),
      context: string("context"),
      adopting_body: string("adopting_body"),
      decision_kind: string("decision_kind"),
      meeting_date: dateOrNull("meeting_date"),
    };
  }
  throw new Error("invalid civic preview item kind");
}

function sameCivicUrl(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  };
  return normalize(left) === normalize(right);
}

async function heartbeatCivicLease(
  svc: SupabaseClient,
  queueId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<void> {
  const { data, error } = await svc.rpc("heartbeat_civic_queue_item", {
    p_queue_id: queueId,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`civic lease heartbeat failed: ${error.message}`);
  if (data !== true) throw new Error("civic worker lease lost");
}

function envInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(Deno.env.get(name) ?? "", 10);
  return Math.min(
    max,
    Math.max(min, Number.isFinite(parsed) ? parsed : fallback),
  );
}

async function upsertPromiseTracker(
  svc: SupabaseClient,
  input: {
    unitId: string;
    userId: string;
    scoutId: string;
    promiseText: string;
    context: string | null;
    sourceUrl: string;
    sourceTitle: string | null;
    meetingDate: string | null;
    dueDate: string | null;
    dueDateText: string | null;
    dateConfidence: "high" | "medium" | "low" | null;
  },
): Promise<void> {
  const { data: existing, error: existingErr } = await svc
    .from("promises")
    .select(
      "id, scout_id, promise_text, status, context, source_url, source_title, meeting_date, due_date, date_confidence",
    )
    .eq("user_id", input.userId)
    .eq("unit_id", input.unitId)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  if (!existing) {
    const { data: created, error: insertErr } = await svc.from("promises")
      .insert({
        unit_id: input.unitId,
        user_id: input.userId,
        scout_id: input.scoutId,
        promise_text: input.promiseText,
        context: input.context,
        source_url: input.sourceUrl,
        source_title: input.sourceTitle,
        meeting_date: input.meetingDate,
        due_date: input.dueDate,
        date_confidence: input.dateConfidence,
        status: "new",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).select("id").single();
    if (insertErr) throw new Error(insertErr.message);
    if (
      !created?.id || !input.dueDate || !input.dueDateText ||
      !input.dateConfidence
    ) {
      throw new Error("new Civic promise is missing required revision fields");
    }
    const { data: revision, error: revisionErr } = await svc.from(
      "promise_revisions",
    ).insert({
      promise_id: created.id,
      user_id: input.userId,
      due_date: input.dueDate,
      date_confidence: input.dateConfidence,
      due_date_text: input.dueDateText,
      source_url: input.sourceUrl,
      context: input.context ?? "",
      amendment_reason: "initial",
    }).select("id").single();
    if (revisionErr || !revision?.id) {
      throw new Error(
        revisionErr?.message ?? "could not create promise revision",
      );
    }
    const { error: revisionLinkErr } = await svc.from("promises").update({
      active_revision_id: revision.id,
    }).eq("id", created.id).eq("user_id", input.userId);
    if (revisionLinkErr) throw new Error(revisionLinkErr.message);
    return;
  }

  const { error: updateErr } = await svc
    .from("promises")
    .update({
      scout_id: existing.scout_id ?? input.scoutId,
      promise_text: existing.promise_text ?? input.promiseText,
      context: existing.context ?? input.context,
      source_url: existing.source_url ?? input.sourceUrl,
      source_title: existing.source_title ?? input.sourceTitle,
      meeting_date: existing.meeting_date ?? input.meetingDate,
      due_date: existing.due_date ?? input.dueDate,
      date_confidence: existing.date_confidence ?? input.dateConfidence,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id);
  if (updateErr) throw new Error(updateErr.message);
}

async function recordCivicExtractionDiagnostics(
  svc: SupabaseClient,
  runId: string,
  diagnostics: {
    pdfsParsed: number;
    candidateUnitsBeforeFilter: number;
    unitsStored: number;
    emptySuccessReason: string | null;
  },
): Promise<void> {
  const { data: run } = await svc
    .from("scout_runs")
    .select("metadata")
    .eq("id", runId)
    .maybeSingle();
  const metadata = run && typeof run === "object" &&
      (run as { metadata?: unknown }).metadata &&
      typeof (run as { metadata?: unknown }).metadata === "object" &&
      !Array.isArray((run as { metadata?: unknown }).metadata)
    ? { ...(run as { metadata: Record<string, unknown> }).metadata }
    : {};
  const pdfsParsed = numberFromMetadata(metadata.pdfs_parsed) +
    diagnostics.pdfsParsed;
  const candidateUnitsBeforeFilter = numberFromMetadata(
    metadata.candidate_units_before_filter,
  ) + diagnostics.candidateUnitsBeforeFilter;
  const unitsStored = numberFromMetadata(metadata.civic_units_stored) +
    diagnostics.unitsStored;
  const emptySuccessReason = unitsStored === 0 && pdfsParsed > 0
    ? diagnostics.emptySuccessReason
    : null;

  const { error } = await svc
    .from("scout_runs")
    .update({
      metadata: {
        ...metadata,
        pdfs_parsed: pdfsParsed,
        candidate_units_before_filter: candidateUnitsBeforeFilter,
        civic_units_stored: unitsStored,
        empty_success_reason: emptySuccessReason,
      },
    })
    .eq("id", runId);
  if (error) {
    logEvent({
      level: "warn",
      fn: "civic-extract-worker",
      event: "run_diagnostics_update_failed",
      run_id: runId,
      msg: error.message,
    });
  }
}

function numberFromMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
