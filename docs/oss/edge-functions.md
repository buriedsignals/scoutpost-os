# Edge Functions Reference

Supabase Edge Functions replace the AWS Lambda functions used in the SaaS deployment.
They run on Deno (TypeScript) inside the Supabase edge runtime. Both functions are thin
routing wrappers — all business logic stays in the FastAPI backend.

Source files: `supabase/functions/`

### Docker Self-Hosted

For Docker deployments, edge functions run inside `supabase/edge-runtime:v1.67.4`.
The Kong API gateway (`deploy/docker/kong.yml`) routes `/functions/v1/*` to the
edge-runtime container. The main entry point (`supabase/functions/main/index.ts`)
provides a health check at `/`; individual functions (`execute-scout`, `manage-schedule`)
are auto-discovered by the edge-runtime from their directory names.

```yaml
# docker-compose.yml
edge-functions:
  image: supabase/edge-runtime:v1.67.4
  command: start --main-service /home/deno/functions/main
  volumes:
    - ../../supabase/functions:/home/deno/functions
```

---

## Lambda → Edge Function Mapping

| AWS Lambda | Edge Function | Notes |
|-----------|---------------|-------|
| `scraper-lambda` | `execute-scout` | Routes execution by scout type to FastAPI |
| `create-eventbridge-schedule` | `manage-schedule` (action: `create`) | Creates pg_cron job + scout record |
| `delete-schedule` | `manage-schedule` (action: `delete`) | Deletes pg_cron job + scout record |
| N/A | `manage-schedule` (action: `update`) | Updates cron expression or scout config |
| `return-scraper-results` | Not needed | FastAPI queries Postgres directly |
| `service-key-authorizer` | Not needed | Supabase Auth JWT validation is built-in |

5 Lambdas become 2 Edge Functions.

---

## execute-scout

**File:** `supabase/functions/execute-scout/index.ts`

Receives scout configuration from `pg_cron` (via `pg_net.http_post`) and routes to the
correct FastAPI execute endpoint based on scout type.

### Routing

```
scout.type = 'web'    → POST /api/scouts/execute
scout.type = 'beat'   → POST /api/pulse/execute   # historical FastAPI route name
scout.type = 'social' → POST /api/social/execute
scout.type = 'civic'  → POST /api/civic/execute
```

### Auth Pattern

The function verifies the request using a direct token comparison against the
`INTERNAL_SERVICE_KEY` environment variable. The caller (pg_net inside pg_cron) must
include `X-Service-Key: <internal_service_key>` in the request headers.

```typescript
const authHeader = req.headers.get("Authorization") ?? "";
const expectedToken = `Bearer ${supabaseServiceKey}`;
if (authHeader !== expectedToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
}
```

Importantly, this uses exact string comparison (`!==`), not a substring check, to prevent
prefix-matching attacks.

### Forwarding to FastAPI

Requests are forwarded to `BACKEND_URL` (defaults to `http://backend:8000` for Docker
Compose) with the `X-Service-Key` header that FastAPI's internal auth middleware expects:

```typescript
const response = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "X-Service-Key": SERVICE_KEY,
    },
    body: JSON.stringify(body),
});
```

The body passes through unchanged — it contains `scout_id`, `user_id`, `scout_type`,
`scraper_name`, and any type-specific fields the FastAPI endpoint expects.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BACKEND_URL` | FastAPI base URL (default: `http://backend:8000`) |
| `INTERNAL_SERVICE_KEY` | Forwarded to FastAPI as `X-Service-Key` |
| `SUPABASE_SERVICE_ROLE_KEY` | Used to verify incoming requests from pg_cron |

---

## manage-schedule

**File:** `supabase/functions/manage-schedule/index.ts`

Handles schedule lifecycle (create, delete, update) by operating on both the `scouts`
table and `pg_cron` jobs atomically. Called by the FastAPI backend when a user creates
or deletes a scout via the UI.

### Actions

**`create`** — Creates a scout record in the database, then creates a `pg_cron` job that
will call `execute-scout` on the configured schedule. If the pg_cron job fails to create,
the scout record is deleted (rollback).

