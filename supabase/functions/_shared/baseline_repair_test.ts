import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  repairMissingBeatBaseline,
  repairMissingSocialBaseline,
} from "./baseline_repair.ts";

class FakeDb {
  scoutRunResult: unknown = { data: null, error: null };
  snapshotResult: unknown = { data: null, error: null };
  updateResult: unknown = { error: null };
  updates: Array<
    {
      table: string;
      patch: Record<string, unknown>;
      filters: Record<string, unknown>;
    }
  > = [];
  reads: Array<
    {
      table: string;
      filters: Record<string, unknown>;
      order: Array<[string, unknown]>;
    }
  > = [];

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }
}

class FakeQuery {
  private patch: Record<string, unknown> | null = null;
  private filters: Record<string, unknown> = {};
  private ordering: Array<[string, unknown]> = [];

  constructor(private db: FakeDb, private table: string) {}

  select(_columns: string): this {
    return this;
  }

  update(patch: Record<string, unknown>): this {
    this.patch = patch;
    return this;
  }

  eq(column: string, value: unknown): this | Promise<unknown> {
    this.filters[column] = value;
    if (this.patch) {
      this.db.updates.push({
        table: this.table,
        patch: this.patch,
        filters: { ...this.filters },
      });
      return Promise.resolve(this.db.updateResult);
    }
    return this;
  }

  order(column: string, options: unknown): this {
    this.ordering.push([column, options]);
    return this;
  }

  limit(_count: number): this {
    return this;
  }

  maybeSingle(): Promise<unknown> {
    this.db.reads.push({
      table: this.table,
      filters: { ...this.filters },
      order: this.ordering,
    });
    if (this.table === "scout_runs") {
      return Promise.resolve(this.db.scoutRunResult);
    }
    if (this.table === "post_snapshots") {
      return Promise.resolve(this.db.snapshotResult);
    }
    return Promise.resolve({ data: null, error: null });
  }
}

Deno.test("repairMissingBeatBaseline stamps from latest successful run", async () => {
  const db = new FakeDb();
  db.scoutRunResult = {
    data: {
      completed_at: "2026-04-27T11:13:30.616Z",
      started_at: "2026-04-27T11:12:39.647Z",
    },
    error: null,
  };

  const result = await repairMissingBeatBaseline(db, "scout-1");

  assertEquals(result, {
    repaired: true,
    repairedAt: "2026-04-27T11:13:30.616Z",
    source: "prior_success",
  });
  assertEquals(db.updates, [{
    table: "scouts",
    patch: { baseline_established_at: "2026-04-27T11:13:30.616Z" },
    filters: { id: "scout-1" },
  }]);
  assertEquals(db.reads, [{
    table: "scout_runs",
    filters: { scout_id: "scout-1", status: "success" },
    order: [["completed_at", { ascending: false, nullsFirst: false }]],
  }]);
});

Deno.test("repairMissingBeatBaseline leaves scout unchanged without prior success", async () => {
  const db = new FakeDb();

  const result = await repairMissingBeatBaseline(db, "scout-1");

  assertEquals(result, { repaired: false, source: "none" });
  assertEquals(db.updates, []);
});

Deno.test("repairMissingSocialBaseline stamps from post snapshot", async () => {
  const db = new FakeDb();
  db.snapshotResult = {
    data: { updated_at: "2026-05-01T08:45:26.056Z" },
    error: null,
  };

  const result = await repairMissingSocialBaseline(db, "scout-2");

  assertEquals(result, {
    repaired: true,
    repairedAt: "2026-05-01T08:45:26.056Z",
    source: "social_snapshot",
  });
  assertEquals(db.updates, [{
    table: "scouts",
    patch: { baseline_established_at: "2026-05-01T08:45:26.056Z" },
    filters: { id: "scout-2" },
  }]);
});

Deno.test("repairMissingSocialBaseline leaves scout unchanged without snapshot", async () => {
  const db = new FakeDb();

  const result = await repairMissingSocialBaseline(db, "scout-2");

  assertEquals(result, { repaired: false, source: "none" });
  assertEquals(db.updates, []);
});

Deno.test("repair helpers surface Supabase errors", async () => {
  const db = new FakeDb();
  db.scoutRunResult = { data: null, error: { message: "read failed" } };

  await assertRejects(
    () => repairMissingBeatBaseline(db, "scout-1"),
    Error,
    "read failed",
  );
});
