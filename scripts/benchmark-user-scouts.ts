#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
import {
  apiFetch,
  loadConfig,
  parseArgs,
  unwrapItems,
} from "../cli/lib/client.ts";
import { envAny, envFlag } from "./_bench_shared.ts";

type ScoutType = "web" | "beat" | "civic" | "social";
type Platform = "instagram" | "x" | "facebook" | "tiktok";
type CaseKind = ScoutType | "actors";

interface Scout {
  id: string;
  name: string;
  type: ScoutType;
  last_run?: LastRun | null;
}

interface LastRun {
  started_at?: string | null;
  status?: string | null;
  articles_count?: number | null;
  merged_existing_count?: number | null;
}

interface RunTrigger {
  scout_id?: string;
  run_id?: string;
}

interface CreatedScout {
  id: string;
  name: string;
  type: ScoutType;
  terminal: boolean;
}

interface CaseResult {
  name: string;
  kind: CaseKind;
  ok: boolean;
  status: string;
  units: number | null;
  details: Record<string, unknown>;
  error: string | null;
  elapsedMs: number;
}

interface ActorProbe {
  valid?: boolean;
  profile_url?: string;
  error?: string;
  post_ids?: string[];
  preview_posts?: unknown[];
  posts_data?: unknown[];
}

interface PolledRun {
  started_at: string;
  status: string;
  articles_count: number | null;
  merged_existing_count: number | null;
}

const TERMINAL = new Set(["success", "error", "failed", "timeout"]);
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const POLL_MS = 10_000;

const actorCases: Array<{ platform: Platform; handle: string }> = [
  {
    platform: "instagram",
    handle:
      envAny("SCOUT_BENCH_INSTAGRAM_HANDLE", "COJO_BENCH_INSTAGRAM_HANDLE") ??
        "natgeo",
  },
  {
    platform: "x",
    handle: envAny("SCOUT_BENCH_X_HANDLE", "COJO_BENCH_X_HANDLE") ??
      "SadiqKhan",
  },
  {
    platform: "facebook",
    handle:
      envAny("SCOUT_BENCH_FACEBOOK_HANDLE", "COJO_BENCH_FACEBOOK_HANDLE") ??
        "nasa",
  },
  {
    platform: "tiktok",
    handle: envAny("SCOUT_BENCH_TIKTOK_HANDLE", "COJO_BENCH_TIKTOK_HANDLE") ??
      "natgeo",
  },
];

const args = parseArgs(Deno.args);
if (args.flags.help === true || args.flags.h === true) {
  usage();
  Deno.exit(0);
}

if (!envFlag("SCOUT_USER_BENCHMARK", "COJO_USER_BENCHMARK")) {
  throw new Error(
    "Refusing to mutate a real account. Set SCOUT_USER_BENCHMARK=1 to run " +
      "(legacy COJO_USER_BENCHMARK=1 is still accepted) " +
      "the deployed user-auth scout benchmark.",
  );
}

const cfg = loadConfig();
const keep = args.flags.keep === true;
const timeoutMs = Number(args.flags["timeout-min"] ?? 12) * 60 * 1000 ||
  DEFAULT_TIMEOUT_MS;
const selected = selectedKinds();
const prefix = typeof args.flags.prefix === "string"
  ? args.flags.prefix
  : `bench-user-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const created: CreatedScout[] = [];
const results: CaseResult[] = [];

console.log(`Target: ${cfg.api_url}`);
console.log(`Prefix: ${prefix}`);
console.log(
  "Mode: user-auth smoke. This uses the configured scout account, consumes " +
    "real credits/provider quota, and cleans up completed scouts by default.",
);

try {
  if (selected.has("actors")) {
    results.push(...await runActorHealth());
  }
  if (selected.has("web")) {
    results.push(await runWebScout());
  }
  if (selected.has("beat")) {
    results.push(await runBeatScout());
  }
  if (selected.has("civic")) {
    results.push(await runCivicScout());
  }
  if (selected.has("social")) {
    results.push(await runSocialScout());
  }
} finally {
  await cleanupCreatedScouts();
}

printResults(results);

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  throw new Error(
    `User scout benchmark failed: ${failed.map((r) => r.name).join(", ")}`,
  );
}

function usage(): void {
  console.log(`Usage:
  SCOUT_USER_BENCHMARK=1 deno run --allow-env --allow-net --allow-read \\
    scripts/benchmark-user-scouts.ts [--types actors,web,beat,civic,social]

Options:
  --types <list>       Comma-separated cases. Default: actors,web,beat,civic,social
  --timeout-min <n>    Run polling timeout per scout. Default: 12
  --prefix <text>      Scout name prefix. Default: bench-user-<timestamp>
  --keep               Keep created scouts for inspection

