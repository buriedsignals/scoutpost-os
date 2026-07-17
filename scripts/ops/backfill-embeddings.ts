#!/usr/bin/env -S deno run --allow-net --allow-env

/** Resumable shadow-space backfill for local EmbeddingGemma vectors. */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const TARGET_TAG = "embeddinggemma-300m-768-int8-onnx-task-prefix-v1";
export const TARGET_DIMENSIONS = 768;

export type TableName =
  | "entities"
  | "reflections"
  | "information_units"
  | "execution_records";

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

export function parseDryRun(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "false";
}

export function embeddingInput(table: TableName, row: Row) {
  if (table === "entities") {
    const aliases = Array.isArray(row.aliases) ? row.aliases.join(", ") : "";
    return {
      text: [row.canonical_name, aliases].filter(Boolean).join("; "),
      task_type: "RETRIEVAL_DOCUMENT",
      title: String(row.type ?? "entity"),
    };
  }
  if (table === "reflections") {
    return {
      text: String(row.content ?? ""),
      task_type: "RETRIEVAL_DOCUMENT",
      title: String(row.scope_description ?? "reflection"),
    };
  }
  if (table === "execution_records") {
    return {
      text: String(row.summary_text ?? ""),
      task_type: "RETRIEVAL_DOCUMENT",
      title: String(row.scout_type ?? "scout execution"),
    };
  }
  return {
    text: String(row.statement ?? ""),
    task_type: "RETRIEVAL_DOCUMENT",
    title: String(row.source_title ?? "information unit"),
  };
}

function selectColumns(table: TableName): string {
  const columns: Record<TableName, string> = {
    entities: "id,canonical_name,type,aliases",
    reflections: "id,content,scope_description",
    information_units: "id,statement,source_title",
    execution_records: "id,summary_text,scout_type",
  };
  return columns[table];
}

export function validateEmbeddingResponse(
  value: unknown,
  expected: number,
): number[][] {
  const body = value as Record<string, unknown>;
  if (
    body?.model !== TARGET_TAG || body?.dimensions !== TARGET_DIMENSIONS ||
    !Array.isArray(body?.data) || body.data.length !== expected
  ) {
    throw new Error("Embedding service model/count contract mismatch");
  }
  const ordered: Array<number[] | undefined> = new Array(expected);
  for (const item of body.data as Array<Record<string, unknown>>) {
    const index = item?.index;
    const vector = item?.embedding;
    if (
      !Number.isInteger(index) || (index as number) < 0 ||
      (index as number) >= expected || ordered[index as number] ||
      !Array.isArray(vector) || vector.length !== TARGET_DIMENSIONS ||
      !vector.every((entry) =>
        typeof entry === "number" && Number.isFinite(entry)
      )
    ) {
      throw new Error("Embedding service returned an invalid vector");
    }
    ordered[index as number] = vector as number[];
  }
  if (ordered.some((vector) => vector === undefined)) {
    throw new Error("Embedding service omitted an input index");
  }
  return ordered as number[][];
}

async function main(): Promise<void> {
  const dryRun = parseDryRun(Deno.env.get("DRY_RUN"));
  const batchSize = Number(Deno.env.get("BACKFILL_BATCH_SIZE") ?? "16");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) {
    throw new Error("BACKFILL_BATCH_SIZE must be between 1 and 32");
  }
  const supabase = createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  if (dryRun) {
    const inventory = [];
    for (const table of TABLES) {
      const { count, error } = await supabase.from(table)
        .select("id", { count: "exact", head: true })
        .is("embedding_v2", null);
      if (error) throw new Error(`${table} inventory failed: ${error.message}`);
      inventory.push({ table, remaining: count ?? 0 });
    }
    console.log(
      JSON.stringify({ status: "dry_run", model: TARGET_TAG, inventory }),
    );
    return;
  }

  const serviceUrl = required("EMBEDDING_SERVICE_URL").replace(/\/+$/, "");
  const serviceToken = required("EMBEDDING_SERVICE_TOKEN");
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    let written = 0;
    while (true) {
      const { data, error } = await supabase.from(table)
        .select(selectColumns(table)).is("embedding_v2", null)
        .order("id").limit(batchSize);
      if (error) throw new Error(`${table} read failed: ${error.message}`);
      const rows = (data ?? []) as unknown as Row[];
      if (rows.length === 0) break;
      const response = await fetch(`${serviceUrl}/embed`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: rows.map((row) => embeddingInput(table, row)),
        }),
      });
      if (!response.ok) {
        throw new Error(
          `${table} embedding failed with status ${response.status}`,
        );
      }
      const vectors = validateEmbeddingResponse(
        await response.json(),
        rows.length,
      );
      for (let index = 0; index < rows.length; index += 1) {
        const { error: writeError } = await supabase.rpc("write_embedding_v2", {
          p_table: table,
          p_id: rows[index].id,
          p_embedding: vectors[index],
          p_model: TARGET_TAG,
        });
        if (writeError) {
          throw new Error(`${table} write failed: ${writeError.message}`);
        }
      }
      written += rows.length;
      console.error(`${table}: ${written} backfilled`);
    }
    counts[table] = written;
  }
  console.log(
    JSON.stringify({ status: "complete", model: TARGET_TAG, counts }),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
