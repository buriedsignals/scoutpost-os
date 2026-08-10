/**
 * Read-only Civic historical-data inventory.
 *
 * Run only with an operator service key:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     deno run --allow-env --allow-net scripts/civic-repair-inventory.ts
 *
 * It intentionally prints only counts and IDs—never promise/source text.
 * Review this artifact before constructing any exact-target repair batch.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const svc = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const MAX_IDS = 500;
const CALENDAR_LIKE =
  /\b(calendar|schedule|session|sessions|meeting|meetings|termine|sitzung|agenda)\b/i;
type TrackerRow = { id: string; unit_id: string | null };
type DatedPromiseRow = { id: string; meeting_date: string; due_date: string };
type CivicPromiseRow = {
  id: string;
  unit_id: string | null;
  status: string | null;
  due_date: string | null;
  due_notified_at: string | null;
  source_url: string | null;
  source_title: string | null;
};

async function ids(
  table: string,
  configure: (query: any) => any,
): Promise<{ count: number; ids: string[] }> {
  const query = configure(svc.from(table)).select("id", { count: "exact" })
    .limit(MAX_IDS);
  const { data, count, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return {
    count: count ?? 0,
    ids: (data ?? []).map((row: { id: unknown }) => String(row.id)),
  };
}

const { data: civicScouts, error: civicScoutError } = await svc.from("scouts")
  .select("id").eq("scout_type", "civic").limit(MAX_IDS);
if (civicScoutError) throw new Error(civicScoutError.message);
const civicScoutIds = (civicScouts ?? []).map((row) => String(row.id));
if (civicScoutIds.length === 0) {
  console.log(
    JSON.stringify({ generated_at: new Date().toISOString(), civic_scouts: 0 }),
  );
  Deno.exit(0);
}

const civicPromises = (q: any) => q.in("scout_id", civicScoutIds);
const [nullUnit, nullDue, nullConfidence, units, civicPromiseRows] =
  await Promise.all([
    ids("promises", (q) => civicPromises(q).is("unit_id", null)),
    ids("promises", (q) => civicPromises(q).is("due_date", null)),
    ids("promises", (q) => civicPromises(q).is("date_confidence", null)),
    ids(
      "information_units",
      (q) => q.eq("scout_type", "civic").eq("type", "promise"),
    ),
    civicPromises(svc.from("promises")).select(
      "id,unit_id,status,due_date,due_notified_at,source_url,source_title",
      { count: "exact" },
    ).limit(MAX_IDS),
  ]);
if (civicPromiseRows.error) throw new Error(civicPromiseRows.error.message);

const { data: trackerData, error: trackerError } = await civicPromises(
  svc.from("promises"),
)
  .select("id,unit_id").not("unit_id", "is", null).limit(MAX_IDS);
if (trackerError) throw new Error(trackerError.message);
const trackerRows = (trackerData ?? []) as TrackerRow[];

const { data: datedData, error: datedError } = await civicPromises(
  svc.from("promises"),
)
  .select("id,meeting_date,due_date").not("meeting_date", "is", null)
  .not("due_date", "is", null).limit(MAX_IDS);
if (datedError) throw new Error(datedError.message);
const datedRows = (datedData ?? []) as DatedPromiseRow[];
const sameMeetingDue = datedRows.filter((row) =>
  row.meeting_date === row.due_date
).map((row) => String(row.id));

const trackerUnits = new Set(
  trackerRows.map((row) => String(row.unit_id)),
);
const civicUnitIds = new Set(units.ids);
const unitsWithoutTracker = units.ids.filter((id) => !trackerUnits.has(id));
const trackersWithoutUnit = trackerRows.filter((row) =>
  !civicUnitIds.has(String(row.unit_id))
).map((row) => String(row.id));
const promiseSample = (civicPromiseRows.data ?? []) as CivicPromiseRow[];
const calendarLike = promiseSample.filter((row) =>
  CALENDAR_LIKE.test(`${row.source_url ?? ""} ${row.source_title ?? ""}`)
).map((row) => String(row.id));
const missedDue = promiseSample.filter((row) =>
  row.due_date !== null &&
  row.due_date < new Date().toISOString().slice(0, 10) &&
  row.due_notified_at === null
).map((row) => String(row.id));
const statusCounts = Object.fromEntries(
  Object.entries(Object.groupBy(promiseSample, (row) => row.status ?? "null"))
    .map(([status, rows]) => [status, rows?.length ?? 0]),
);
const calendarUnitIds = new Set(
  promiseSample.filter((row) =>
    CALENDAR_LIKE.test(`${row.source_url ?? ""} ${row.source_title ?? ""}`)
  )
    .map((row) => row.unit_id).filter((id): id is string =>
      typeof id === "string"
    ),
);
const alertRows = calendarUnitIds.size === 0
  ? []
  : (await svc.from("civic_run_alert_items")
    .select("id").in("unit_id", [...calendarUnitIds]).limit(MAX_IDS)).data ??
    [];

console.log(JSON.stringify(
  {
    generated_at: new Date().toISOString(),
    id_cap: MAX_IDS,
    civic_scouts_sampled: civicScoutIds.length,
    promises_null_unit_id: nullUnit,
    promises_null_due_date: nullDue,
    promises_null_date_confidence: nullConfidence,
    promises_meeting_date_equals_due_date: {
      count: sameMeetingDue.length,
      ids: sameMeetingDue,
      sampled_from: datedRows?.length ?? 0,
    },
    civic_promise_units_without_tracker: {
      count: unitsWithoutTracker.length,
      ids: unitsWithoutTracker,
      sampled_from: units.count,
    },
    promise_trackers_without_civic_unit: {
      count: trackersWithoutUnit.length,
      ids: trackersWithoutUnit,
      sampled_from: trackerRows?.length ?? 0,
    },
    likely_calendar_or_session_sources: {
      count: calendarLike.length,
      ids: calendarLike,
      sampled_from: promiseSample.length,
      indicator_only: true,
    },
    status_counts: {
      counts: statusCounts,
      sampled_from: promiseSample.length,
    },
    overdue_without_due_reminder_marker: {
      count: missedDue.length,
      ids: missedDue,
      sampled_from: promiseSample.length,
    },
    alerts_for_likely_calendar_rows: {
      count: alertRows.length,
      ids: alertRows.map((row) => String(row.id)),
      sampled_from_candidate_units: calendarUnitIds.size,
      indicator_only: true,
    },
    initial_preview_seeded_rows: {
      state: "not_distinguishable_from_legacy_persisted_schema",
      action:
        "Do not infer this cohort; use retained run/queue provenance when available.",
    },
  },
  null,
  2,
));