Notes:
  Uses ~/.scoutpost/config.json through the same client as scout.
  Actor health uses deployed /social-test, so no local APIFY_API_TOKEN is needed.
  Social and civic creation establishes a baseline; a fresh Run Now may produce
  zero units by design. This script treats that as healthy when creation,
  preview/baseline, and dispatch succeed.`);
}

function selectedKinds(): Set<CaseKind> {
  const raw = typeof args.flags.types === "string"
    ? args.flags.types
    : "actors,web,beat,civic,social";
  const allowed = new Set<CaseKind>([
    "actors",
    "web",
    "beat",
    "civic",
    "social",
  ]);
  const out = new Set<CaseKind>();
  for (const part of raw.split(",")) {
    const value = part.trim() as CaseKind;
    if (!value) continue;
    if (!allowed.has(value)) {
      throw new Error(`Unknown --types entry: ${value}`);
    }
    out.add(value);
  }
  return out;
}

async function runActorHealth(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of actorCases) {
    const started = performance.now();
    const name = `actor-${c.platform}`;
    try {
      const probe = await apiFetch<ActorProbe>("/functions/v1/social-test", {
        method: "POST",
        body: JSON.stringify({ platform: c.platform, handle: c.handle }),
      });
      const previewCount = Array.isArray(probe.preview_posts)
        ? probe.preview_posts.length
        : 0;
      const postIdCount = Array.isArray(probe.post_ids)
        ? probe.post_ids.length
        : 0;
      const ok = probe.valid === true && postIdCount > 0 && previewCount > 0;
      results.push({
        name,
        kind: "actors",
        ok,
        status: ok ? "success" : "failed",
        units: null,
        details: {
          platform: c.platform,
          handle: c.handle,
          profile_url: probe.profile_url ?? null,
          post_ids: postIdCount,
          preview_posts: previewCount,
          warning: probe.error ?? null,
        },
        error: ok
          ? null
          : probe.error ?? "social-test returned no normalized preview posts",
        elapsedMs: Math.round(performance.now() - started),
      });
    } catch (e) {
      results.push(errorResult(name, "actors", started, e));
    }
  }
  return results;
}

async function runWebScout(): Promise<CaseResult> {
  const started = performance.now();
  const name = `${prefix}-web`;
  try {
    const scout = await createScout({
      name,
      type: "web",
      topic: "benchmark",
      url:
        "https://www.baselland.ch/politik-und-behorden/regierungsrat/medienmitteilungen",
      criteria: "New official media releases or policy decisions",
      regularity: "weekly",
      schedule_cron: "0 8 * * MON",
    });
    await pauseScout(scout.id);
    const run = await runAndPoll(scout, started);
    const units = await countUnits(scout.id);
    return {
      name,
      kind: "web",
      ok: run.status === "success",
      status: run.status,
      units,
      details: {
        scout_id: scout.id,
        articles_count: run.articles_count ?? null,
        note:
          "Fresh Page Scout baselines often produce zero units until the source changes.",
      },
      error: run.status === "success" ? null : `run status ${run.status}`,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    return errorResult(name, "web", started, e);
  }
}

async function runBeatScout(): Promise<CaseResult> {
  const started = performance.now();
  const name = `${prefix}-beat`;
  try {
    const scout = await createScout({
      name,
      type: "beat",
      topic: "housing",
      criteria: "Zurich housing policy budget decision",
      source_mode: "reliable",
      regularity: "weekly",
      schedule_cron: "0 8 * * MON",
    });
    await pauseScout(scout.id);
    const run = await runAndPoll(scout, started);
    const units = await countUnits(scout.id);
    const count = (run.articles_count ?? 0) + (run.merged_existing_count ?? 0);
    const ok = run.status === "success" && (count > 0 || units > 0);
    return {
      name,
      kind: "beat",
      ok,
      status: run.status,
      units,
      details: {
        scout_id: scout.id,
        articles_count: run.articles_count ?? null,
        merged_existing_count: run.merged_existing_count ?? null,
      },
      error: ok ? null : "Beat run completed without units/articles",
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    return errorResult(name, "beat", started, e);
  }
}

async function runCivicScout(): Promise<CaseResult> {
  const started = performance.now();
  const name = `${prefix}-civic`;
  try {
    const trackedUrl =
      "https://grosserrat.bs.ch/ratsbetrieb/protokolle-videos?all=1";
    const preview = await apiFetch<{
      valid?: boolean;
      documents_found?: number;
      sample_promises?: unknown[];
      error?: string;
    }>("/functions/v1/civic/test", {
      method: "POST",
      body: JSON.stringify({
        tracked_urls: [trackedUrl],
        criteria: "Council decisions, commitments, spending, and deadlines",
      }),
    });
    const scout = await createScout({
      name,
      type: "civic",
      topic: "civic",
      root_domain: "grosserrat.bs.ch",
      tracked_urls: [trackedUrl],
      criteria: "Council decisions, commitments, spending, and deadlines",
      regularity: "weekly",
      schedule_cron: "0 8 * * MON",
    });
    await pauseScout(scout.id);
    const run = await runAndPoll(scout, started);
    const units = await countUnits(scout.id);
    const documentsFound = preview.documents_found ?? 0;
    const ok = documentsFound > 0 && run.status === "success";
    return {
      name,
      kind: "civic",
      ok,
      status: run.status,
      units,
      details: {
        scout_id: scout.id,
        documents_found: documentsFound,
        sample_promises: Array.isArray(preview.sample_promises)
          ? preview.sample_promises.length
          : 0,
        articles_count: run.articles_count ?? null,
        note:
          "Civic creation establishes a change-tracking baseline; immediate Run Now may enqueue zero docs.",
      },
      error: ok
        ? null
        : preview.error ?? "Civic preview or Run Now did not complete cleanly",
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    return errorResult(name, "civic", started, e);
  }
}

async function runSocialScout(): Promise<CaseResult> {
  const started = performance.now();
  const name = `${prefix}-social-instagram`;
  try {
    const scout = await createScout({
      name,
      type: "social",
      topic: "benchmark",
      platform: "instagram",
      profile_handle: "natgeo",
      monitor_mode: "summarize",
      regularity: "weekly",
      schedule_cron: "0 8 * * MON",
    });
    await pauseScout(scout.id);
    const run = await runAndPoll(scout, started);
    const units = await countUnits(scout.id);
    const ok = run.status === "success";
    return {
      name,
      kind: "social",
      ok,
      status: run.status,
      units,
      details: {
        scout_id: scout.id,
        platform: "instagram",
        handle: "natgeo",
        articles_count: run.articles_count ?? null,
        note:
          "Social creation scans the baseline. Immediate Run Now may produce zero units when there are no newer posts.",
      },
      error: ok ? null : `run status ${run.status}`,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    return errorResult(name, "social", started, e);
  }
}

async function createScout(body: Record<string, unknown>): Promise<Scout> {
  const scout = await apiFetch<Scout>("/functions/v1/scouts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  created.push({
    id: scout.id,
    name: scout.name,
    type: scout.type,
    terminal: false,
  });
  return scout;
}

async function pauseScout(id: string): Promise<void> {
  await apiFetch(`/functions/v1/scouts/${id}/pause`, { method: "POST" });
}

async function runAndPoll(
  scout: Scout,
  started: number,
): Promise<PolledRun> {
  const before = scout.last_run?.started_at ?? null;
  const triggered = await apiFetch<RunTrigger>(
    `/functions/v1/scouts/${scout.id}/run`,
    { method: "POST" },
  );
  const deadline = Date.now() + timeoutMs;
  let last: LastRun | null = null;
  while (Date.now() < deadline) {
    const current = await apiFetch<Scout>(`/functions/v1/scouts/${scout.id}`);
    last = current.last_run ?? null;
    if (
      last?.status &&
      last.started_at &&
      last.started_at !== before &&
      TERMINAL.has(last.status)
    ) {
      markTerminal(scout.id);
      return {
        started_at: last.started_at,
        status: last.status,
        articles_count: last.articles_count ?? null,
        merged_existing_count: last.merged_existing_count ?? null,
      };
    }
    await delay(POLL_MS);
  }
  throw new Error(
    `Timed out waiting for run ${triggered.run_id ?? ""} after ${
      Math.round((performance.now() - started) / 1000)
    }s; latest status=${last?.status ?? "none"}`,
  );
}

function markTerminal(id: string): void {
  const found = created.find((s) => s.id === id);
  if (found) found.terminal = true;
}

async function countUnits(scoutId: string): Promise<number> {
  const data = await apiFetch(
    `/functions/v1/units?scout_id=${scoutId}&limit=10`,
  );
  return unwrapItems(data).length;
}

async function cleanupCreatedScouts(): Promise<void> {
  if (keep) {
    console.log("\n--keep set; leaving created scouts in place.");
    return;
  }
  for (const scout of [...created].reverse()) {
    if (
      !scout.terminal && (scout.type === "social" || scout.type === "civic")
    ) {
      console.log(
        `Keeping non-terminal async ${scout.type} scout for callback/worker safety: ${scout.id}`,
      );
      continue;
    }
    try {
      await apiFetch(`/functions/v1/scouts/${scout.id}`, { method: "DELETE" });
      console.log(`Deleted scout ${scout.id} (${scout.name})`);
    } catch (e) {
      console.error(
        `Failed to delete scout ${scout.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

function printResults(results: CaseResult[]): void {
  console.log("\nResults:");
  for (const r of results) {
    const mark = r.ok ? "OK" : "FAIL";
    const units = r.units === null ? "" : ` units=${r.units}`;
    console.log(
      `${mark} ${r.name} kind=${r.kind} status=${r.status}${units} elapsed=${r.elapsedMs}ms` +
        (r.error ? ` error=${r.error}` : ""),
    );
  }
  console.log("\nJSON:");
  console.log(JSON.stringify({ target: cfg.api_url, results }, null, 2));
}

function errorResult(
  name: string,
  kind: CaseKind,
  started: number,
  e: unknown,
): CaseResult {
  return {
    name,
    kind,
    ok: false,
    status: "error",
    units: null,
    details: {},
    error: e instanceof Error ? e.message : String(e),
    elapsedMs: Math.round(performance.now() - started),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
