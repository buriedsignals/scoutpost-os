/**
 * Read-only, single-account Civic historical-data inventory.
 *
 * SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   deno run --allow-env --allow-net scripts/civic-repair-inventory.ts --user-id UUID
 *
 * Reads complete account cohorts, but prints only counts and bounded IDs.
 * This is a diagnostic snapshot, never an approved repair manifest.
 */
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";

const MAX_IDS = 500;
const MAX_ROWS = 100_000;
const CALENDAR_LIKE =
  /\b(calendar|schedule|session|sessions|meeting|meetings|termine|sitzung|agenda)\b/i;
type PromiseRow = {
  id: string;
  scout_id: string | null;
  unit_id: string | null;
  status: string | null;
  meeting_date: string | null;
  due_date: string | null;
  date_confidence: string | null;
  due_notified_at: string | null;
  source_url: string | null;
  source_title: string | null;
};
type UnitRow = {
  id: string;
  scout_type: string | null;
  type: string;
  deleted_at: string | null;
};

export function parseUserId(args: string[]): string {
  if (
    args.length !== 2 || args[0] !== "--user-id" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args[1],
    )
  ) {
    throw new Error(
      "Usage: civic-repair-inventory.ts --user-id UUID (read-only)",
    );
  }
  return args[1];
}

// Count checks catch truncation and observable concurrent changes. These reads
// are not a transaction: exact-target provenance must be rechecked before repair.
async function accountRows<T extends { id: string }>(
  svc: SupabaseClient,
  userId: string,
  table: string,
  columns: string,
): Promise<T[]> {
  const rows: T[] = [];
  let expectedCount: number | undefined;
  do {
    const { data, count, error } = await svc.from(table)
      .select(columns, { count: "exact" }).eq("user_id", userId)
      .order("id", { ascending: true }).range(
        rows.length,
        rows.length + MAX_IDS - 1,
      );
    if (error) throw new Error(`${table}: ${error.message}`);
    if (count === null || count > MAX_ROWS) {
      throw new Error(
        `${table}: exact count unavailable or account exceeds ${MAX_ROWS} rows; use a scoped SQL inventory`,
      );
    }
    if (expectedCount !== undefined && expectedCount !== count) {
      throw new Error(
        `${table}: account changed during inventory; retry before drawing conclusions`,
      );
    }
    expectedCount = count;
    const page = (data ?? []) as unknown as T[];
    if (page.length === 0 && rows.length < count) {
      throw new Error(
        `${table}: incomplete results; refusing absent-link classification`,
      );
    }
    rows.push(...page);
  } while (rows.length < expectedCount);
  if (
    rows.length !== expectedCount ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  ) {
    throw new Error(
      `${table}: inconsistent pagination; retry before drawing conclusions`,
    );
  }
  return rows;
}

function cohort(rows: { id: string }[]) {
  return {
    count: rows.length,
    ids: rows.slice(0, MAX_IDS).map((row) => row.id),
    ids_truncated: rows.length > MAX_IDS,
  };
}

