/**
 * civic Edge Function — Civic Scout UI preview endpoints.
 *
 * Routes:
 *   POST /civic/discover
 *     body: { root_domain: string }
 *     -> 200 { candidates: [{ url, description, confidence }] (up to 5) }
 *
 *   POST /civic/test
 *     body: { tracked_urls: string[] (1..2), criteria?: string }
 *     -> 200 { api_version: "2", valid: boolean, documents_found: number,
 *              policy_version, sample_items: [promise | decision],
 *              sample_promises: [{ promise_text, context, source_url,
 *                                  source_date, due_date?, date_confidence,
 *                                  criteria_match }],
 *              error?: string }
 *   GET /civic/items?kind=promise|decision&scout_id=<uuid>&status=...
 *   GET /civic/items/:unit_id
 *   GET /civic/runs?scout_id=<uuid>
 *   GET /civic/runs/:run_id
 *
 * `discover` — in-house sitemap/link discovery, then OpenRouter ranks up to
 * 5 candidate INDEX pages likely to list meeting protocols. Discovery
 * explicitly prefers listing pages like `/urversammlung/protokoll` over
 * direct `/pdf/...` document URLs.
 *
 * `test` — for each tracked_url, scrape the listing page raw HTML, extract
 * downstream meeting-document links, classify them with the old civic
 * keyword/LLM flow, then preview promises from the resolved documents.
 * Mirrors the existing `civic-test` Edge Function at a different URL path
 * to match the frontend's `/civic/test` convention.
 *
 * Preview only — no persistence, no credit charge.
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { AuthedUser, requireUserOrApiKey } from "../_shared/auth.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import { mapSite } from "../_shared/site_map.ts";
import {
  filterCivicDiscoveryCandidates,
  rankCivicDiscoveryUrls,
} from "../_shared/civic_links.ts";
import { previewCivicTrackedUrls } from "../_shared/civic_preview.ts";
import { openRouterExtract } from "../_shared/openrouter.ts";
import { getServiceClient } from "../_shared/supabase.ts";

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

const DiscoverSchema = z.object({
  root_domain: z.string().min(3).max(300),
});

const DISCOVER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          description: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["url", "description", "confidence"],
      },
    },
  },
  required: ["candidates"],
};

interface Candidate {
  url: string;
  description: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const TestSchema = z.object({
  tracked_urls: z.array(z.string().url()).min(1).max(2),
  criteria: z.string().max(4000).optional(),
});

const PROMISES_PREVIEW_CAP = 10;
const PREVIEW_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  let user: AuthedUser;
  try {
    user = await requireUserOrApiKey(req);
  } catch (e) {
    return jsonFromError(e);
  }

  const url = new URL(req.url);
  // Kong strips function slug; path starts with "/civic/..." for us.
  const path = url.pathname.replace(/^.*\/civic/, "") || "/";

  try {
    if (path === "/discover" && req.method === "POST") {
      return await discover(req, user);
    }
    if (path === "/test" && req.method === "POST") {
      return await test(req, user);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const itemMatch = path.match(/^\/items\/([0-9a-f-]{36})$/i);
      const runMatch = path.match(/^\/runs\/([0-9a-f-]{36})$/i);
      if (path === "/items") return await listCivicItems(url, user);
      if (itemMatch) return await getCivicItem(itemMatch[1], user);
      if (path === "/runs") return await listCivicRuns(url, user);
      if (runMatch) return await getCivicRun(runMatch[1], user);
    }
    return jsonError("method not allowed", 405);
  } catch (e) {
    logEvent({
      level: "error",
      fn: "civic",
      event: "unhandled",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonFromError(e);
  }
});

// ---------------------------------------------------------------------------

function parseOptionalUuid(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (!UUID.test(value)) throw new ValidationError(`invalid ${label}`);
  return value;
}

function civicItemEnvelope(
  unit: Record<string, unknown>,
  promise: Record<string, unknown> | null,
): Record<string, unknown> {
  const kind = unit.type === "promise" ? "promise" : "decision";
  const metadata = unit.metadata && typeof unit.metadata === "object" &&
      !Array.isArray(unit.metadata)
    ? unit.metadata as Record<string, unknown>
    : {};
  return {
    kind,
    unit_id: unit.id,
    scout_id: unit.scout_id ?? null,
    statement: unit.statement,
    source_url: unit.source_url ?? null,
    source_title: unit.source_title ?? null,
    context: unit.context_excerpt ?? null,
    meeting_date: metadata.meeting_date ?? null,
    policy_version: metadata.civic_policy_version ?? null,
    ...(kind === "promise"
      ? {
        actor: metadata.actor ?? null,
        action: metadata.action ?? null,
        due_date: promise?.due_date ?? metadata.due_date ?? null,
        due_date_text: metadata.due_date_text ?? null,
        date_confidence: promise?.date_confidence ??
          metadata.date_confidence ?? null,
        tracker_id: promise?.id ?? null,
        status: promise?.status ?? null,
        active_revision_id: promise?.active_revision_id ?? null,
      }
      : {
        adopting_body: metadata.adopting_body ?? null,
        decision_kind: metadata.decision_kind ?? null,
      }),
  };
}

async function listCivicItems(url: URL, user: AuthedUser): Promise<Response> {
  const kind = url.searchParams.get("kind");
  if (kind !== null && kind !== "promise" && kind !== "decision") {
    throw new ValidationError("kind must be promise or decision");
  }
  const scoutId = parseOptionalUuid(
    url.searchParams.get("scout_id"),
    "scout_id",
  );
  const status = url.searchParams.get("status");
  const dueBefore = url.searchParams.get("due_before");
  const dueAfter = url.searchParams.get("due_after");
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? 50)),
  );
  const svc = getServiceClient();
  let units = svc.from("information_units").select("*")
    .eq("user_id", user.id).eq("scout_type", "civic")
    .in(
      "type",
      kind === "promise"
        ? ["promise"]
        : kind === "decision"
        ? ["fact"]
        : ["promise", "fact"],
    )
    .order("last_seen_at", { ascending: false }).limit(limit);
  if (scoutId) units = units.eq("scout_id", scoutId);
  const { data: unitRows, error: unitError } = await units;
  if (unitError) throw new Error(unitError.message);
  const ids = (unitRows ?? []).map((row) => row.id as string);
  let promiseRows: Record<string, unknown>[] = [];
  if (ids.length) {
    let promises = svc.from("promises").select("*").eq("user_id", user.id)
      .in("unit_id", ids);
    if (status) promises = promises.eq("status", status);
    if (dueBefore) promises = promises.lte("due_date", dueBefore);
    if (dueAfter) promises = promises.gte("due_date", dueAfter);
    const { data, error } = await promises;
    if (error) throw new Error(error.message);
    promiseRows = (data ?? []) as Record<string, unknown>[];
  }
  const promiseByUnit = new Map(
    promiseRows.map((row) => [row.unit_id as string, row]),
  );
  const items = (unitRows ?? [])
    .filter((row) => row.type !== "promise" || promiseByUnit.has(row.id))
    .map((row) =>
      civicItemEnvelope(
        row as Record<string, unknown>,
        promiseByUnit.get(row.id) ?? null,
      )
    );
  return jsonOk({ api_version: "1", items });
}

async function getCivicItem(
  unitId: string,
  user: AuthedUser,
): Promise<Response> {
  const svc = getServiceClient();
  const { data: unit, error } = await svc.from("information_units").select("*")
    .eq("id", unitId).eq("user_id", user.id).eq("scout_type", "civic")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!unit) return jsonError("not found", 404);
  const { data: promise, error: promiseError } = await svc.from("promises")
    .select("*").eq("user_id", user.id).eq("unit_id", unitId).maybeSingle();
  if (promiseError) throw new Error(promiseError.message);
  return jsonOk({ api_version: "1", item: civicItemEnvelope(unit, promise) });
}

function safeCivicRun(run: Record<string, unknown>): Record<string, unknown> {
  const rawMetadata = run.metadata && typeof run.metadata === "object" &&
      !Array.isArray(run.metadata)
    ? run.metadata as Record<string, unknown>
    : {};
  const metadata = Object.fromEntries(
    [
      "civic_policy_version",
      "pdfs_parsed",
      "candidate_units_before_filter",
      "civic_units_stored",
      "empty_success_reason",
      "documents_resolved",
      "documents_evaluated",
      "rejection_counts",
    ].flatMap((key) => key in rawMetadata ? [[key, rawMetadata[key]]] : []),
  );
  return {
    id: run.id,
    scout_id: run.scout_id,
    status: run.status,
    stage: run.stage ?? null,
    started_at: run.started_at ?? null,
    completed_at: run.completed_at ?? null,
    units_created_count: run.units_created_count ?? 0,
    units_merged_count: run.units_merged_count ?? 0,
    notification_status: run.notification_status ?? null,
    metadata,
  };
}

async function civicScoutIds(userId: string): Promise<string[]> {
  const { data, error } = await getServiceClient().from("scouts").select("id")
    .eq("user_id", userId).eq("type", "civic");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.id as string);
}

async function listCivicRuns(url: URL, user: AuthedUser): Promise<Response> {
  const scoutId = parseOptionalUuid(
    url.searchParams.get("scout_id"),
    "scout_id",
  );
  const scoutIds = scoutId ? [scoutId] : await civicScoutIds(user.id);
  if (!scoutIds.length) return jsonOk({ api_version: "1", runs: [] });
  const { data, error } = await getServiceClient().from("scout_runs").select(
    "*",
  )
    .eq("user_id", user.id).in("scout_id", scoutIds)
    .order("started_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return jsonOk({
    api_version: "1",
    runs: (data ?? []).map((row) => safeCivicRun(row)),
  });
}

async function getCivicRun(runId: string, user: AuthedUser): Promise<Response> {
  const { data, error } = await getServiceClient().from("scout_runs").select(
    "*",
  )
    .eq("id", runId).eq("user_id", user.id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !(await civicScoutIds(user.id)).includes(data.scout_id)) {
    return jsonError("not found", 404);
  }
  return jsonOk({ api_version: "1", run: safeCivicRun(data) });
}

// ---------------------------------------------------------------------------

async function discover(req: Request, user: AuthedUser): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = DiscoverSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const raw = parsed.data.root_domain.trim();
  const target = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let urls: string[] = [];
  try {
    urls = await mapSite(target, {
      limit: 200,
      includeSubdomains: true,
      tenantKey: user.id,
    });
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "civic",
      event: "map_failed",
      user_id: user.id,
      target,
      msg: e instanceof Error ? e.message : String(e),
    });
    return jsonOk({ candidates: [] });
  }

  if (urls.length === 0) {
    return jsonOk({ candidates: [] });
  }

  const list = urls.slice(0, 200).map((u, i) => `${i + 1}. ${u}`).join("\n");
  const deterministicCandidates = rankCivicDiscoveryUrls(urls, {
    maxCandidates: 5,
  });
  const prompt =
    "You are a civic data assistant. Below is a list of URLs from a local " +
    "government website. Identify the best candidates — pages that serve as " +
    "an INDEX or LISTING where council meeting protocols, assembly minutes, " +
    "or official decision documents are published over time.\n\n" +
    "IMPORTANT: Prefer index/listing pages over individual documents. " +
    "A page like '/urversammlung/protokoll' that LISTS many protocol PDFs " +
    "is far more valuable than a single PDF file. Do NOT return individual " +
    "PDF or document URLs — return the pages that LINK TO them.\n\n" +
    "Prioritize:\n" +
    "- Pages that list/link to meeting protocol PDFs or minutes\n" +
    "- Assembly proceedings index pages\n" +
    "- Council news or decisions pages with recurring updates\n" +
    "- Archive pages with historical meeting documents\n\n" +
    "Return the top 5 most relevant INDEX pages. For each, provide:\n" +
    "- url: the exact URL from the list\n" +
    "- description: what it likely contains (1 sentence)\n" +
    "- confidence: 0.0 to 1.0\n\n" +
    "Return ONLY a JSON object with a 'candidates' array. Max 5 entries.\n\n" +
    `URLs (${urls.length} total, showing first ${
      Math.min(urls.length, 200)
    }):\n${list}`;

  let extraction: { candidates: Candidate[] };
  try {
    extraction = await openRouterExtract(prompt, DISCOVER_SCHEMA);
  } catch (e) {
    logEvent({
      level: "warn",
      fn: "civic",
      event: "rank_failed",
      user_id: user.id,
      msg: e instanceof Error ? e.message : String(e),
      fallback_candidates: deterministicCandidates.length,
    });
    return jsonOk({ candidates: deterministicCandidates });
  }

  const candidates = mergeCivicCandidates([
    ...deterministicCandidates,
    ...(extraction.candidates ?? []),
  ]);

  logEvent({
    level: "info",
    fn: "civic",
    event: "discover",
    user_id: user.id,
    target,
    urls_mapped: urls.length,
    candidates: candidates.length,
  });

  return jsonOk({ candidates });
}

function mergeCivicCandidates(candidates: Candidate[]): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (
    const candidate of filterCivicDiscoveryCandidates(candidates)
      .filter((c) => c && typeof c.url === "string" && c.url.trim().length > 0)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
  ) {
    const normalizedUrl = normalizeCandidateUrl(candidate.url);
    if (!normalizedUrl || merged.has(normalizedUrl)) continue;
    merged.set(normalizedUrl, {
      ...candidate,
      url: normalizedUrl,
    });
  }
  return [...merged.values()].slice(0, 5);
}

function normalizeCandidateUrl(url: string): string | null {
  try {
    return new URL(url).toString().split("#")[0].replace(/\/+$/, "");
  } catch {
    return null;
  }
}

async function test(req: Request, user: AuthedUser): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const parsed = TestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  const { tracked_urls, criteria } = parsed.data;

  const preview = await previewCivicTrackedUrls(tracked_urls, criteria, {
    maxDocs: 5,
    maxPromisesPerDocument: PROMISES_PREVIEW_CAP,
    tenantKey: user.id,
  });
  const allItems = preview.documents.flatMap((document) => document.items)
    .slice(0, PROMISES_PREVIEW_CAP);
  const allPromises = preview.documents.flatMap((document) => document.promises)
    .slice(0, PROMISES_PREVIEW_CAP);
  const documentsFound = preview.documentsFound;
  const previewSnapshotToken = documentsFound > 0
    ? await storePreviewSnapshot(user.id, tracked_urls, criteria, preview)
    : null;

  logEvent({
    level: "info",
    fn: "civic",
    event: "test",
    user_id: user.id,
    urls: tracked_urls.length,
    documents_found: documentsFound,
    items: allItems.length,
    promises: allPromises.length,
  });

  return jsonOk({
    api_version: "2",
    valid: documentsFound > 0,
    ...(documentsFound > 0 ? {} : {
      error_code: preview.documentsResolved === 0
        ? "no_documents"
        : "all_documents_failed",
    }),
    documents_found: documentsFound,
    documents_resolved: preview.documentsResolved,
    documents_evaluated: documentsFound,
    source_results: preview.sourceResults,
    policy_version: preview.policyVersion,
    preview_snapshot_token: previewSnapshotToken,
    sample_items: allItems,
    // Exact legacy promise-only projection retained for current UI/API
    // consumers. New consumers must use sample_items.
    sample_promises: allPromises.slice(0, PROMISES_PREVIEW_CAP),
  });
}

/**
 * The token is intentionally an opaque database UUID.  Only service-role
 * code can read the payload, and creation later rechecks the owner, criteria,
 * tracked URLs, expiry, and policy version before it enqueues anything.
 */
async function storePreviewSnapshot(
  userId: string,
  trackedUrls: string[],
  criteria: string | undefined,
  preview: Awaited<ReturnType<typeof previewCivicTrackedUrls>>,
): Promise<string> {
  const { data, error } = await getServiceClient()
    .from("civic_preview_snapshots")
    .insert({
      user_id: userId,
      policy_version: preview.policyVersion,
      criteria: criteria?.trim() || null,
      tracked_urls: trackedUrls.map(normalizeSnapshotUrl).sort(),
      documents: preview.documents.map((document) => ({
        source_url: normalizeSnapshotUrl(document.source_url),
        source_title: document.title ?? null,
        content_hash: document.content_hash,
        items: document.items,
      })),
      expires_at: new Date(Date.now() + PREVIEW_SNAPSHOT_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data?.id) {
    throw new Error(
      `could not store civic preview snapshot: ${
        error?.message ?? "unknown error"
      }`,
    );
  }
  return data.id as string;
}

function normalizeSnapshotUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