```typescript
// 1. Insert scout record
const { data: scout } = await supabase
    .from("scouts")
    .insert({ user_id, name: scout_name, type: scout_type, schedule_cron: cron_expression, ...scout_config })
    .select().single();

// 2. Create pg_cron job via RPC wrapper
await supabase.rpc("schedule_cron_job", {
    job_name: schedule_name,
    cron_expr: cron_expression,
    command: cronCommand,
});
```

**`delete`** — Deletes the pg_cron job first, then the scout record. The scout record's
`ON DELETE CASCADE` constraint automatically deletes all related records (runs, executions,
units, etc.). If cron deletion fails, deletion of the scout record continues anyway to
avoid orphaned records.

**`update`** — Updates the scout record. If a new `cron_expression` is provided, the
existing pg_cron job is unscheduled and a new one is created.

### pg_cron Command Format

The `buildCronCommand()` helper constructs the SQL command string that `pg_cron` will
execute on each firing:

```typescript
function buildCronCommand(scoutId: string, userId: string, scoutType: string, scoutName: string): string {
    const body = JSON.stringify({ scout_id: scoutId, user_id: userId, scout_type: scoutType, scraper_name: scoutName });
    const headers = JSON.stringify({
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
    });
    return `SELECT net.http_post(
        url := '${SUPABASE_URL}/functions/v1/execute-scout',
        headers := '${headers}'::jsonb,
        body := '${body}'::jsonb,
        timeout_milliseconds := 60000
    )`;
}
```

### RPC Wrappers for pg_cron

Direct SQL execution via the Supabase JS client does not support calling `cron.schedule()`
with parameterized arguments. Instead, `manage-schedule` uses RPC wrappers defined in the
database:

```sql
-- supabase/migrations (or managed separately)
CREATE OR REPLACE FUNCTION schedule_cron_job(job_name text, cron_expr text, command text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM cron.schedule(job_name, cron_expr, command);
END;
$$;

CREATE OR REPLACE FUNCTION unschedule_cron_job(job_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM cron.unschedule(job_name);
END;
$$;
```

These run with `SECURITY DEFINER` so they execute as the function owner (superuser),
which has permission to manage pg_cron jobs.

### Auth Pattern

Same as `execute-scout`: exact string comparison against `SUPABASE_SERVICE_ROLE_KEY`.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL (for constructing execute-scout URL) |
| `SUPABASE_SERVICE_ROLE_KEY` | Used for auth verification + Supabase client |
| `INTERNAL_SERVICE_KEY` | Passed through to Edge Functions that call FastAPI |

---

## Full Scheduling Flow

```
User creates scout in UI
  └── FastAPI POST /api/scrapers/monitoring
          └── SupabaseScheduler.create_schedule()
                  └── asyncpg: SELECT cron.schedule(name, cron, sql_command)
                          └── pg_cron registers job

On schedule:
  pg_cron fires
    └── pg_net.http_post(supabase_url/functions/v1/execute-scout, body={...})
            └── execute-scout Edge Function
                    └── Verifies X-Service-Key: <internal_service_key>
                    └── Routes by scout_type
                    └── fetch(backend/api/{type}/execute, X-Service-Key: <service_key>)
                            └── FastAPI execute endpoint
                                    └── Scout business logic
                                    └── Store results via Supabase adapters
                                    └── Send notification email (Resend)
```

---

## Deployment

Deploy both functions using the Supabase CLI:

```bash
supabase functions deploy execute-scout
supabase functions deploy manage-schedule
```

Set required secrets:

```bash
supabase secrets set BACKEND_URL=https://your-api.onrender.com
supabase secrets set INTERNAL_SERVICE_KEY=your-service-key
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
supabase secrets set SUPABASE_URL=https://your-project.supabase.co
```

For local development with `supabase start`:

```bash
supabase functions serve execute-scout --env-file .env.local
supabase functions serve manage-schedule --env-file .env.local
```

---

## Relationship to SupabaseScheduler Adapter

The `SupabaseScheduler` adapter (`backend/app/adapters/supabase/scheduler.py`) creates
pg_cron jobs directly via asyncpg rather than calling `manage-schedule`. This avoids an
extra network hop for schedule CRUD operations that originate from FastAPI.

`manage-schedule` is called when the frontend needs to manage a schedule through a
serverless boundary (e.g., in a pure Supabase setup without a persistent FastAPI server).
In the Render-hosted deployment, FastAPI calls asyncpg directly.

Both paths produce the same pg_cron job — the difference is which code path creates it.
