# Supabase Schema Reference

PostgreSQL schema for the self-hosted (OSS) version of coJournalist. Replaces the
DynamoDB single-table design used by the SaaS deployment.

Migration files live in `supabase/migrations/`. They run in order:

| File | Contents |
|------|----------|
| `00001_extensions.sql` | `vector`, `pg_cron`, `pg_net` extensions |
| `00002_tables.sql` | All application tables |
| `00003_indexes.sql` | Lookup, TTL, and HNSW vector indexes |
| `00004_rls.sql` | Row Level Security policies |
| `00005_triggers.sql` | `updated_at` auto-update triggers |
| `00006_cron_cleanup.sql` | TTL cleanup functions + pg_cron schedules |

---

## DynamoDB Record Type Mapping

| DynamoDB record | PostgreSQL table | Notes |
|----------------|-----------------|-------|
| `SCRAPER#` | `scouts` | Scout definitions |
| `TIME#` | `scout_runs` | Per-run execution history |
| `EXEC#` | `execution_records` | Summary cards + embedding dedup |
| `POSTS#` | `post_snapshots` | Social scout baselines |
| `SEEN#` | `seen_records` | URL deduplication for beat scouts |
| `PROMISE#` | `promises` | Civic scout extracted promises |
| `information-units` | `information_units` | Atomic facts with embeddings |
| `USER#` / `PROFILE` | `user_preferences` | User config (no billing columns) |

---

## Tables

### `scouts`

Stores scout definitions for all four scout types (`web`, `beat`, `social`, `civic`).
A single wide table with type-specific columns left null for inapplicable types.

```
id                    UUID PRIMARY KEY
user_id               UUID → auth.users(id)
name                  TEXT NOT NULL
type                  TEXT  -- 'web' | 'beat' | 'social' | 'civic'
criteria              TEXT  -- AI filter criteria (optional)
preferred_language    TEXT  -- default 'en'
regularity            TEXT  -- 'daily' | 'weekly' | 'monthly'
schedule_cron         TEXT  -- cron expression
schedule_timezone     TEXT  -- default 'UTC'
topic                 TEXT  -- organizational tag
url                   TEXT  -- web scouts only
provider              TEXT  -- 'firecrawl' | 'firecrawl_plain' (web only)
source_mode           TEXT  -- 'reliable' | 'niche' (beat only)
excluded_domains      TEXT[]
platform              TEXT  -- 'instagram' | 'x' | 'facebook' (social only)
profile_handle        TEXT  -- social only
monitor_mode          TEXT  -- 'summarize' | 'criteria' (social only; nullable for legacy summarize compatibility)
track_removals        BOOLEAN
root_domain           TEXT  -- civic only
tracked_urls          TEXT[]  -- civic only
processed_pdf_urls    TEXT[]  -- civic only
location              JSONB -- GeocodedLocation object (all geolocated types)
config                JSONB -- overflow for rare type-specific fields
is_active             BOOLEAN
consecutive_failures  INT
baseline_established_at TIMESTAMPTZ
created_at / updated_at TIMESTAMPTZ
```

Constraints:
- `UNIQUE(user_id, name)` — scout names are unique per user
- `CHECK (NOT is_active OR schedule_cron IS NOT NULL)` — active scouts must have a schedule

### `scout_runs`

One row per scheduled execution of a scout. Replaces `TIME#` records.

```
id                UUID PRIMARY KEY
scout_id          UUID → scouts(id) ON DELETE CASCADE
user_id           UUID → auth.users(id)
status            TEXT  -- 'running' | 'success' | 'error' | 'skipped'
scraper_status    BOOLEAN  -- scrape phase succeeded
criteria_status   BOOLEAN  -- AI filter phase succeeded
notification_sent BOOLEAN
articles_count    INT
error_message     TEXT  -- populated on error
started_at        TIMESTAMPTZ NOT NULL
completed_at      TIMESTAMPTZ
expires_at        TIMESTAMPTZ  -- NOW() + 90 days (TTL)
```

### `execution_records`

Summary cards shown in the scout history UI. Also used for execution-level deduplication:
before sending a notification, the system embeds the summary and checks cosine similarity
against recent execution embeddings. Replaces `EXEC#` records.

```
id            UUID PRIMARY KEY
scout_id      UUID → scouts(id) ON DELETE CASCADE
user_id       UUID → auth.users(id)
scout_type    TEXT
summary_text  TEXT NOT NULL  -- 1-sentence summary for display
embedding     vector(1536)   -- for cosine dedup (see Indexes)
embedding_model TEXT         -- version tag for the stored summary embedding
content_hash  TEXT           -- for web scout baseline dedup
is_duplicate  BOOLEAN
metadata      JSONB
completed_at  TIMESTAMPTZ NOT NULL
expires_at    TIMESTAMPTZ  -- NOW() + 90 days (TTL)
```

