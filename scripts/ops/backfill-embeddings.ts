#!/usr/bin/env -S deno run --allow-net --allow-env

/** Stage and atomically apply OpenRouter Gemini vectors in the existing 768d space. */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  embedBatch,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_TAG,
  type EmbeddingInput,
} from "../../supabase/functions/_shared/embedding.ts";

export const TARGET_TAG = EMBEDDING_MODEL_TAG;
export const TARGET_DIMENSIONS = EMBEDDING_DIMENSIONS;

export type TableName =
  | "entities"
  | "reflections"
  | "information_units"
  | "execution_records";
export type BackfillAction = "inventory" | "stage" | "apply";

export const TABLES: TableName[] = [
  "entities",
  "reflections",
  "information_units",
  "execution_records",
];

type Row = Record<string, unknown> & { id: string };

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseAction(value: string | undefined): BackfillAction {
  const action = value?.trim().toLowerCase() || "inventory";
  if (action !== "inventory" && action !== "stage" && action !== "apply") {
    throw new Error("BACKFILL_ACTION must be inventory, stage, or apply");
  }
  return action;
}

export function embeddingInput(table: TableName, row: Row): EmbeddingInput {
  if (table === "entities") {
    const aliases = Array.isArray(row.aliases) ? row.aliases.join(", ") : "";
    return {
      text: [row.canonical_name, aliases].filter(Boolean).join("; "),
      taskType: "RETRIEVAL_DOCUMENT",
      title: String(row.type ?? "entity"),
    };
  }
  if (table === "reflections") {
    return {
      text: String(row.content ?? ""),
      taskType: "RETRIEVAL_DOCUMENT",
      title: String(row.scope_description ?? "reflection"),
    };
  }
  if (table === "execution_records") {
    return {
      text: String(row.summary_text ?? ""),
      taskType: "RETRIEVAL_DOCUMENT",
      title: String(row.scout_type ?? "scout execution"),
    };
  }
  return {
    text: String(row.statement ?? ""),
    taskType: "RETRIEVAL_DOCUMENT",
    title: String(row.source_title ?? "information unit"),
  };
}

function selectColumns(table: TableName): string {
  const columns: Record<TableName, string> = {
    entities: "id,canonical_name,type,aliases,embedding_model_v2",
    reflections: "id,content,scope_description,embedding_model_v2",
    information_units: "id,statement,source_title,embedding_model_v2",
    execution_records: "id,summary_text,scout_type,embedding_model_v2",
  };
  return columns[table];
}

async function inventory(supabase: any) {
  const { data, error } = await supabase.rpc(
    "embedding_v2_cutover_inventory",
  );
  if (error) throw new Error(`cutover inventory failed: ${error.message}`);
  return data ?? [];
}

async function stageTable(
  supabase: any,
  table: TableName,
  batchSize: number,
): Promise<number> {
  let lastId: string | null = null;
  let written = 0;
  while (true) {
    let query = supabase.from(table)
      .select(selectColumns(table))
      .or(`embedding_model_v2.is.null,embedding_model_v2.neq.${TARGET_TAG}`)
      .order("id")
      .limit(batchSize);
    if (lastId) query = query.gt("id", lastId);
    const { data, error } = await query;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as Row[];
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    const ids = rows.map((row) => row.id);
    const { data: existing, error: existingError } = await supabase
      .from("embedding_v2_cutover_stage")
      .select("row_id")
      .eq("table_name", table)
      .eq("embedding_model", TARGET_TAG)
      .in("row_id", ids);
    if (existingError) {
      throw new Error(
        `${table} staged-id read failed: ${existingError.message}`,
      );
    }
    const stagedIds = new Set(
      (existing ?? []).map((row: { row_id: string }) => row.row_id),
    );
    const pending = rows.filter((row) => !stagedIds.has(row.id));
    if (pending.length === 0) continue;

    const vectors = await embedBatch(
      pending.map((row) => embeddingInput(table, row)),
    );
    for (let index = 0; index < pending.length; index += 1) {
      const { error: writeError } = await supabase.rpc(
        "stage_embedding_v2_cutover",
        {
          p_table: table,
          p_id: pending[index].id,
          p_embedding: vectors[index],
          p_model: TARGET_TAG,
        },
      );
      if (writeError) {
        throw new Error(`${table} stage failed: ${writeError.message}`);
      }
    }
    written += pending.length;
    console.error(`${table}: ${written} staged`);
  }
  return written;
}

async function main(): Promise<void> {
  const action = parseAction(Deno.env.get("BACKFILL_ACTION"));
  const batchSize = Number(Deno.env.get("BACKFILL_BATCH_SIZE") ?? "32");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("BACKFILL_BATCH_SIZE must be between 1 and 100");
  }
  const supabase = createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  if (action === "inventory") {
    console.log(
      JSON.stringify({
        action,
        model: TARGET_TAG,
        inventory: await inventory(supabase),
      }),
    );
    return;
  }
  if (action === "apply") {
    const { data, error } = await supabase.rpc("apply_embedding_v2_cutover");
    if (error) throw new Error(`cutover apply failed: ${error.message}`);
    console.log(JSON.stringify({ action, result: data }));
    return;
  }

  required("OPENROUTER_API_KEY");
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    counts[table] = await stageTable(supabase, table, batchSize);
  }
  console.log(JSON.stringify({ action, model: TARGET_TAG, counts }));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
