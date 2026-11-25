type DbClient = {
  from: (table: string) => unknown;
};

type MaybeSingleResult<T> = {
  data: T | null;
  error: { message: string } | null;
};

type UpdateResult = {
  error: { message: string } | null;
};

type SnapshotRow = {
  updated_at: string | null;
};

export type BaselineRepairResult =
  | {
    repaired: true;
    repairedAt: string;
    source: "social_snapshot";
  }
  | { repaired: false; source: "none" };

export async function repairMissingSocialBaseline(
  db: DbClient,
  scoutId: string,
): Promise<BaselineRepairResult> {
  const { data, error } = await (db.from("post_snapshots") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        maybeSingle: () => Promise<MaybeSingleResult<SnapshotRow>>;
      };
    };
  })
    .select("updated_at")
    .eq("scout_id", scoutId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return { repaired: false, source: "none" };

  const repairedAt = data.updated_at ?? new Date().toISOString();
  await stampBaseline(db, scoutId, repairedAt);
  return { repaired: true, repairedAt, source: "social_snapshot" };
}

async function stampBaseline(
  db: DbClient,
  scoutId: string,
  repairedAt: string,
): Promise<void> {
  const { error } = await (db.from("scouts") as {
    update: (patch: Record<string, unknown>) => {
      eq: (column: string, value: unknown) => Promise<UpdateResult>;
    };
  })
    .update({ baseline_established_at: repairedAt })
    .eq("id", scoutId);

  if (error) throw new Error(error.message);
}
