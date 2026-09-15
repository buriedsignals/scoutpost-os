#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";

const HELP =
  `Replay explicitly selected paused Page Scouts through the normal workflow.

Usage:
  deno run --allow-env --allow-net --allow-write scripts/ops/replay-paused-web-scouts.ts preview --scout-id UUID [--scout-id UUID ...] --output FILE
  deno run --allow-env --allow-net --allow-read scripts/ops/replay-paused-web-scouts.ts apply --preview FILE --approve-maximum-credits INTEGER
  deno run scripts/ops/replay-paused-web-scouts.ts --help

SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required except for --help.
Optional --allow-run=jj records the source commit without snapshotting the workspace;
it identifies the recorded revision, not uncommitted source changes.
Preview only calls the read-only RPC mode and creates a new private file (no overwrite).
The file contains sensitive customer URLs, configuration, ownership and baseline state.
Keep it private, review its full snapshots/writes/costs, and do not commit or share it.
Apply requires approval exactly equal to the file's total maximum credit cost.
It keeps Scouts paused and notifications disabled; normal workflow writes and credit
accounting still occur. It does not charge, refund or change schedules directly.
Apply stops at the first conflict/error; earlier submissions are not rolled back.
Rerun the SAME file and approval after partial/uncertain submission: fixed run IDs
are idempotent. Do not generate a new preview to retry already submitted runs.
RPC success means queued/existing, not successful completion of the workflow.
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ObjectValue = Record<string, unknown>;
type RpcPreview = ObjectValue & {
  scout_id: string;
  run_id: string;
  url: string;
  user_id: string;
  snapshot: ObjectValue;
  maximum_credit_cost: number;
  writes: string[];
};
type Preview = {
  format_version: 1;
  project_url: string;
  created_at: string;
  source_version: string | null;
  scouts: RpcPreview[];
  total_maximum_credit_cost: number;
  writes: string[];
};
type Options =
  | { action: "help" }
  | { action: "preview"; scoutIds: string[]; output: string }
  | { action: "apply"; preview: string; approval: number };

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("Expected an explicit UUID");
  }
}

function projectUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid SUPABASE_URL/project URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) || url.username ||
    url.password ||
    url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error(
      "Project URL must be an HTTP(S) origin without credentials",
    );
  }
  return url.origin;
}

export function parseReplayArgs(args: string[]): Options {
  if (args.length === 1 && args[0] === "--help") return { action: "help" };
  const action = args[0];
  if (action !== "preview" && action !== "apply") {
    throw new Error("Expected preview or apply; use --help");
  }
  const scoutIds: string[] = [];
  const values = new Map<string, string>();
  const allowed = action === "preview"
    ? ["--scout-id", "--output"]
    : ["--preview", "--approve-maximum-credits"];
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!allowed.includes(flag) || !value?.trim() || value.startsWith("--")) {
      throw new Error("Invalid or missing option; use --help");
    }
    if (flag === "--scout-id") {
      requireUuid(value);
      scoutIds.push(value.toLowerCase());
    } else {
      if (values.has(flag)) throw new Error("Duplicate option");
      values.set(flag, value);
    }
  }
  if (action === "preview") {
    const output = values.get("--output");
    if (!output || scoutIds.length === 0) {
      throw new Error("Preview requires --scout-id and --output");
    }
    if (new Set(scoutIds).size !== scoutIds.length) {
      throw new Error("Duplicate scout UUID");
    }
    return { action, scoutIds, output };
  }
  const preview = values.get("--preview");
  const creditText = values.get("--approve-maximum-credits");
  if (!preview || !creditText || !/^(0|[1-9][0-9]*)$/.test(creditText)) {
    throw new Error(
      "Apply requires --preview and explicit integer --approve-maximum-credits",
    );
  }
  const approval = Number(creditText);
  if (!Number.isSafeInteger(approval)) {
    throw new Error("Credit approval is too large");
  }
  return { action, preview, approval };
}

function validateRpcPreview(value: unknown): asserts value is RpcPreview {
  if (!object(value)) throw new Error("Malformed RPC preview");
  requireUuid(value.scout_id);
  requireUuid(value.run_id);
  requireUuid(value.user_id);
  const snapshot = value.snapshot;
  if (
    typeof value.url !== "string" || value.url.length === 0 ||
    !(value.name === null || typeof value.name === "string") ||
    value.maximum_credit_cost !== 1 || value.notification_mode !== "disabled" ||
    value.crawler_backend !== "workflow" || value.schedule_changed !== false ||
    !Array.isArray(value.writes) || value.writes.length === 0 ||
    !value.writes.every((write) =>
      typeof write === "string" && write.length > 0
    ) ||
    !object(snapshot) || !object(snapshot.scout) ||
    !Array.isArray(snapshot.baseline_captures) ||
    !snapshot.baseline_captures.every(object) ||
    snapshot.scout.id !== value.scout_id ||
    snapshot.scout.user_id !== value.user_id ||
    snapshot.scout.url !== value.url || snapshot.scout.name !== value.name ||
    snapshot.scout.type !== "web" || snapshot.scout.is_active !== false
  ) throw new Error("Malformed or unsupported replay preview contract");
}

function validatePreview(value: unknown): asserts value is Preview {
  if (
    !object(value) || value.format_version !== 1 ||
    typeof value.project_url !== "string" ||
    projectUrl(value.project_url) !== value.project_url ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !(value.source_version === null ||
      (typeof value.source_version === "string" &&
        /^[0-9a-f]{40}$/.test(value.source_version))) ||
    !Array.isArray(value.scouts) || value.scouts.length === 0
  ) throw new Error("Malformed replay preview file");
  for (const scout of value.scouts) validateRpcPreview(scout);
  const scouts = value.scouts as RpcPreview[];
  if (
    new Set(scouts.map((scout) => scout.scout_id.toLowerCase())).size !==
      scouts.length ||
    new Set(scouts.map((scout) => scout.run_id.toLowerCase())).size !==
      scouts.length ||
    value.total_maximum_credit_cost !== scouts.length ||
    JSON.stringify(value.writes) !==
      JSON.stringify([...new Set(scouts.flatMap((scout) => scout.writes))])
  ) {
    throw new Error(
      "Preview IDs, total credit cost or writes do not match its Scouts",
    );
  }
}

export async function createReplayPreview(
  client: SupabaseClient,
  project: string,
  scoutIds: string[],
  sourceVersion: string | null = null,
): Promise<Preview> {
  const project_url = projectUrl(project);
  if (scoutIds.length === 0) {
    throw new Error("Explicit scout UUIDs are required");
  }
  scoutIds.forEach(requireUuid);
  const ids = scoutIds.map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate scout UUID");
  if (sourceVersion !== null && !/^[0-9a-f]{40}$/.test(sourceVersion)) {
    throw new Error("Invalid source revision");
  }
  const scouts: RpcPreview[] = [];
  for (const scout_id of ids) {
    const run_id = crypto.randomUUID();
    const { data, error } = await client.rpc("prepare_page_scout_replay", {
      p_scout_id: scout_id,
      p_run_id: run_id,
      p_apply: false,
    });
    if (error) throw new Error(`Preview ${scout_id}: ${error.message}`);
    validateRpcPreview(data);
    if (data.scout_id !== scout_id || data.run_id !== run_id) {
      throw new Error("RPC preview returned different Scout/run IDs");
    }
    scouts.push(data);
  }
  return {
    format_version: 1,
    project_url,
    created_at: new Date().toISOString(),
    source_version: sourceVersion,
    scouts,
    total_maximum_credit_cost: scouts.reduce(
      (sum, scout) => sum + scout.maximum_credit_cost,
      0,
    ),
    writes: [...new Set(scouts.flatMap((scout) => scout.writes))],
  };
}

export async function applyReplayPreview(
  client: SupabaseClient,
  project: string,
  preview: unknown,
  approval: number,
): Promise<ObjectValue[]> {
  validatePreview(preview);
  if (projectUrl(project) !== preview.project_url) {
    throw new Error("Preview project mismatch");
  }
  if (
    !Number.isSafeInteger(approval) ||
    approval !== preview.total_maximum_credit_cost
  ) {
    throw new Error(
      "Explicit credit approval must equal the preview total maximum credit cost",
    );
  }
  const results: ObjectValue[] = [];
  for (const scout of preview.scouts) {
    try {
      const { data, error } = await client.rpc("prepare_page_scout_replay", {
        p_scout_id: scout.scout_id,
        p_run_id: scout.run_id,
        p_apply: true,
        p_expected_snapshot: scout.snapshot,
        p_approved_credit_cost: scout.maximum_credit_cost,
      });
      if (error) throw new Error(error.message);
      if (
        !object(data) || data.scout_id !== scout.scout_id ||
        data.run_id !== scout.run_id ||
        typeof data.created !== "boolean" || typeof data.status !== "string" ||
        data.approved_credit_cost !== scout.maximum_credit_cost
      ) {
        throw new Error(
          "Malformed replay apply response; submission outcome is uncertain",
        );
      }
      results.push(data);
    } catch (error) {
      throw new Error(
        `Apply ${scout.scout_id} run ${scout.run_id} failed after ${results.length} acknowledged submissions: ${
          error instanceof Error ? error.message : "RPC failed"
        }. Rerun the same preview file and approval; prior submissions are not rolled back.`,
      );
    }
  }
  return results;
}

async function sourceVersion(): Promise<string | null> {
  try {
    if (
      (await Deno.permissions.query({ name: "run", command: "jj" })).state !==
        "granted"
    ) return null;
    const result = await new Deno.Command("jj", {
      args: [
        "--ignore-working-copy",
        "log",
        "-r",
        "@",
        "--no-graph",
        "-T",
        "commit_id",
      ],
      cwd: new URL("../../", import.meta.url),
      stdout: "piped",
      stderr: "null",
    }).output();
    const revision = new TextDecoder().decode(result.stdout).trim();
    return result.success && /^[0-9a-f]{40}$/.test(revision) ? revision : null;
  } catch {
    // Version provenance is optional when Jujutsu or its permission is unavailable.
    return null;
  }
}

async function main(): Promise<void> {
  let key: string | undefined;
  try {
    const options = parseReplayArgs(Deno.args);
    if (options.action === "help") {
      console.log(HELP);
      return;
    }
    const project = Deno.env.get("SUPABASE_URL");
    key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!project || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required",
      );
    }
    const client = createClient(projectUrl(project), key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    if (options.action === "preview") {
      const preview = await createReplayPreview(
        client,
        project,
        options.scoutIds,
        await sourceVersion(),
      );
      const text = JSON.stringify(preview, null, 2) + "\n";
      if (text.includes(key)) {
        throw new Error(
          "Refusing to persist a response containing the service credential",
        );
      }
      await Deno.writeTextFile(options.output, text, {
        createNew: true,
        mode: 0o600,
      });
      console.log(
        `Private preview saved; ${preview.scouts.length} Scouts, maximum ${preview.total_maximum_credit_cost} credits. Review the file before applying.`,
      );
    } else {
      const preview: unknown = JSON.parse(
        await Deno.readTextFile(options.preview),
      );
      const results = await applyReplayPreview(
        client,
        project,
        preview,
        options.approval,
      );
      console.log(
        JSON.stringify(results, null, 2).replaceAll(key, "[REDACTED]"),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Replay failed";
    console.error(key ? message.replaceAll(key, "[REDACTED]") : message);
    Deno.exitCode = 1;
  }
}

if (import.meta.main) await main();