The `vector(1536)` dimension matches `gemini-embedding-2-preview` with MRL truncation.
If you use a different embedding model, update the dimension in `00002_tables.sql` and
the HNSW indexes in `00003_indexes.sql`.

### `post_snapshots`

Stores the last-seen list of posts for social scouts. On each run, the new post list is
diffed against this snapshot to detect new or removed posts. Replaces `POSTS#` records.

```
id          UUID PRIMARY KEY
scout_id    UUID → scouts(id) ON DELETE CASCADE  UNIQUE
user_id     UUID → auth.users(id)
platform    TEXT
handle      TEXT
post_count  INT
posts       JSONB NOT NULL DEFAULT '[]'  -- list of post objects
updated_at  TIMESTAMPTZ
```

One row per scout (enforced by `UNIQUE(scout_id)`). Each execution overwrites `posts`.

### `seen_records`

URL-level deduplication for Beat Scouts (type `beat`). A `signature` is a stable hash
of a URL. If the signature exists for a given `(scout_id, user_id)`, the article is
skipped. Replaces `SEEN#` records.

```
id         UUID PRIMARY KEY
scout_id   UUID → scouts(id) ON DELETE CASCADE
user_id    UUID → auth.users(id)
signature  TEXT NOT NULL
created_at TIMESTAMPTZ
expires_at TIMESTAMPTZ  -- NOW() + 90 days (TTL)
UNIQUE(scout_id, signature)
```

### `promises`

Civic Scout extracted promises from council meeting records. Replaces `PROMISE#` records.

```
id            UUID PRIMARY KEY
scout_id      UUID → scouts(id) ON DELETE CASCADE
user_id       UUID → auth.users(id)
promise_text  TEXT NOT NULL
context       TEXT
source_url    TEXT
source_title  TEXT
meeting_date  DATE
status        TEXT  -- 'new' | 'in_progress' | 'fulfilled' | 'broken' | 'notified'
created_at / updated_at TIMESTAMPTZ
```

### `information_units`

Atomic facts extracted from scout results and stored with vector embeddings. Used by the
Feed panel for semantic search and location/topic browsing. Replaces the
`information-units` table in DynamoDB.

```
id              UUID PRIMARY KEY
user_id         UUID → auth.users(id)
scout_id        UUID → scouts(id) ON DELETE CASCADE
scout_type      TEXT
article_id      UUID  -- groups units from the same article
statement       TEXT NOT NULL  -- the atomic fact
type            TEXT  -- 'fact' | 'event' | 'entity_update'
entities        TEXT[]
embedding       vector(1536)
source_url      TEXT
source_domain   TEXT
source_title    TEXT
event_date      DATE
country         TEXT
state           TEXT
city            TEXT
topic           TEXT
dataset_id      TEXT
used_in_article BOOLEAN DEFAULT FALSE
created_at      TIMESTAMPTZ
expires_at      TIMESTAMPTZ  -- NOW() + 90 days (TTL)
```

### `user_preferences`

User configuration. Replaces `USER#`/`PROFILE` records. Tier + active_org_id added by `00025_credits.sql` drive credit entitlements.

```
user_id                    UUID PRIMARY KEY → auth.users(id)
timezone                   TEXT DEFAULT 'UTC'
preferred_language         TEXT DEFAULT 'en'
notification_email         TEXT
default_location           JSONB
excluded_domains           TEXT[]
preferences                JSONB DEFAULT '{}'
onboarding_completed       BOOLEAN DEFAULT FALSE
onboarding_tour_completed  BOOLEAN DEFAULT FALSE
tier                       TEXT DEFAULT 'free'           -- added by 00025_credits.sql
active_org_id              UUID → orgs(id)                -- added by 00025_credits.sql
created_at / updated_at    TIMESTAMPTZ
```

---

## Indexes

### Lookup Indexes

```sql
-- Scout queries
CREATE INDEX idx_scouts_user   ON scouts(user_id);
CREATE INDEX idx_scouts_type   ON scouts(user_id, type);
CREATE INDEX idx_scouts_active ON scouts(user_id) WHERE is_active = TRUE;

-- Run history (time-ordered)
CREATE INDEX idx_runs_scout     ON scout_runs(scout_id, started_at DESC);
CREATE INDEX idx_runs_user_time ON scout_runs(user_id, started_at DESC);

-- Execution records
CREATE INDEX idx_exec_scout ON execution_records(scout_id, completed_at DESC);

-- Information units
CREATE INDEX idx_units_user     ON information_units(user_id);
CREATE INDEX idx_units_scout    ON information_units(scout_id, created_at DESC);
CREATE INDEX idx_units_location ON information_units(user_id, country, state, city);
CREATE INDEX idx_units_article  ON information_units(article_id);

-- Seen records
CREATE INDEX idx_seen_scout ON seen_records(scout_id);

-- Promises
CREATE INDEX idx_promises_scout ON promises(scout_id, created_at DESC);
CREATE INDEX idx_promises_user  ON promises(user_id);
```

