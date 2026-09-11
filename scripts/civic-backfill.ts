/** Operator-only Civic backfill. Plan fetches/parses but never writes account data.
 * Apply requires the exact manifest digest. Status/drain resume the same run.
 * Credentials come only from the process environment; never put them in a manifest.
 */
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { sha256Hex } from "../supabase/functions/_shared/unit_dedup.ts";
import { parseDocument } from "../supabase/functions/_shared/docparse.ts";
import { scrape } from "../supabase/functions/_shared/scrape.ts";
import {
  isCivicDirectDocumentUrl,
  resolveCivicDocumentsFromPages,
} from "../supabase/functions/_shared/civic_links.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DOCUMENTS = 10;
const MAX_TEXT = 40_000;
interface Selection {
  start_character: number;
  end_character: number;
  label: string;
}
interface Target {
  source_url: string;
  listing_url: string;
  document_date: string;
  selection?: Selection;
}
interface Targets {
  user_id: string;
  scout_id: string;
  date_from: string;
  date_to: string;
  documents: Target[];
}
interface CapturedDocument extends Target {
  markdown: string;
  content_sha256: string;
  title: string | null;
  doc_kind: "pdf" | "html";
  pages?: number;
  source_content_sha256: string;
  source_characters: number;
}
interface Manifest extends Omit<Targets, "documents"> {
  version: 1;
  run_id: string;
  supabase_url: string;
  created_at: string;
  scout_snapshot: Record<string, unknown>;
  documents: CapturedDocument[];
  discovery?: unknown[];
  manifest_hash?: string;
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
}
function publicHttps(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    // Provider-side destination/DNS validation remains authoritative for redirects.
    return u.protocol === "https:" && !u.username && !u.password && !u.hash &&
      u.hostname.includes(".") && !/^[\d.]+$/.test(u.hostname) &&
      !u.hostname.endsWith(".localhost") && !u.hostname.endsWith(".local") &&
      !u.hostname.includes(":");
  } catch {
    return false;
  }
}
export function validateTargets(input: unknown): Targets {
  requireValue(input && typeof input === "object", "targets must be an object");
  const t = input as Targets;
  requireValue(
    UUID.test(t.user_id) && UUID.test(t.scout_id),
    "valid user_id and scout_id required",
  );
  requireValue(
    validDate(t.date_from) && validDate(t.date_to) && t.date_from <= t.date_to,
    "valid date range required",
  );
  requireValue(
    Array.isArray(t.documents) && t.documents.length > 0 &&
      t.documents.length <= MAX_DOCUMENTS,
    "select 1–10 exact documents",
  );
  const seen = new Set<string>();
  for (const d of t.documents) {
    requireValue(
      publicHttps(d.source_url) && publicHttps(d.listing_url),
      "public HTTPS source and listing URLs required",
    );
    requireValue(
      validDate(d.document_date) && d.document_date >= t.date_from &&
        d.document_date <= t.date_to,
      "document date must be real and within selected range",
    );
    requireValue(!seen.has(d.source_url), "duplicate source URL");
    if (d.selection) {
      const { start_character: start, end_character: end, label } = d.selection;
      requireValue(
        Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
          start >= 0 && end > start && end - start <= MAX_TEXT &&
          typeof label === "string" && label.trim().length > 0 &&
          label.length <= 300,
        "invalid explicit document excerpt",
      );
    }
    seen.add(d.source_url);
  }
  return t;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [k, v],
      ) => [k, canonical(v)]),
    );
  }
  return value;
}
export async function manifestHash(value: unknown): Promise<string> {
  const { manifest_hash: _hash, ...body } = value as Record<string, unknown>;
  return await sha256Hex(JSON.stringify(canonical(body)));
}
export async function validateManifest(
  value: unknown,
  deployment: string,
): Promise<Manifest> {
  validateTargets(value);
  const m = value as Manifest;
  requireValue(
    m.version === 1 && UUID.test(m.run_id),
    "unsupported manifest or run ID",
  );
  requireValue(
    m.supabase_url === deployment.replace(/\/$/, ""),
    "manifest targets a different deployment",
  );
  requireValue(
    m.scout_snapshot && Array.isArray(m.scout_snapshot.tracked_urls),
    "Scout snapshot missing",
  );
  requireValue(
    m.manifest_hash === await manifestHash(m),
    "manifest digest mismatch",
  );
  for (const d of m.documents) {
    requireValue(
      typeof d.markdown === "string" && d.markdown.trim().length > 0 &&
        d.markdown.length <= MAX_TEXT,
      "empty or oversized captured document",
    );
    requireValue(
      d.content_sha256 === await sha256Hex(d.markdown),
      "captured content hash mismatch",
    );
    requireValue(
      d.doc_kind === "pdf" || d.doc_kind === "html",
      "unsupported document kind",
    );
    requireValue(
      (m.scout_snapshot.tracked_urls as string[]).includes(d.listing_url),
      "document listing is not tracked by the Scout",
    );
  }
  return m;
}
async function scoutSnapshot(db: SupabaseClient, t: Targets) {
  const { data, error } = await db.from("scouts").select(
    "id,user_id,type,is_active,tracked_urls,criteria,preferred_language,project_id",
  ).eq("id", t.scout_id).eq("user_id", t.user_id).single();
  if (error) throw new Error(error.message);
  requireValue(
    data.type === "civic" && data.is_active,
    "backfill requires an active, owned Civic Scout",
  );
  return {
    tracked_urls: data.tracked_urls ?? [],
    criteria: data.criteria ?? null,
    preferred_language: data.preferred_language ?? null,
    project_id: data.project_id ?? null,
  };
}
export function selectDocumentText(
  markdown: string,
  selection?: Selection,
): string {
  requireValue(
    markdown.length <= 10_000_000,
    "source exceeds operator parse bound",
  );
  if (!selection) {
    requireValue(
      markdown.length <= MAX_TEXT,
      `source exceeds ${MAX_TEXT} characters; select a named, explicit excerpt`,
    );
    return markdown;
  }
  requireValue(
    selection.end_character <= markdown.length,
    "excerpt exceeds parsed source",
  );
  return markdown.slice(selection.start_character, selection.end_character);
}
async function plan(
  db: SupabaseClient,
  deployment: string,
  targets: Targets,
): Promise<Manifest> {
  const snapshot = await scoutSnapshot(db, targets);
  const discovery: unknown[] = [];
  const documents: CapturedDocument[] = [];
  for (
    const listingUrl of new Set(targets.documents.map((d) => d.listing_url))
  ) {
    requireValue(
      snapshot.tracked_urls.includes(listingUrl),
      "selected listing is not currently tracked",
    );
    const selected = targets.documents.filter((d) =>
      d.listing_url === listingUrl
    );
    if (
      !(selected.length === 1 && selected[0].source_url === listingUrl &&
        isCivicDirectDocumentUrl(listingUrl))
    ) {
      const page = await scrape(listingUrl, {
        workloadClass: "system",
        tenantKey: "system:civic-backfill",
        formats: ["rawHtml"],
        onlyMainContent: false,
      });
      requireValue(
        (page.status_code ?? 200) < 400 && page.rawHtml?.trim(),
        "listing could not be fetched",
      );
      const result = await resolveCivicDocumentsFromPages([{
        pageUrl: listingUrl,
        rawHtml: page.rawHtml,
      }], { tenantKey: targets.user_id });
      discovery.push({ listing_url: listingUrl, ...result });
      for (const d of selected) {
        requireValue(
          result.documentUrls.includes(d.source_url),
          `selected document is not resolved from listing: ${d.source_url}`,
        );
      }
    }
    for (const d of selected) {
      const parsed = await parseDocument(d.source_url, {
        workloadClass: "system",
        tenantKey: "system:civic-backfill",
      });
      requireValue(parsed.markdown.trim().length > 0, "source parsed empty");
      const markdown = selectDocumentText(parsed.markdown, d.selection);

      documents.push({
        ...d,
        markdown,
        content_sha256: await sha256Hex(markdown),
        source_content_sha256: await sha256Hex(parsed.markdown),
        source_characters: parsed.markdown.length,
        title: parsed.title ?? null,
        doc_kind: isCivicDirectDocumentUrl(d.source_url) ? "pdf" : "html",
        ...(parsed.pages !== undefined ? { pages: parsed.pages } : {}),
      });
    }
  }
  const m: Manifest = {
    ...targets,
    documents,
    version: 1,
    run_id: crypto.randomUUID(),
    supabase_url: deployment,
    created_at: new Date().toISOString(),
    scout_snapshot: snapshot,
    discovery,
  };
  m.manifest_hash = await manifestHash(m);
  return m;
}
async function exactRows<T>(
  db: SupabaseClient,
  table: string,
  columns: string,
  userId: string,
  key: string,
  ids: string[],
) {
  if (!ids.length) return [];
  const { data, error, count } = await db.from(table).select(columns, {
    count: "exact",
  }).eq("user_id", userId).in(key, ids);
  if (error) throw new Error(`${table}: ${error.message}`);
  requireValue(
    count === data?.length,
    `${table}: incomplete verification results`,
  );
  return data as unknown as T[];
}
export async function status(db: SupabaseClient, m: Manifest) {
  const { data: run, error } = await db.from("scout_runs").select(
    "id,status,stage,metadata,notification_status,units_created_count,units_merged_count,error_message",
  ).eq("id", m.run_id).eq("user_id", m.user_id).eq("scout_id", m.scout_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!run) return { applied: false, run_id: m.run_id };
  requireValue(
    run.metadata?.ingestion_mode === "backfill" &&
      run.metadata?.manifest_hash === m.manifest_hash,
    "run identity does not match manifest",
  );
  const queue = await exactRows<
    {
      id: string;
      source_url: string;
      status: string;
      semantics_snapshot: {
        content_sha256: string;
        backfill_diagnostics?: Record<string, unknown>;
      };
    }
  >(
    db,
    "civic_extraction_queue",
    "id,source_url,status,attempts,last_error,raw_capture_id,semantics_snapshot",
    m.user_id,
    "scout_run_id",
    [m.run_id],
  );
  requireValue(
    queue.length === m.documents.length,
    "run queue does not match the manifest document count",
  );
  for (const q of queue) {
    requireValue(
      m.documents.some((d) =>
        d.source_url === q.source_url &&
        d.content_sha256 === q.semantics_snapshot.content_sha256
      ),
      "queue source differs from reviewed snapshot",
    );
  }
  const ledger = await exactRows<
    {
      queue_id: string;
      unit_id: string;
      created_canonical: boolean;
      merged_existing: boolean;
      occurrence_created: boolean;
      request_identity: { p_type: string };
    }
  >(
    db,
    "civic_queue_item_results",
    "queue_id,unit_id,created_canonical,merged_existing,occurrence_created,request_identity",
    m.user_id,
    "queue_id",
    queue.map((q) => q.id),
  );
  const ids = [...new Set(ledger.map((r) => r.unit_id as string))];
  const units = await exactRows<
    { id: string; type: string; deleted_at: string | null }
  >(db, "information_units", "id,type,deleted_at", m.user_id, "id", ids);
  const promises = await exactRows<
    {
      id: string;
      unit_id: string;
      active_revision_id: string | null;
      status: string;
    }
  >(
    db,
    "promises",
    "id,unit_id,active_revision_id,status",
    m.user_id,
    "unit_id",
    ids,
  );
  const revisions = await exactRows<{ id: string; promise_id: string }>(
    db,
    "promise_revisions",
    "id,promise_id",
    m.user_id,
    "id",
    promises.flatMap((p) => p.active_revision_id ? [p.active_revision_id] : []),
  );
  const occurrences = await exactRows<
    {
      id: string;
      unit_id: string;
      source_url: string;
      scout_id: string;
      scout_run_id: string;
      scout_type: string;
      content_sha256: string;
    }
  >(
    db,
    "unit_occurrences",
    "id,unit_id,source_url,scout_id,scout_run_id,scout_type,content_sha256",
    m.user_id,
    "scout_run_id",
    [m.run_id],
  );
  const alerts = await exactRows<{ id: string }>(
    db,
    "civic_run_alert_items",
    "id",
    m.user_id,
    "scout_run_id",
    [m.run_id],
  );
  const missing = ledger.filter((result) => {
    const document = queue.find((q) => q.id === result.queue_id);
    return !units.some((u) => u.id === result.unit_id && !u.deleted_at) ||
      !document ||
      !occurrences.some((o) =>
        o.unit_id === result.unit_id && o.scout_id === m.scout_id &&
        o.scout_type === "civic" && o.source_url === document.source_url &&
        o.content_sha256 === document.semantics_snapshot.content_sha256
      ) ||
      (result.request_identity.p_type === "promise" &&
        !promises.some((p) =>
          p.unit_id === result.unit_id &&
          revisions.some((r) =>
            r.id === p.active_revision_id && r.promise_id === p.id
          )
        ));
  }).map((r) => ({ queue_id: r.queue_id, unit_id: r.unit_id }));
  const created = ledger.filter((r) => r.created_canonical).length;
  const merged =
    ledger.filter((r) => r.merged_existing && r.occurrence_created).length;
  const countsMatch = run.units_created_count === created &&
    run.units_merged_count === merged && queue.every((q) => {
      const results = ledger.filter((r) => r.queue_id === q.id);
      const persisted = results.filter((r) => r.created_canonical).length +
        results.filter((r) => r.merged_existing && r.occurrence_created).length;
      return q.semantics_snapshot.backfill_diagnostics?.persisted_count ===
        persisted;
    });
  const terminal = queue.every((q) =>
    q.status === "done" || q.status === "failed"
  );
  return {
    applied: true,
    run_id: m.run_id,
    terminal,
    run,
    documents: queue.map(({ semantics_snapshot, ...q }) => ({
      ...q,
      diagnostics: semantics_snapshot.backfill_diagnostics,
      coverage:
        m.documents.find((d) => d.source_url === q.source_url)?.selection ??
          null,
    })),
    ledger,
    units,
    promises,
    occurrences,
    alert_count: alerts.length,
    missing_links: missing,
    counts_reconciled: countsMatch,
    database_verified: terminal && queue.every((q) => q.status === "done") &&
      run.status === "success" && alerts.length === 0 &&
      run.notification_status === "not_applicable" && missing.length === 0 &&
      countsMatch,
    authenticated_api_verified: false,
  };
}
async function main(args: string[]) {
  const [command = "plan", ...rest] = args;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    requireValue(
      rest[i].startsWith("--") && rest[i + 1] && !rest[i + 1].startsWith("--"),
      "flags require values",
    );
    requireValue(!flags[rest[i]], "duplicate flag");
    const allowed = command === "plan"
      ? ["--targets", "--out"]
      : command === "apply"
      ? ["--manifest", "--confirm"]
      : ["--manifest"];
    requireValue(allowed.includes(rest[i]), `unsupported flag: ${rest[i]}`);
    flags[rest[i]] = rest[i + 1];
  }
  const deployment = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  requireValue(
    deployment && key,
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required",
  );
  const db = createClient(deployment, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (command === "plan") {
    requireValue(
      flags["--targets"] && flags["--out"],
      "plan --targets selection.json --out manifest.json",
    );
    const m = await plan(
      db,
      deployment,
      validateTargets(JSON.parse(await Deno.readTextFile(flags["--targets"]))),
    );
    await Deno.writeTextFile(
      flags["--out"],
      JSON.stringify(m, null, 2) + "\n",
      { createNew: true, mode: 0o600 },
    );
    console.log(JSON.stringify(
      {
        dry_run: true,
        manifest: flags["--out"],
        manifest_hash: m.manifest_hash,
        run_id: m.run_id,
        documents: m.documents.map(({ markdown, ...d }) => ({
          ...d,
          characters: markdown.length,
        })),
      },
      null,
      2,
    ));
    return;
  }
  requireValue(
    ["apply", "status", "drain", "verify"].includes(command),
    "use plan, apply, status, drain or verify",
  );
  requireValue(flags["--manifest"], "--manifest required");
  const m = await validateManifest(
    JSON.parse(await Deno.readTextFile(flags["--manifest"])),
    deployment,
  );
  if (command === "apply") {
    requireValue(
      flags["--confirm"] === m.manifest_hash,
      "--confirm must equal the exact manifest digest",
    );
    const age = Date.now() - Date.parse(m.created_at);
    requireValue(
      Number.isFinite(age) && age >= -60_000 && age <= 7 * 86400000,
      "manifest expired; plan again after seven days",
    );
    const { error } = await db.rpc("enqueue_civic_backfill", {
      p_run_id: m.run_id,
      p_user_id: m.user_id,
      p_scout_id: m.scout_id,
      p_manifest_hash: m.manifest_hash,
      p_scout_snapshot: m.scout_snapshot,
      p_documents: m.documents,
    });
    if (error) throw new Error(error.message);
  }
  if (command === "drain") {
    // One explicitly scoped worker invocation; repeat safely or let cron resume.
    const before = await status(db, m);
    requireValue(before.applied, "apply the manifest before draining");
    if (!("terminal" in before && before.terminal)) {
      const response = await fetch(
        `${deployment}/functions/v1/civic-extract-worker`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ scout_run_id: m.run_id }),
          signal: AbortSignal.timeout(270000),
        },
      );
      if (!response.ok) {
        throw new Error(
          `worker HTTP ${response.status}; inspect status before resuming`,
        );
      }
      await response.body?.cancel();
    }
  }
  const report = await status(db, m);
  if (command === "verify") {
    requireValue(
      "database_verified" in report && report.database_verified,
      "database verification incomplete; inspect status",
    );
    const { apiFetch, loadConfig, KNOWN_HOSTED_SUPABASE_PROJECT_REF } =
      await import(
        "../cli/lib/client.ts"
      );
    const configured = loadConfig().api_url;
    requireValue(
      new URL(configured).origin === m.supabase_url ||
        (new URL(configured).origin === "https://scoutpost.ai" &&
          m.supabase_url ===
            `https://${KNOWN_HOSTED_SUPABASE_PROJECT_REF}.supabase.co`),
      "Scout CLI targets a different deployment",
    );
    const me = await apiFetch<{ user_id: string }>("/functions/v1/user/me");
    requireValue(
      me.user_id === m.user_id,
      "Scout CLI session must belong to the manifest owner",
    );
    const verifiedIds: string[] = [];
    for (const unit of report.units) {
      const visible = await apiFetch<{ id: string }>(
        `/functions/v1/units/${unit.id}`,
      );
      const civic = await apiFetch<{ item: { unit_id: string } }>(
        `/functions/v1/civic/items/${unit.id}`,
      );
      requireValue(
        visible.id === unit.id && civic.item.unit_id === unit.id,
        "information unit is not visible through both user APIs",
      );
      verifiedIds.push(unit.id);
    }
    console.log(
      JSON.stringify(
        {
          ...report,
          authenticated_api_verified: verifiedIds.length > 0,
          verified_unit_ids: verifiedIds,
          authenticated_api_checked: true,
          rendered_inbox_verified: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(JSON.stringify(report, null, 2));
}
if (import.meta.main) {
  main(Deno.args).catch((error) => {
    console.error(error.message);
    Deno.exit(1);
  });
}
