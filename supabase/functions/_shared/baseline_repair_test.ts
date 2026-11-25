import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { repairMissingSocialBaseline } from "./baseline_repair.ts";

class FakeDb {
  snapshotResult: unknown = { data: null, error: null };
  updateResult: unknown = { error: null };
  updates: Array<
    {
      table: string;
      patch: Record<string, unknown>;
      filters: Record<string, unknown>;
    }
  > = [];

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }
}

class FakeQuery {
  private patch: Record<string, unknown> | null = null;
  private filters: Record<string, unknown> = {};

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

  maybeSingle(): Promise<unknown> {
    if (this.table === "post_snapshots") {
      return Promise.resolve(this.db.snapshotResult);
    }
    return Promise.resolve({ data: null, error: null });
  }
}

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
  db.snapshotResult = { data: null, error: { message: "read failed" } };

  await assertRejects(
    () => repairMissingSocialBaseline(db, "scout-2"),
    Error,
    "read failed",
  );
});