export async function collectInventory(
  svc: SupabaseClient,
  userId: string,
  now = new Date(),
) {
  parseUserId(["--user-id", userId]);
  // Do not scope promises through current scouts: deleted/unlinked scouts are
  // precisely the legacy cohort this inventory must retain.
  const [scouts, promises, units, alerts] = await Promise.all([
    accountRows<{ id: string; type: string }>(
      svc,
      userId,
      "scouts",
      "id,type",
    ),
    accountRows<PromiseRow>(
      svc,
      userId,
      "promises",
      "id,scout_id,unit_id,status,meeting_date,due_date,date_confidence,due_notified_at,source_url,source_title",
    ),
    accountRows<UnitRow>(
      svc,
      userId,
      "information_units",
      "id,scout_type,type,deleted_at",
    ),
    accountRows<{ id: string; unit_id: string }>(
      svc,
      userId,
      "civic_run_alert_items",
      "id,unit_id",
    ),
  ]);
  const civicScoutIds = new Set(
    scouts.filter((row) => row.type === "civic").map((row) => row.id),
  );
  const unitsById = new Map(units.map((row) => [row.id, row]));
  const trackerUnitIds = new Set(
    promises.flatMap((row) => row.unit_id ? [row.unit_id] : []),
  );
  const calendarRows = promises.filter((row) =>
    CALENDAR_LIKE.test(`${row.source_url ?? ""} ${row.source_title ?? ""}`)
  );
  const calendarUnitIds = new Set(
    calendarRows.flatMap((row) => row.unit_id ? [row.unit_id] : []),
  );
  const linkedRows = promises.filter((row) => row.unit_id !== null);
  const statusCounts: Record<string, number> = {};
  for (const row of promises) {
    const status = row.status ?? "null";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  return {
    schema_version: 2,
    generated_at: now.toISOString(),
    user_id: userId,
    read_only: true,
    id_cap: MAX_IDS,
    scope:
      "all account promises, including null Scout links; all account units including deleted and other Scout types",
    consistency:
      "complete paginated reads, not a transactional snapshot; revalidate exact targets before repair",
    civic_scouts: civicScoutIds.size,
    promises_examined: promises.length,
    units_examined: units.length,
    promises_null_scout_id: cohort(
      promises.filter((row) => row.scout_id === null),
    ),
    promises_null_scout_and_unit: cohort(
      promises.filter((row) => row.scout_id === null && row.unit_id === null),
    ),
    promises_without_current_civic_scout: cohort(
      promises.filter((row) =>
        row.scout_id !== null && !civicScoutIds.has(row.scout_id)
      ),
    ),
    promises_null_unit_id: cohort(
      promises.filter((row) => row.unit_id === null),
    ),
    promises_null_due_date: cohort(
      promises.filter((row) => row.due_date === null),
    ),
    promises_null_date_confidence: cohort(
      promises.filter((row) => row.date_confidence === null),
    ),
    promises_meeting_date_equals_due_date: cohort(
      promises.filter((row) =>
        row.meeting_date !== null && row.meeting_date === row.due_date
      ),
    ),
    civic_promise_units_without_tracker: cohort(
      units.filter((row) =>
        row.scout_type === "civic" && row.type === "promise" &&
        row.deleted_at === null && !trackerUnitIds.has(row.id)
      ),
    ),
    promise_trackers_without_owned_unit: {
      ...cohort(linkedRows.filter((row) => !unitsById.has(row.unit_id!))),
      interpretation:
        "No matching unit in this account; does not prove global absence, deletion history, or permission to recreate.",
    },
    promise_trackers_linked_to_deleted_unit: cohort(
      linkedRows.filter((row) =>
        unitsById.get(row.unit_id!)?.deleted_at != null
      ),
    ),
    promise_trackers_linked_to_non_civic_promise_unit: cohort(
      linkedRows.filter((row) => {
        const unit = unitsById.get(row.unit_id!);
        return unit !== undefined &&
          (unit.scout_type !== "civic" || unit.type !== "promise");
      }),
    ),
    likely_calendar_or_session_sources: {
      ...cohort(calendarRows),
      indicator_only: true,
    },
    status_counts: { counts: statusCounts, examined: promises.length },
    overdue_without_due_reminder_marker: cohort(
      promises.filter((row) =>
        row.due_date !== null &&
        row.due_date < now.toISOString().slice(0, 10) &&
        row.due_notified_at === null
      ),
    ),
    alerts_for_likely_calendar_rows: {
      ...cohort(alerts.filter((row) => calendarUnitIds.has(row.unit_id))),
      indicator_only: true,
    },
    initial_preview_seeded_rows: {
      state: "not_distinguishable_from_legacy_persisted_schema",
      action:
        "Do not infer this cohort; use retained run/queue provenance when available.",
    },
    repair: {
      state: "not_proposed",
      action:
        "Null links and source keywords do not establish provenance. Review exact IDs, source passages, ownership, deletion history, canonical matches, and lifecycle fields before proposing any repair. Preserve deleted units and existing tracker status/dates. No alerts or writes are performed.",
    },
  };
}

if (import.meta.main) {
  const userId = parseUserId(Deno.args);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  const svc = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  console.log(JSON.stringify(await collectInventory(svc, userId), null, 2));
}
