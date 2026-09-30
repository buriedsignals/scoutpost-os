/** Service-only scout scheduling. All jobs use the shared schedule_scout RPC,
 * including per-scout timezone dispatch and deterministic spreading. */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3";
import { requireServiceKey } from "../_shared/auth.ts";
import { scheduleTimezoneError } from "../_shared/schedule_policy.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RequestSchema = z.object({
  action: z.enum(["create", "update", "delete"]),
  scout_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  scout_name: z.string().min(1).optional(),
  scout_type: z.string().min(1).optional(),
  cron_expression: z.string().min(1).max(200).nullable().optional(),
  schedule_timezone: z.string().min(1).max(100).optional(),
  scout_config: z.record(z.unknown()).optional(),
});

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    requireServiceKey(req);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!SUPABASE_SERVICE_KEY) {
    return Response.json({ error: "Server misconfigured: missing service key" }, { status: 500 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  const body = parsed.data;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  try {
    if (body.action === "delete") {
      if (!body.scout_id) {
        return Response.json({ error: "scout_id is required" }, { status: 400 });
      }
      const { error: unscheduleError } = await supabase.rpc("unschedule_scout", {
        p_scout_id: body.scout_id,
      });
      if (unscheduleError) throw new Error(unscheduleError.message);
      const { error } = await supabase.from("scouts").delete().eq("id", body.scout_id);
      if (error) throw new Error(error.message);
      return Response.json({ deleted: `scout-${body.scout_id}` });
    }

    let current: Record<string, unknown> = {};
    if (body.action === "update") {
      if (!body.scout_id) {
        return Response.json({ error: "scout_id is required" }, { status: 400 });
      }
      const { data, error } = await supabase.from("scouts").select("*")
        .eq("id", body.scout_id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return Response.json({ error: "Scout not found" }, { status: 404 });
      current = data;
    } else if (!body.user_id || !body.scout_name || !body.scout_type) {
      return Response.json({ error: "user_id, scout_name, and scout_type are required" }, { status: 400 });
    }

    const update = { ...body.scout_config };
    // Scheduling identity cannot be overwritten through the overflow config.
    delete update.id;
    delete update.user_id;
    delete update.schedule_last_dispatched_at;
    const scheduleCron = body.cron_expression !== undefined
      ? body.cron_expression
      : update.schedule_cron !== undefined
      ? update.schedule_cron
      : current.schedule_cron ?? null;
    const scheduleTimezone = body.schedule_timezone !== undefined
      ? body.schedule_timezone
      : update.schedule_timezone !== undefined
      ? update.schedule_timezone
      : current.schedule_timezone ?? "UTC";
    if ((scheduleCron !== null && typeof scheduleCron !== "string") || typeof scheduleTimezone !== "string") {
      return Response.json({ error: "schedule_cron and schedule_timezone must be strings" }, { status: 400 });
    }
    const timezoneError = scheduleTimezoneError(scheduleCron, scheduleTimezone);
    if (timezoneError) return Response.json({ error: timezoneError }, { status: 400 });
    // PostgreSQL's tzdata is authoritative; validate before any row/job mutation.
    const { error: validationError } = await supabase.rpc("validate_scout_schedule", {
      p_cron_expr: scheduleCron, p_timezone: scheduleTimezone,
    });
    if (validationError) return Response.json({ error: validationError.message }, { status: 400 });
    update.schedule_cron = scheduleCron;
    update.schedule_timezone = scheduleTimezone;
    update.is_active = update.is_active ?? current.is_active ?? Boolean(scheduleCron);
    if (typeof update.is_active !== "boolean") {
      return Response.json({ error: "is_active must be a boolean" }, { status: 400 });
    }
    if (update.is_active && !scheduleCron) {
      return Response.json({ error: "active scouts require a schedule" }, { status: 400 });
    }
    const result = body.action === "create"
      ? await supabase.from("scouts").insert({
        ...update, user_id: body.user_id, name: body.scout_name, type: body.scout_type,
      }).select("*").single()
      : await supabase.from("scouts").update(update).eq("id", body.scout_id!).select("*").single();
    if (result.error) throw new Error(result.error.message);
    const scout = result.data;
    const { error: scheduleError } = scout.is_active && scheduleCron
      ? await supabase.rpc("schedule_scout", { p_scout_id: scout.id, p_cron_expr: scheduleCron })
      : await supabase.rpc("unschedule_scout", { p_scout_id: scout.id });
    if (scheduleError) {
      const rollback = body.action === "create"
        ? await supabase.from("scouts").delete().eq("id", scout.id)
        : await supabase.from("scouts").update(
          Object.fromEntries(Object.keys(update).map((key) => [key, current[key] ?? null])),
        ).eq("id", scout.id);
      if (rollback.error) throw new Error(`Schedule failed: ${scheduleError.message}; rollback failed: ${rollback.error.message}`);
      throw new Error(scheduleError.message);
    }
    return Response.json({
      scout_id: scout.id,
      schedule_name: `scout-${scout.id}`,
      schedule_timezone: scout.schedule_timezone,
      ...(body.action === "update" ? { updated: `scout-${scout.id}` } : {}),
    });
  } catch (error) {
    console.error("Error in manage-schedule:", error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});