### TTL Cleanup Indexes (Partial)

Partial indexes on `expires_at` make the nightly DELETE scans fast. Only rows with a
non-null `expires_at` are indexed.

```sql
CREATE INDEX idx_runs_expires  ON scout_runs(expires_at)          WHERE expires_at IS NOT NULL;
CREATE INDEX idx_exec_expires  ON execution_records(expires_at)   WHERE expires_at IS NOT NULL;
CREATE INDEX idx_units_expires ON information_units(expires_at)   WHERE expires_at IS NOT NULL;
CREATE INDEX idx_seen_expires  ON seen_records(expires_at)        WHERE expires_at IS NOT NULL;
```

### HNSW Vector Indexes

Used for cosine similarity search on embeddings. HNSW (Hierarchical Navigable Small
World) is the recommended index type for pgvector — it works at any data volume and
requires no calibration, unlike IVFFlat which requires `ANALYZE` after load.

```sql
CREATE INDEX idx_exec_embedding ON execution_records
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_unit_embedding ON information_units
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

The `m = 16, ef_construction = 64` parameters are conservative defaults that work for
newsroom-scale data (tens of thousands of rows). Increase `ef_construction` for better
recall at higher row counts.

---

## Row Level Security

RLS is enabled on every application table. All policies follow the same pattern: users
can only read and write their own rows.

```sql
ALTER TABLE scouts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE scout_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE seen_records      ENABLE ROW LEVEL SECURITY;
ALTER TABLE information_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE promises          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences  ENABLE ROW LEVEL SECURITY;

CREATE POLICY scouts_user ON scouts            FOR ALL USING (auth.uid() = user_id);
CREATE POLICY runs_user   ON scout_runs        FOR ALL USING (auth.uid() = user_id);
-- ... same pattern for all tables
```

The FastAPI backend connects with the **service role key**, which bypasses RLS
automatically. RLS policies are for direct PostgREST/Supabase client access (e.g., the
frontend or external tools). Cleanup functions use `SECURITY DEFINER` to bypass RLS.

---

## TTL Cleanup via pg_cron

Records with a 90-day TTL are purged by `SECURITY DEFINER` functions scheduled via
`pg_cron`. Batched deletes (10,000 rows max per run) avoid long-running locks.

```sql
-- Staggered to avoid lock contention
SELECT cron.schedule('cleanup-scout-runs',        '0 3 * * *',  'SELECT cleanup_scout_runs()');
SELECT cron.schedule('cleanup-execution-records', '5 3 * * *',  'SELECT cleanup_execution_records()');
SELECT cron.schedule('cleanup-information-units', '10 3 * * *', 'SELECT cleanup_information_units()');
SELECT cron.schedule('cleanup-seen-records',      '15 3 * * *', 'SELECT cleanup_seen_records()');
```

Each function follows this pattern:

```sql
CREATE OR REPLACE FUNCTION cleanup_scout_runs()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM scout_runs WHERE id IN (
        SELECT id FROM scout_runs WHERE expires_at < NOW() LIMIT 10000
    );
END;
$$;
```

---

## pg_cron + pg_net Scheduling Pattern

Scout schedules are stored as `pg_cron` jobs. When a cron job fires, it calls
`pg_net.http_post()` to trigger the `execute-scout` Edge Function, which routes to
the appropriate FastAPI endpoint.

```
pg_cron fires at schedule
    └── pg_net.http_post(supabase_url/functions/v1/execute-scout, body={scout_id, type, ...})
            └── execute-scout Edge Function
                    └── FastAPI /api/{type}/execute
                            └── Scout business logic + result storage
```

Schedule creation and deletion are handled by the `SupabaseScheduler` adapter
(`adapters/supabase/scheduler.py`), which executes the `cron.schedule()` / `cron.unschedule()`
SQL via asyncpg.

For details on the Edge Functions, see `docs/architecture/edge-functions.md`.

---

## Extensions Required

```sql
CREATE EXTENSION IF NOT EXISTS "vector";   -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS "pg_cron";  -- cron-based job scheduling
CREATE EXTENSION IF NOT EXISTS "pg_net";   -- HTTP from within PostgreSQL (needed by pg_cron → Edge Functions)
```

On managed Supabase (cloud), all three extensions are available and can be enabled via
the Supabase dashboard or the CLI. On a self-hosted PostgreSQL instance, you must compile
and install pgvector, pg_cron, and pg_net separately.
