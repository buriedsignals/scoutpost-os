#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read=.
/**
 * Page Scout alert acceptance gate.
 *
 * Exercises the deployed Page Scout worker end to end without sending email:
 * scrape -> canonical delta -> criteria agent -> optional unit extraction and
 * embedding -> capture/baseline persistence -> notification planning.
 *
 * The monitored pages are synthetic httpbin responses. Customer criteria and
 * page content are never used. Every temporary scout is deleted after its run.
 *
 * Run through the linked-project launcher after the worker version containing
 * `notification_mode: "disabled"` is deployed:
 *
 *   scripts/benchmarks/with-linked-supabase-env.sh \
 *     deno run --allow-env --allow-net --allow-read=. \
 *     scripts/benchmarks/benchmark-page-scout-alert-pipeline.ts
 */

import {
  type BenchCtx,
  dataApiHeaders,
  envFlag,
  getBenchCtx,
  pgDelete,
  pgInsert,
  purgeScoutUnits,
  triggerScoutRun,
  waitForScoutRun,
} from "./_bench_shared.ts";
import {
  PAGE_SCOUT_ALERT_FIXTURES,
} from "../../supabase/functions/_shared/page_scout_alert_fixtures.ts";
import {
  WEB_CANONICALIZER_VERSION,
  webCanonicalHash,
} from "../../supabase/functions/_shared/web_content_canonical.ts";

interface WorkerResponse {
  status?: string;
  change?: string;
  alert_eligible?: boolean;
  notification_suppressed?: boolean;
  articles_count?: number;
  error?: string;
}

interface RunRow {
  id: string;
  status: string;
  articles_count: number | null;
  error_message: string | null;
  criteria_status: boolean | null;
  notification_status: string | null;
  metadata: Record<string, unknown> | null;
}

interface UnitRow {
  id: string;
  statement: string;
  embedding_model: string | null;
  raw_capture_id: string | null;
}

interface CaseResult {
  id: string;
  expectedAlert: boolean;
  actualAlert: boolean | null;
  change: string | null;
  runStatus: string | null;
  units: number;
  embeddedUnits: number;
  capturePersisted: boolean;
  baselineAdvanced: boolean | null;
  errors: string[];
}

if (!envFlag("SCOUT_LIVE_BENCHMARK", "COJO_LIVE_BENCHMARK")) {
  throw new Error(
    "Refusing to run without SCOUT_LIVE_BENCHMARK=1; this creates temporary scouts and spends provider credits.",
  );
}

const pattern = argumentValue("--case");
const fixtures = pattern
  ? PAGE_SCOUT_ALERT_FIXTURES.filter((fixture) => fixture.id.includes(pattern))
  : PAGE_SCOUT_ALERT_FIXTURES;
if (fixtures.length === 0) throw new Error(`no fixture matched ${pattern}`);

const ctx = await getBenchCtx({ userToken: true });
console.log(
  `Page Scout alert pipeline: ${fixtures.length} cases as ${ctx.ownerEmail}; email delivery disabled`,
);

const verifyBaselineIds = new Set([
  fixtures.find((fixture) => !fixture.expectedAlert)?.id,
  fixtures.find((fixture) => fixture.expectedAlert)?.id,
].filter((value): value is string => Boolean(value)));
const results: CaseResult[] = [];

