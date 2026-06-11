/**
 * manage-schedule Edge Function
 *
 * Replaces create-eventbridge-schedule and delete-schedule Lambdas.
 * Creates/deletes pg_cron jobs and manages scout records via the FastAPI backend.
 *
 * Actions:
 *   create -> Create scout record + pg_cron schedule
 *   delete -> Delete scout record + pg_cron schedule
 *   update -> Update scout record + pg_cron schedule
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireServiceKey } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Build the pg_cron command that fires pg_net.http_post to the execute-scout
 * Edge Function. It reads project_url and internal_service_key from Vault at
 * execution time so the generated cron job never embeds service credentials.
 */
function buildCronCommand(
  scoutId: string,
  userId: string,
  scoutType: string,
  scoutName: string,
): string {
  // The body is a JSON literal embedded in the SQL command string.
  // This is safe because the RPC wrapper passes it as a parameter to cron.schedule().
  const body = JSON.stringify({
    scout_id: scoutId,
    user_id: userId,
    scout_type: scoutType,
    scraper_name: scoutName,
  });
  return `
SELECT net.http_post(
  url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/execute-scout',
  headers := jsonb_build_object(
    'X-Service-Key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_service_key'),
    'Content-Type', 'application/json'
  ),
  body := ${sqlLiteral(body)}::jsonb,
  timeout_milliseconds := 60000
)
WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url')
  AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key')`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    try {
      requireServiceKey(req);
    } catch {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!SUPABASE_SERVICE_KEY) {
      return new Response(
        JSON.stringify({ error: "Server misconfigured: missing service key" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();
    const action: string = body.action ?? "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });

    switch (action) {
      case "create": {
        const {
          user_id,
          scout_name,
          scout_type,
          schedule_name,
          cron_expression,
          scout_config,
        } = body;

        // 1. Create scout record in the database
        const { data: scout, error: scoutError } = await supabase
          .from("scouts")
          .insert({
            user_id,
            name: scout_name,
            type: scout_type,
            schedule_cron: cron_expression,
            is_active: true,
            ...scout_config,
          })
          .select()
          .single();

        if (scoutError) {
          console.error("Failed to create scout:", scoutError);
          return new Response(
            JSON.stringify({
              error: "Failed to create scout",
              detail: scoutError.message,
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        // 2. Create pg_cron job via RPC wrapper (avoids direct SQL injection)
        const cronCommand = buildCronCommand(
          scout.id,
          user_id,
          scout_type,
          scout_name,
        );

        const { error: cronError } = await supabase.rpc("schedule_cron_job", {
          job_name: schedule_name,
          cron_expr: cron_expression,
          command: cronCommand,
        });

        if (cronError) {
          console.error("Failed to create cron job:", cronError);
          // Clean up the scout record
          await supabase.from("scouts").delete().eq("id", scout.id);
          return new Response(
            JSON.stringify({
              error: "Failed to create schedule",
              detail: cronError.message,
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        console.log(`Created schedule: ${schedule_name} for scout ${scout.id}`);
        return new Response(
          JSON.stringify({ scout_id: scout.id, schedule_name }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      case "delete": {
        const { schedule_name: deleteName, scout_id } = body;

        // 1. Delete pg_cron job
        const { error: unscheduleError } = await supabase.rpc(
          "unschedule_cron_job",
          {
            job_name: deleteName,
          },
        );

        if (unscheduleError) {
          console.error("Failed to delete cron job:", unscheduleError);
          // Continue to delete scout record even if cron deletion fails
        }

        // 2. Delete scout record (CASCADE handles related records)
        if (scout_id) {
          const { error: deleteError } = await supabase
            .from("scouts")
            .delete()
            .eq("id", scout_id);

          if (deleteError) {
            console.error("Failed to delete scout:", deleteError);
          }
        }

        console.log(`Deleted schedule: ${deleteName}`);
        return new Response(
          JSON.stringify({ deleted: deleteName }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      case "update": {
        const {
          schedule_name: updateName,
          scout_id: updateScoutId,
          cron_expression: newCron,
          scout_config: updateConfig,
        } = body;

        // Update scout record
        if (updateScoutId && updateConfig) {
          const { error: updateError } = await supabase
            .from("scouts")
            .update(updateConfig)
            .eq("id", updateScoutId);

          if (updateError) {
            console.error("Failed to update scout:", updateError);
            // Do not reschedule cron against a scout row that failed to
            // update — that leaves cron and the DB row inconsistent.
            return new Response(
              JSON.stringify({
                error: "Failed to update scout",
                detail: updateError.message,
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        // If cron changed, delete and recreate the cron job via RPC wrapper
        if (newCron && updateName) {
          await supabase.rpc("unschedule_cron_job", { job_name: updateName });

          const cronCommand = buildCronCommand(
            updateScoutId,
            body.user_id,
            body.scout_type,
            body.scout_name ?? "",
          );

          const { error: rescheduleError } = await supabase.rpc(
            "schedule_cron_job",
            {
              job_name: updateName,
              cron_expr: newCron,
              command: cronCommand,
            },
          );

          if (rescheduleError) {
            console.error("Failed to reschedule:", rescheduleError);
          }
        }

        console.log(`Updated schedule: ${updateName}`);
        return new Response(
          JSON.stringify({ updated: updateName }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
    }
  } catch (error) {
    console.error("Error in manage-schedule:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        detail: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