for (const fixture of fixtures) {
  const result: CaseResult = {
    id: fixture.id,
    expectedAlert: fixture.expectedAlert,
    actualAlert: null,
    change: null,
    runStatus: null,
    units: 0,
    embeddedUnits: 0,
    capturePersisted: false,
    baselineAdvanced: null,
    errors: [],
  };
  let scoutId: string | null = null;
  try {
    const sourceUrl = httpbinTextUrl(fixture.after, fixture.id);
    const scout = await pgInsert<{ id: string }>(ctx, "scouts", {
      user_id: ctx.userId,
      name: `bench-page-alert-${fixture.id}-${crypto.randomUUID().slice(0, 8)}`,
      type: "web",
      url: sourceUrl,
      criteria: fixture.criteria,
      preferred_language: fixture.language,
      provider: "firecrawl_plain",
      regularity: "weekly",
      schedule_cron: "0 0 1 1 *",
      baseline_established_at: new Date().toISOString(),
      // Run Now rejects paused scouts. Direct insertion does not install a
      // cron job, and this annual schedule is not due during the benchmark's
      // short lifetime, so the dispatcher is exercised without a scheduler
      // race.
      is_active: true,
      archive_enabled: false,
      metadata: {
        page_scout_benchmark: { notification_mode: "disabled" },
      },
    });
    scoutId = scout.id;
    await seedBaseline(ctx, scoutId, sourceUrl, fixture.before);

    const first = await runWithoutEmail(ctx, scoutId);
    result.actualAlert = first.body.alert_eligible ?? null;
    result.change = first.body.change ?? null;
    result.runStatus = first.run.status;
    const alertMeta = recordValue(first.run.metadata, "page_scout_alert");
    const criteriaMeta = recordValue(
      first.run.metadata,
      "criteria_primary_delta",
    );
    const extractionMeta = recordValue(
      first.run.metadata,
      "extraction_primary_delta",
    );

    if (first.status !== 200 || first.body.status !== "ok") {
      result.errors.push(
        `worker HTTP ${first.status}: ${
          first.body.error ?? JSON.stringify(first.body)
        }`,
      );
    }
    if (first.run.status !== "success") {
      result.errors.push(
        `run ${first.run.status}: ${
          first.run.error_message ?? "unknown error"
        }`,
      );
    }
    if (first.body.alert_eligible !== fixture.expectedAlert) {
      result.errors.push(
        `alert=${first.body.alert_eligible}, expected ${fixture.expectedAlert}` +
          (typeof criteriaMeta.agentReason === "string"
            ? `; agent reason=${criteriaMeta.agentReason}`
            : ""),
      );
    }
    if (first.run.notification_status !== "skipped") {
      result.errors.push(
        `notification_status=${first.run.notification_status}, expected skipped`,
      );
    }
    if (alertMeta.notification_mode !== "disabled") {
      result.errors.push("worker did not record notification_mode=disabled");
    }
    if (alertMeta.eligible !== fixture.expectedAlert) {
      result.errors.push(
        `run metadata eligible=${
          String(alertMeta.eligible)
        }, expected ${fixture.expectedAlert}`,
      );
    }
    if (
      fixture.expectedAlert && first.body.notification_suppressed !== true
    ) {
      result.errors.push(
        "eligible alert was not explicitly delivery-suppressed",
      );
    }

    const captures = await fetchRunCaptures(ctx, first.run.id);
    result.capturePersisted = captures.some((capture) =>
      capture.source_url === sourceUrl &&
      Boolean(capture.canonical_content_sha256)
    );
    if (!result.capturePersisted) {
      result.errors.push("canonical raw capture was not persisted");
    }

    const units = await fetchRunUnits(ctx, first.run.id);
    result.units = units.length;
    result.embeddedUnits = units.filter((unit) =>
      Boolean(unit.embedding_model)
    ).length;
    if (fixture.expectedAlert) {
      if (units.length === 0) {
        result.errors.push(
          "matching delta produced no information units" +
            (typeof extractionMeta.outcome === "string"
              ? `; extraction=${JSON.stringify(extractionMeta)}`
              : ""),
        );
      } else if (result.embeddedUnits !== units.length) {
        result.errors.push(
          `${result.embeddedUnits}/${units.length} information units have embeddings`,
        );
      }
      if (units.some((unit) => !unit.raw_capture_id)) {
        result.errors.push(
          "an information unit is not linked to its raw capture",
        );
      }
    } else if (units.length !== 0) {
      result.errors.push(
        `non-matching delta produced ${units.length} information units`,
      );
    }

    if (verifyBaselineIds.has(fixture.id) && first.run.status === "success") {
      const second = await runWithoutEmail(ctx, scoutId);
      result.baselineAdvanced = second.body.change === "same" &&
        second.body.alert_eligible === false &&
        second.run.notification_status === "skipped";
      if (!result.baselineAdvanced) {
        result.errors.push(
          `second unchanged run was change=${second.body.change}, alert=${second.body.alert_eligible}, notification=${second.run.notification_status}`,
        );
      }
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (scoutId) {
      await purgeScoutUnits(ctx, scoutId).catch(() => {});
      await pgDelete(ctx, "scouts", { id: scoutId }).catch(() => {});
    }
  }
  results.push(result);
  console.log(
    `${result.errors.length === 0 ? "PASS" : "FAIL"} ${result.id} ` +
      `alert=${
        String(result.actualAlert)
      } units=${result.units} embedded=${result.embeddedUnits}` +
      (result.baselineAdvanced === null
        ? ""
        : ` baseline=${result.baselineAdvanced ? "advanced" : "failed"}`),
  );
  for (const error of result.errors) console.log(`  - ${error}`);
}

const failed = results.filter((result) => result.errors.length > 0);
console.log(
  `\n${
    results.length - failed.length
  }/${results.length} Page Scout alert pipeline cases passed`,
);
if (failed.length > 0) Deno.exit(1);

async function seedBaseline(
  bench: BenchCtx,
  scoutId: string,
  sourceUrl: string,
  markdown: string,
): Promise<void> {
  await pgInsert(bench, "raw_captures", {
    user_id: bench.userId,
    scout_id: scoutId,
    source_url: sourceUrl,
    source_domain: new URL(sourceUrl).hostname.toLowerCase(),
    content_md: markdown,
    canonical_content_sha256: await webCanonicalHash(markdown),
    canonicalizer_version: WEB_CANONICALIZER_VERSION,
    token_count: Math.ceil(markdown.length / 4),
    captured_at: new Date(Date.now() + 1_000).toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
  });
}

async function runWithoutEmail(
  bench: BenchCtx,
  scoutId: string,
): Promise<{ status: number; body: WorkerResponse; run: RunRow }> {
  const runId = await triggerScoutRun(bench, scoutId);
  const row = await waitForScoutRun(bench, runId, {
    select:
      "id,status,articles_count,error_message,criteria_status,notification_status,metadata",
  }) as RunRow;
  const alert = recordValue(row.metadata, "page_scout_alert");
  const succeeded = row.status === "success";
  return {
    status: succeeded ? 200 : 500,
    body: {
      status: succeeded ? "ok" : row.status,
      change: row.criteria_status === false ? "same" : "changed",
      alert_eligible: typeof alert.eligible === "boolean"
        ? alert.eligible
        : undefined,
      notification_suppressed:
        alert.suppression_reason === "test_delivery_disabled",
      articles_count: row.articles_count ?? 0,
      error: row.error_message ?? undefined,
    },
    run: row,
  };
}

async function fetchRunCaptures(
  bench: BenchCtx,
  runId: string,
): Promise<
  Array<{ source_url: string; canonical_content_sha256: string | null }>
> {
  const query = new URLSearchParams({
    select: "source_url,canonical_content_sha256",
    scout_run_id: `eq.${runId}`,
  });
  const response = await fetch(
    `${bench.supabaseUrl}/rest/v1/raw_captures?${query}`,
    { headers: dataApiHeaders(bench) },
  );
  if (!response.ok) {
    throw new Error(
      `capture query failed ${response.status}: ${await response.text()}`,
    );
  }
  return await response.json();
}

async function fetchRunUnits(
  bench: BenchCtx,
  runId: string,
): Promise<UnitRow[]> {
  const occurrenceQuery = new URLSearchParams({
    select: "unit_id,raw_capture_id",
    scout_run_id: `eq.${runId}`,
  });
  const occurrenceResponse = await fetch(
    `${bench.supabaseUrl}/rest/v1/unit_occurrences?${occurrenceQuery}`,
    { headers: dataApiHeaders(bench) },
  );
  if (!occurrenceResponse.ok) {
    throw new Error(
      `unit occurrence query failed ${occurrenceResponse.status}: ${await occurrenceResponse
        .text()}`,
    );
  }
  const occurrences = await occurrenceResponse.json() as Array<{
    unit_id: string;
    raw_capture_id: string | null;
  }>;
  if (occurrences.length === 0) return [];

  const unitQuery = new URLSearchParams({
    select: "id,statement,embedding_model",
    id: `in.(${[...new Set(occurrences.map((row) => row.unit_id))].join(",")})`,
  });
  const unitResponse = await fetch(
    `${bench.supabaseUrl}/rest/v1/information_units?${unitQuery}`,
    { headers: dataApiHeaders(bench) },
  );
  if (!unitResponse.ok) {
    throw new Error(
      `canonical unit query failed ${unitResponse.status}: ${await unitResponse
        .text()}`,
    );
  }
  const units = await unitResponse.json() as Array<
    Omit<UnitRow, "raw_capture_id">
  >;
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  return occurrences.flatMap((occurrence) => {
    const unit = byId.get(occurrence.unit_id);
    return unit ? [{ ...unit, raw_capture_id: occurrence.raw_capture_id }] : [];
  });
}

function httpbinTextUrl(text: string, id: string): string {
  const bytes = new TextEncoder().encode(`# ${id}\n\n${text}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return `https://httpbin.org/base64/${encoded}`;
}

function recordValue(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> {
  const candidate = value?.[key];
  return candidate && typeof candidate === "object" &&
      !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}

function argumentValue(name: string): string | null {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] ?? null : null;
}
