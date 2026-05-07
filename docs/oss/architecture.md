# Supabase OSS Architecture Design

Self-hosted, open-source version of coJournalist running on Supabase infrastructure. All code public under Sustainable Use License. License key gates DevOps automation and deployment convenience files (render.yaml, setup scripts, setup guide), not features. The core app is deployable via docker-compose without a license.

## Goals

1. **All code public** -- one public GitHub repo with Sustainable Use License, all features included
2. **License-gated automation** -- paying customers get automated setup + auto-updates via license key
3. **Single development workflow** -- one private dev repo, one automated public mirror
4. **Newsroom-ready** -- a developer with Claude Code or Codex can deploy in ~2 hours using the automation scripts

### Sustainable Use License

The repo uses the Sustainable Use License (not MIT), modeled after n8n's licensing approach:
- Allows self-hosting for internal newsroom use
- Prevents resale, white-labeling, or offering as a hosted service
- All code is visible and auditable -- no proprietary binaries or obfuscated modules

## Non-Goals

- Credit/billing system in the self-hosted version (internal newsroom use only)
- Feature gating -- all features work identically in the self-hosted version, no license key required for application functionality
- MuckRock OAuth (replaced by Supabase Auth)
- Per-user pricing tiers
- Migrating existing SaaS data from DynamoDB to PostgreSQL (SaaS remains on AWS indefinitely; the Supabase adapter is for new self-hosted deployments only)
- Private repository access management -- no GitHub/GitLab collaborator management needed

---

## 1. Repository Topology

Two repos, one development workflow:

| Repo | Visibility | Purpose | Updated |
|------|-----------|---------|---------|
| `buriedsignals/cojournalist` | Private | All development. AWS SaaS + Supabase adapter + deploy configs + automation scripts. | Every push |
| `buriedsignals/scoutpost-os` | Public | Automated mirror. Supabase code + deploy configs + automation scripts, no AWS code. All features. | Auto on push to main (after CI passes) |

### Mirror Pipeline

A GitHub Action on the dev repo filters and pushes to the public mirror:

```
[Private dev repo] ──on push to main (CI passes)──> [Public OSS repo]  (everything except AWS/MuckRock)
     (you work here)
```

**What the mirror receives:**

| Component | OSS Repo |
|-----------|:---:|
| Frontend (SvelteKit) | Yes |
| Backend + Supabase adapter | Yes |
| Supabase migrations + Edge Functions | Yes |
| Deploy configs (docker-compose, .env.example) | Yes |
| Deploy configs (render.yaml, SETUP.md) | No (license-gated via API) |
| Automation scripts (setup.sh, SETUP_AGENT.md) | No (license-gated via API) |
| Automation scripts (sync-upstream.yml) | No (license-gated via API) |
| All scout types (Page, Smart, Social, Civic) | Yes |
| Export + CMS integration | Yes |
| v1 API + API key management | Yes |
| Data extraction | Yes |
| All 12 languages | Yes |
| AWS adapter / Lambdas | No |
| MuckRock OAuth code | No |
| SaaS credit/billing code | No |
| Mirror GitHub Actions | No |

### GitHub Action: OSS Mirror

```yaml
# .github/workflows/mirror-oss.yml
name: Mirror to OSS Repo
on:
  push:
    branches: [main]
jobs:
  mirror:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Filter for OSS mirror
        run: |
          # Remove AWS infrastructure (SaaS only)
          rm -rf aws/
          rm -rf backend/app/adapters/aws/
          # Remove SaaS-only auth
          rm -f backend/app/routers/auth.py
          rm -f backend/app/services/muckrock_client.py
          # Remove SaaS-only billing and credit management
          rm -f backend/app/utils/credits.py
          rm -f backend/app/services/cron.py
          rm -f backend/app/services/seed_data_service.py
          # Remove CI workflows that reference the dev repo
          rm -f .github/workflows/mirror-*.yml
          rm -f .github/workflows/claude*.yml
          # Keep: deploy/, automation/, supabase/, all features
      - name: Validate stripped codebase
        run: |
          cd backend
          pip install -r requirements.txt
          DEPLOYMENT_TARGET=supabase python -c "from app.main import app"
      - name: Push to OSS repo
        uses: cpina/github-action-push-to-another-repository@v1
        with:
          source-directory: .
          destination-github-username: buriedsignals
          destination-repository-name: scoutpost-os
          target-branch: main
          create-target-branch-if-needed: true
```

---

## 2. Monorepo Structure

```
cojournalist/
├── frontend/                    # SvelteKit SPA (shared, env-based auth branching)
├── backend/
│   ├── app/
│   │   ├── routers/             # FastAPI routes (unchanged)
│   │   ├── services/            # Business logic (unchanged)
│   │   ├── schemas/             # Pydantic models (unchanged)
│   │   ├── ports/               # Abstract interfaces (NEW)
│   │   │   ├── storage.py       # ScoutStorage, ExecutionStorage, etc.
│   │   │   ├── scheduler.py     # SchedulerPort
│   │   │   └── auth.py          # AuthPort
│   │   ├── adapters/            # Infrastructure implementations (NEW)
│   │   │   ├── aws/             # DynamoDB, EventBridge, MuckRock OAuth
│   │   │   └── supabase/        # PostgreSQL, pg_cron, Supabase Auth
│   │   └── dependencies.py      # DI wiring via DEPLOYMENT_TARGET env var
│   └── tests/
├── aws/                         # Lambda functions (SaaS only, stripped from mirrors)
│   └── lambdas/
├── supabase/                    # Supabase-specific (NEW)
│   ├── migrations/              # SQL schema migrations
│   ├── functions/               # Edge Functions (Deno/TypeScript)
│   │   ├── execute-scout/       # Replaces scraper-lambda
│   │   └── manage-schedule/     # Replaces create-eventbridge-schedule + delete-schedule
│   └── config.toml
├── deploy/                      # Deploy configs (included in OSS repo)
│   ├── render/
│   │   └── render.yaml
│   └── docker/
│       └── docker-compose.yml
├── automation/                  # Automation scripts (included in OSS repo, license-gated)
│   ├── setup.sh                 # One-time bootstrap (license-gated)
│   ├── sync-upstream.yml        # GitHub Action for auto-updates (license-gated)
│   └── SETUP_AGENT.md           # Prompt for Claude Code / Codex
├── .github/workflows/
│   ├── ci.yml                   # Existing CI
│   └── mirror-oss.yml           # Auto-push to OSS repo
└── scripts/
    └── filter-mirror.sh         # Strips AWS/SaaS code for mirror
```

### Adapter Pattern

Runtime selection via `DEPLOYMENT_TARGET` environment variable:

```python
# backend/app/dependencies.py
from app.config import settings

def get_scout_storage() -> ScoutStoragePort:
    if settings.deployment_target == "supabase":
        from app.adapters.supabase.storage import SupabaseScoutStorage
        return SupabaseScoutStorage()
    from app.adapters.aws.storage import DynamoDBScoutStorage
    return DynamoDBScoutStorage()
```

Routers and services depend on abstract port interfaces. They never import boto3 or supabase-py directly.

### Port Interfaces

```python
# backend/app/ports/storage.py
from abc import ABC, abstractmethod

class ScoutStoragePort(ABC):
    @abstractmethod
    async def create_scout(self, user_id: str, data: dict) -> dict: ...
    @abstractmethod
    async def get_scout(self, user_id: str, scout_name: str) -> dict: ...
    @abstractmethod
    async def get_scout_by_id(self, scout_id: str) -> dict: ...
    @abstractmethod
    async def list_scouts(self, user_id: str) -> list[dict]: ...
    @abstractmethod
    async def delete_scout(self, user_id: str, scout_name: str) -> None: ...
    @abstractmethod
    async def update_scout(self, user_id: str, scout_name: str, updates: dict) -> dict: ...
    @abstractmethod
    async def deactivate_scout(self, scout_id: str) -> None: ...

class ExecutionStoragePort(ABC):
    @abstractmethod
    async def store_execution(self, user_id: str, scout_id: str, summary: str,
                              embedding: list[float], is_duplicate: bool,
                              content_hash: str = None, metadata: dict = None) -> dict: ...
    @abstractmethod
    async def get_recent_executions(self, user_id: str, scout_id: str,
                                     limit: int = 5) -> list[dict]: ...
    @abstractmethod
    async def check_duplicate(self, user_id: str, scout_id: str, summary_text: str,
                               threshold: float = 0.85) -> tuple[bool, float, list[float]]:
        """Returns (is_duplicate, highest_similarity, embedding).
        Generates embedding internally and returns it for reuse by store_execution()."""
        ...
    @abstractmethod
    async def get_latest_content_hash(self, user_id: str, scout_id: str) -> str | None: ...

class RunStoragePort(ABC):
    @abstractmethod
    async def store_run(self, scout_id: str, user_id: str, status: str,
                        error_message: str = None, **kwargs) -> dict: ...
    @abstractmethod
    async def get_latest_runs(self, user_id: str, limit: int = 10) -> list[dict]: ...
    @abstractmethod
    async def get_latest_run_for_scout(self, scout_id: str) -> dict | None: ...

class PostSnapshotStoragePort(ABC):
    @abstractmethod
    async def store_snapshot(self, user_id: str, scout_id: str,
                              platform: str, handle: str, posts: list[dict]) -> None: ...
    @abstractmethod
    async def get_snapshot(self, user_id: str, scout_id: str) -> list[dict]: ...

class UnitStoragePort(ABC):
    @abstractmethod
    async def store_units(self, user_id: str, scout_id: str, units: list[dict]) -> None: ...
    @abstractmethod
    async def search_units(self, user_id: str, query_embedding: list[float],
                            filters: dict = None, limit: int = 20) -> list[dict]: ...
    @abstractmethod
    async def get_units_for_article(self, article_id: str) -> list[dict]: ...
    @abstractmethod
    async def get_units_by_location(self, user_id: str, country: str,
                                     state: str = None, city: str = None,
                                     limit: int = 50) -> list[dict]: ...
    @abstractmethod
    async def get_units_by_topic(self, user_id: str, topic: str,
                                  limit: int = 50) -> list[dict]: ...
    @abstractmethod
    async def get_distinct_locations(self, user_id: str) -> list[dict]: ...
    @abstractmethod
    async def get_distinct_topics(self, user_id: str) -> list[str]: ...
    @abstractmethod
    async def mark_used(self, unit_ids: list[str]) -> None: ...

class SeenRecordStoragePort(ABC):
    @abstractmethod
    async def mark_seen(self, scout_id: str, user_id: str, signature: str) -> bool: ...
    @abstractmethod
    async def is_seen(self, scout_id: str, user_id: str, signature: str) -> bool: ...

class UserStoragePort(ABC):
    @abstractmethod
    async def get_user(self, user_id: str) -> dict: ...
    @abstractmethod
    async def create_or_update_user(self, user_id: str, data: dict) -> dict: ...

# backend/app/ports/scheduler.py
class SchedulerPort(ABC):
    @abstractmethod
    async def create_schedule(self, schedule_name: str, cron: str,
                               target_config: dict) -> str: ...
    @abstractmethod
    async def delete_schedule(self, schedule_name: str) -> None: ...
    @abstractmethod
    async def update_schedule(self, schedule_name: str, cron: str = None,
                               target_config: dict = None) -> None: ...

# backend/app/ports/auth.py
class AuthPort(ABC):
    @abstractmethod
    async def get_current_user(self, request: Request) -> dict: ...
    @abstractmethod
    async def get_user_email(self, user_id: str) -> str: ...
    @abstractmethod
    async def verify_service_key(self, key: str) -> bool: ...

# backend/app/ports/billing.py
class BillingPort(ABC):
    """Credit/billing abstraction. SaaS uses MuckRock entitlements.
    OSS uses NoOpBilling (all operations succeed, no limits)."""
    @abstractmethod
    async def validate_credits(self, user_id: str, operation: str) -> bool: ...
    @abstractmethod
    async def decrement_credit(self, user_id: str, operation: str) -> bool: ...
    @abstractmethod
    async def get_balance(self, user_id: str) -> dict: ...
```

The `NoOpBilling` adapter (Supabase) always returns `True` for validation and decrement, and returns an unlimited balance. This allows the billing-related code in routers to remain unchanged -- the adapter handles the difference.

**Important refactoring note for Phase 1:** The current `ScheduleService` conflates storage, scheduling, and execution orchestration. During the adapter extraction, decompose it into:
- Storage ports (above)
- `SchedulerPort` (above)
- A new `ScoutManager` service class that handles `run_scout()` logic (reading scout config, building type-specific payloads, calling internal endpoints). This is business logic that sits above the storage layer and should not change between adapters.

---

## 3. Database Schema (PostgreSQL)

Replaces the DynamoDB single-table design. All DynamoDB record types are covered.

### Extensions

```sql
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_cron";
CREATE EXTENSION IF NOT EXISTS "pg_net";
```

`pg_net` is needed for pg_cron to trigger Edge Functions via HTTP POST.

**Embedding dimension note:** All `vector(1536)` columns assume the current embedding model (`gemini-embedding-2-preview` with MRL truncation to 1536 dimensions, configured in `embedding_utils.py`). If a self-hosted deployment uses a different embedding model, the dimension must be updated in the migration. Consider making this configurable via an env var in a future iteration.

### Tables

```sql
-- ============================================================
-- SCOUTS (replaces SCRAPER# records)
-- ============================================================
CREATE TABLE scouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('web', 'beat', 'social', 'civic')),

    -- Common fields (all scout types)
    criteria TEXT,
    preferred_language TEXT DEFAULT 'en',
    regularity TEXT CHECK (regularity IN ('daily', 'weekly', 'monthly')),
    schedule_cron TEXT,
    schedule_timezone TEXT DEFAULT 'UTC',
    topic TEXT,

    -- Web scout fields
    url TEXT,
    provider TEXT CHECK (provider IN ('firecrawl', 'firecrawl_plain')),

    -- Beat scout fields
    source_mode TEXT CHECK (source_mode IN ('reliable', 'niche')),
    excluded_domains TEXT[],

    -- Social scout fields
    platform TEXT CHECK (platform IN ('instagram', 'x', 'facebook')),
    profile_handle TEXT,
    monitor_mode TEXT CHECK (monitor_mode IN ('summarize', 'criteria')),
    track_removals BOOLEAN DEFAULT FALSE,

    -- Civic scout fields
    root_domain TEXT,
    tracked_urls TEXT[],
    processed_pdf_urls TEXT[],

    -- Location (GeocodedLocation object)
    location JSONB,

    -- Overflow for rare/optional type-specific config
    config JSONB NOT NULL DEFAULT '{}',

    is_active BOOLEAN DEFAULT TRUE,
    consecutive_failures INT DEFAULT 0,
    baseline_established_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, name),
    CONSTRAINT chk_active_has_schedule
        CHECK (NOT is_active OR schedule_cron IS NOT NULL)
);

-- ============================================================
-- SCOUT RUNS (replaces TIME# records)
-- ============================================================
CREATE TABLE scout_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scout_id UUID REFERENCES scouts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id),
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error', 'skipped')),
    scraper_status BOOLEAN DEFAULT FALSE,
    criteria_status BOOLEAN DEFAULT FALSE,
    notification_sent BOOLEAN DEFAULT FALSE,
    articles_count INT DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '90 days')
);

-- ============================================================
-- EXECUTION RECORDS (replaces EXEC# records)
-- Card display summaries + deduplication via embedding similarity
-- ============================================================
CREATE TABLE execution_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scout_id UUID REFERENCES scouts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id),
    scout_type TEXT,
    summary_text TEXT NOT NULL,
    embedding vector(1536),
    content_hash TEXT,
    is_duplicate BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '90 days')
);

-- ============================================================
-- POST SNAPSHOTS (replaces POSTS# records -- social scouts)
-- Stores the baseline post list for ID-based diffing
-- ============================================================
CREATE TABLE post_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scout_id UUID REFERENCES scouts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id),
    platform TEXT,
    handle TEXT,
    post_count INT,
    posts JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(scout_id)
);

-- ============================================================
-- SEEN RECORDS (replaces SEEN# records -- beat dedup)
-- ============================================================
CREATE TABLE seen_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scout_id UUID REFERENCES scouts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id),
    signature TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '90 days'),
    UNIQUE(scout_id, signature)
);

-- ============================================================
-- PROMISES (civic scout -- extracted council promises)
-- ============================================================
CREATE TABLE promises (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scout_id UUID REFERENCES scouts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id),
    promise_text TEXT NOT NULL,
    context TEXT,
    source_url TEXT,
    source_title TEXT,
    meeting_date DATE,
    status TEXT DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'fulfilled', 'broken')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INFORMATION UNITS (replaces information-units table)
-- Atomic facts extracted from scout results
-- ============================================================
CREATE TABLE information_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id),
    scout_id UUID REFERENCES scouts(id) ON DELETE CASCADE,
    scout_type TEXT,
    article_id UUID,
    statement TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('fact', 'event', 'entity_update')),
    entities TEXT[],
    embedding vector(1536),
    source_url TEXT,
    source_domain TEXT,
    source_title TEXT,
    event_date DATE,
    country TEXT,
    state TEXT,
    city TEXT,
    topic TEXT,
    dataset_id TEXT,
    used_in_article BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '90 days')
);

-- ============================================================
-- USER PREFERENCES (replaces USER#/PROFILE)
-- Tier + active_org_id added by 00025_credits.sql for entitlement resolution.
-- ============================================================
CREATE TABLE user_preferences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    timezone TEXT DEFAULT 'UTC',
    preferred_language TEXT DEFAULT 'en',
    notification_email TEXT,
    default_location JSONB,
    excluded_domains TEXT[],
    preferences JSONB DEFAULT '{}',
    onboarding_completed BOOLEAN DEFAULT FALSE,
    onboarding_tour_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Indexes

```sql
-- Scout lookups
CREATE INDEX idx_scouts_user ON scouts(user_id);
CREATE INDEX idx_scouts_type ON scouts(user_id, type);
CREATE INDEX idx_scouts_active ON scouts(user_id) WHERE is_active = TRUE;

-- Run queries (time-ordered)
CREATE INDEX idx_runs_scout ON scout_runs(scout_id, started_at DESC);
CREATE INDEX idx_runs_user_time ON scout_runs(user_id, started_at DESC);

-- Execution record lookups
CREATE INDEX idx_exec_scout ON execution_records(scout_id, completed_at DESC);

-- Information unit lookups
CREATE INDEX idx_units_user ON information_units(user_id);
CREATE INDEX idx_units_scout ON information_units(scout_id, created_at DESC);
CREATE INDEX idx_units_location ON information_units(user_id, country, state, city);
CREATE INDEX idx_units_article ON information_units(article_id);

-- Seen record lookups
CREATE INDEX idx_seen_scout ON seen_records(scout_id);

-- Promise lookups
CREATE INDEX idx_promises_scout ON promises(scout_id, created_at DESC);
CREATE INDEX idx_promises_user ON promises(user_id);

-- TTL cleanup (partial indexes for efficient DELETE scans)
CREATE INDEX idx_runs_expires ON scout_runs(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_exec_expires ON execution_records(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_units_expires ON information_units(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_seen_expires ON seen_records(expires_at) WHERE expires_at IS NOT NULL;

-- Vector similarity (HNSW -- works at any data volume, no calibration needed)
CREATE INDEX idx_exec_embedding ON execution_records
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_unit_embedding ON information_units
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

### Row Level Security

```sql
ALTER TABLE scouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scout_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE seen_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE information_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE promises ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

-- User-scoped access (PostgREST / Supabase client)
CREATE POLICY scouts_user ON scouts FOR ALL USING (auth.uid() = user_id);
CREATE POLICY runs_user ON scout_runs FOR ALL USING (auth.uid() = user_id);
CREATE POLICY exec_user ON execution_records FOR ALL USING (auth.uid() = user_id);
CREATE POLICY posts_user ON post_snapshots FOR ALL USING (auth.uid() = user_id);
CREATE POLICY seen_user ON seen_records FOR ALL USING (auth.uid() = user_id);
CREATE POLICY units_user ON information_units FOR ALL USING (auth.uid() = user_id);
CREATE POLICY promises_user ON promises FOR ALL USING (auth.uid() = user_id);
CREATE POLICY prefs_user ON user_preferences FOR ALL USING (auth.uid() = user_id);
```

Note: The FastAPI backend connects via the Supabase **service role key**, which bypasses RLS automatically. pg_cron cleanup functions use `SECURITY DEFINER` to bypass RLS.

### Updated_at Trigger

```sql
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scouts_updated_at
    BEFORE UPDATE ON scouts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_user_prefs_updated_at
    BEFORE UPDATE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_promises_updated_at
    BEFORE UPDATE ON promises
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### TTL Cleanup

Runs as separate `SECURITY DEFINER` functions to bypass RLS:

```sql
-- Batched deletes to avoid long-running locks.
-- Each invocation deletes up to 10,000 rows. The cron job runs
-- frequently enough that this keeps up with normal accumulation.
-- If a backlog builds (e.g., cron was disabled), it drains over
-- successive runs without blocking concurrent writes.

CREATE OR REPLACE FUNCTION cleanup_scout_runs()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM scout_runs WHERE id IN (
        SELECT id FROM scout_runs WHERE expires_at < NOW() LIMIT 10000
    );
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_execution_records()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM execution_records WHERE id IN (
        SELECT id FROM execution_records WHERE expires_at < NOW() LIMIT 10000
    );
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_information_units()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM information_units WHERE id IN (
        SELECT id FROM information_units WHERE expires_at < NOW() LIMIT 10000
    );
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_seen_records()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM seen_records WHERE id IN (
        SELECT id FROM seen_records WHERE expires_at < NOW() LIMIT 10000
    );
END;
$$;

-- Staggered schedules to avoid lock contention
SELECT cron.schedule('cleanup-scout-runs',       '0 3 * * *', 'SELECT cleanup_scout_runs()');
SELECT cron.schedule('cleanup-execution-records', '5 3 * * *', 'SELECT cleanup_execution_records()');
SELECT cron.schedule('cleanup-information-units', '10 3 * * *', 'SELECT cleanup_information_units()');
SELECT cron.schedule('cleanup-seen-records',      '15 3 * * *', 'SELECT cleanup_seen_records()');
```

---

## 4. Auth (OSS Version)

Supabase Auth replaces MuckRock OAuth. Simple email/password or magic link authentication for internal newsroom use.

| Concern | SaaS (AWS) | Self-Hosted (Supabase) |
|---------|-----------|----------------------|
| Provider | MuckRock OAuth 2.0 | Supabase Auth (email/password, magic link) |
| Session | httpOnly cookie with HS256 JWT | Supabase JWT (stored client-side) |
| User data | DynamoDB `USER#/PROFILE` | `auth.users` + `user_preferences` |
| Email privacy | Fetched on-demand from MuckRock API | Stored in `auth.users` (internal newsroom, acceptable) |
| Service auth | `X-Service-Key` HMAC-SHA256 | Supabase service role key |

### Frontend Auth Changes

- Replace MuckRock OAuth flow with `@supabase/supabase-js` auth
- Auth header changes from session cookie to `Authorization: Bearer <supabase_jwt>`
- Build-time env var `PUBLIC_DEPLOYMENT_TARGET=supabase` controls which auth flow loads

**Conditional loading pattern:** The auth store uses a dynamic import based on the build-time env var:

```typescript
// frontend/src/lib/stores/auth.ts
const DEPLOYMENT = import.meta.env.PUBLIC_DEPLOYMENT_TARGET;

export const authAdapter = DEPLOYMENT === 'supabase'
    ? await import('./auth-supabase')   // @supabase/supabase-js
    : await import('./auth-muckrock');  // current MuckRock OAuth flow
```

**Billing/credit UI:** Components that reference credits, billing, or entitlements are conditionally excluded from the build when `PUBLIC_DEPLOYMENT_TARGET=supabase`. The `BillingPort` adapter (NoOpBilling) means the backend never returns credit errors, so UI guards can be removed entirely in the OSS build rather than hidden.

### Backend Auth Adapter

```python
# backend/app/adapters/supabase/auth.py
class SupabaseAuth(AuthPort):
    async def get_current_user(self, request: Request) -> dict:
        token = request.headers.get("Authorization", "").replace("Bearer ", "")
        # Verify JWT using Supabase JWT secret
        payload = jwt.decode(token, settings.supabase_jwt_secret, algorithms=["HS256"])
        user_id = payload["sub"]
        return await self.user_storage.get_user(user_id)

    async def get_user_email(self, user_id: str) -> str:
        # In Supabase, email is in auth.users (accessible via service role)
        result = self.supabase.auth.admin.get_user_by_id(user_id)
        return result.user.email

    async def verify_service_key(self, key: str) -> bool:
        return hmac.compare_digest(key, settings.internal_service_key)
```

---

## 5. Scheduling (OSS Version)

pg_cron + pg_net replaces EventBridge + Lambda.

### How It Works

1. When a scout is created, the Supabase adapter inserts a `pg_cron` job that fires `pg_net.http_post()` to the `execute-scout` Edge Function
2. The Edge Function calls the FastAPI backend's execute endpoint (same as the current scraper-lambda)
3. Results are stored in PostgreSQL via the Supabase storage adapter

### Schedule Management

The `SupabaseScheduler` adapter builds the full SQL string in Python (injecting the Supabase URL and service role key as literals) and executes it via `asyncpg`. This avoids relying on PostgreSQL custom GUC variables (`current_setting`), which may not be available on managed Supabase.

```python
# backend/app/adapters/supabase/scheduler.py
class SupabaseScheduler(SchedulerPort):
    async def create_schedule(self, schedule_name: str, cron: str,
                               target_config: dict) -> str:
        sql = """
            SELECT cron.schedule(
                $1,  -- schedule name
                $2,  -- cron expression
                format(
                    'SELECT net.http_post(
                        url := %L,
                        headers := %L::jsonb,
                        body := %L::jsonb
                    )',
                    $3,  -- full Edge Function URL
                    $4,  -- headers JSON string
                    $5   -- body JSON string
                )
            )
        """
        url = f"{settings.supabase_url}/functions/v1/execute-scout"
        headers = json.dumps({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.supabase_service_key}"
        })
        body = json.dumps(target_config)
        await self.pool.execute(sql, schedule_name, cron, url, headers, body)

    async def delete_schedule(self, schedule_name: str) -> None:
        await self.pool.execute("SELECT cron.unschedule($1)", schedule_name)
```

### Edge Functions (Replace Lambdas)

| Lambda | Edge Function | Notes |
|--------|--------------|-------|
| `create-eventbridge-schedule` | `manage-schedule` | Creates/deletes pg_cron jobs + scout records |
| `scraper-lambda` | `execute-scout` | Routes scout execution by type, calls FastAPI |
| `return-scraper-results` | Not needed | Direct Postgres queries via Supabase client |
| `delete-schedule` | Merged into `manage-schedule` | Single function handles CRUD |
| `service-key-authorizer` | Not needed | Supabase Auth JWT validation |

5 Lambdas become 2 Edge Functions. Both are thin TypeScript wrappers that call FastAPI endpoints -- no business logic duplication.

---

## 6. Deploy Configurations

### Render Blueprint (`deploy/render/render.yaml`)

```yaml
services:
  - type: web
    name: cojournalist-api
    runtime: python
    repo: https://github.com/buriedsignals/scoutpost-os
    branch: main
    rootDir: backend
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn app.main:app --host 0.0.0.0 --port $PORT
    plan: starter
    healthCheckPath: /api/health
    autoDeploy: true
    envVars:
      - key: DEPLOYMENT_TARGET
        value: supabase
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_KEY
        sync: false
      - key: SUPABASE_ANON_KEY
        sync: false
      - key: SUPABASE_JWT_SECRET
        sync: false
      - key: GEMINI_API_KEY
        sync: false
      - key: OPENROUTER_API_KEY
        sync: false  # optional — only needed for non-Gemini models
      - key: LLM_MODEL
        value: gemini-2.5-flash-lite
      - key: FIRECRAWL_API_KEY
        sync: false
      - key: RESEND_API_KEY
        sync: false
      - key: APIFY_API_TOKEN
        sync: false
      - key: INTERNAL_SERVICE_KEY
        generateValue: true

  - type: web
    name: cojournalist-frontend
    runtime: static
    repo: https://github.com/buriedsignals/scoutpost-os
    branch: main
    rootDir: frontend
    buildCommand: npm install && npm run build
    staticPublishPath: build
    autoDeploy: true
    envVars:
      - key: PUBLIC_DEPLOYMENT_TARGET
        value: supabase
      - key: PUBLIC_SUPABASE_URL
        sync: false
      - key: PUBLIC_SUPABASE_ANON_KEY
        sync: false
      - key: PUBLIC_MAPTILER_API_KEY
        sync: false
    routes:
      - type: rewrite
        source: /api/*
        destination: https://cojournalist-api.onrender.com/api/*
```

### Docker Compose (`deploy/docker/docker-compose.yml`)

For newsrooms self-hosting without Render. Includes Supabase stack + FastAPI + SvelteKit.

```yaml
# Skeleton -- full config built in Phase 3
services:
  # --- Supabase core ---
  db:
    image: supabase/postgres:15.6.1.143
    ports: ["5432:5432"]
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - db-data:/var/lib/postgresql/data
      - ./supabase/migrations:/docker-entrypoint-initdb.d

  auth:
    image: supabase/gotrue:v2.170.0
    depends_on: [db]
    environment:
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:${POSTGRES_PASSWORD}@db:5432/postgres
      GOTRUE_JWT_SECRET: ${SUPABASE_JWT_SECRET}

  rest:
    image: postgrest/postgrest:v12.2.8
    depends_on: [db]

  edge-functions:
    image: supabase/edge-runtime:v1.67.4
    depends_on: [db]
    volumes:
      - ./supabase/functions:/home/deno/functions

  # --- Application ---
  backend:
    build: ./backend
    depends_on: [db, auth]
    environment:
      DEPLOYMENT_TARGET: supabase
      SUPABASE_URL: http://kong:8000
      SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY}
      SUPABASE_JWT_SECRET: ${SUPABASE_JWT_SECRET}
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@db:5432/postgres

  frontend:
    build: ./frontend
    depends_on: [backend]
    ports: ["3000:3000"]

  # --- API Gateway ---
  kong:
    image: kong:3.8
    depends_on: [auth, rest, edge-functions, backend]
    ports: ["8000:8000"]

volumes:
  db-data:
```

### Environment Variables (OSS Version)

```bash
# Required
DEPLOYMENT_TARGET=supabase
SUPABASE_URL=https://xxx.supabase.co      # or self-hosted URL
SUPABASE_SERVICE_KEY=xxx
SUPABASE_ANON_KEY=xxx
SUPABASE_JWT_SECRET=xxx
GEMINI_API_KEY=xxx                         # LLM + multimodal embeddings
FIRECRAWL_API_KEY=xxx
RESEND_API_KEY=xxx
APIFY_API_TOKEN=xxx
INTERNAL_SERVICE_KEY=xxx                   # auto-generated by Render

# Optional
LLM_MODEL=gemini-2.5-flash-lite           # default; Gemini models use direct API
OPENROUTER_API_KEY=xxx                     # only needed for non-Gemini models
RESEND_FROM_EMAIL=scouts@newsroom.org
PUBLIC_MAPTILER_API_KEY=xxx                # geocoding
```

---

## 7. License Key Infrastructure

License keys gate the automation scripts (`setup.sh`, `sync-upstream.yml` GitHub Action) -- not application features. All features work identically without a license key.

The full license key design is documented in `docs/architecture/license-key-infrastructure.md`. Key points:

- **~200 lines of Python**, 2 new files (`routers/license.py`, `services/license_key_service.py`)
- **DynamoDB storage** using existing `scraping-jobs` table with `LICENSE#` and `STRIPE_SUB#` record types
- **Key format:** `cjl_XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (192 bits entropy, only SHA-256 hash stored)
- **Validation endpoint:** `POST /api/license/validate` with key in request body -- returns metadata (status, expiry, email)
- **Stripe webhooks:** `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`, `invoice.payment_failed`
- **Idempotency:** webhook handler checks for existing license before generating a new one
- **Grace period:** fail open on network errors, fail closed on explicit rejections
- **Rate limited:** 10/minute per IP on validation endpoint

### Pricing Model

Annual license (pricing TBD). Includes:
- Automated setup via `setup.sh` and `SETUP_AGENT.md`
- Weekly auto-sync with upstream via `sync-upstream.yml` GitHub Action
- License key validation keeps the auto-update pipeline active

Does NOT include:
- API keys (newsroom provides their own Gemini, Firecrawl, Resend, Apify, MapTiler)
- Supabase hosting (newsroom creates their own account or self-hosts)
- Render hosting costs
- Support (separate tier if desired)

### What the license key is NOT

The license key is a social contract and tracking mechanism, not DRM. The automation scripts are in the public repo -- anyone can read them and replicate the steps manually. The Sustainable Use License provides the legal protection. This matches the n8n model: enterprise code is visible in the repo, but activation requires a valid key.

---

## 8. Automation Scripts

The `automation/` directory in the public repo contains the paid value: scripts that automate deployment and maintenance. These scripts validate the license key before running.

### Directory Structure

```
automation/
├── setup.sh                    # One-time bootstrap (license-gated)
├── sync-upstream.yml            # GitHub Action for auto-updates (license-gated)
└── SETUP_AGENT.md               # Prompt for Claude Code / Codex
```

### setup.sh

Automated bootstrap script. Validates license key via `POST /api/license/validate`, then:
1. Forks the OS repo to customer's GitHub
2. Prompts for API keys (Gemini, Firecrawl, Resend, Apify, MapTiler)
3. Initializes Supabase project (or connects to existing)
4. Runs all SQL migrations
5. Deploys Edge Functions
6. Writes `.env` with all configuration
7. Deploys to Render (or starts docker-compose)
8. Installs `sync-upstream.yml` GitHub Action in the fork
9. Runs health check to verify deployment

### sync-upstream.yml

GitHub Action installed in the customer's fork. Validates license key weekly, then:
1. Fetches latest from upstream OS repo
2. Merges upstream changes (critical files in the fork don't conflict)
3. Detects new migrations and runs them against Supabase
4. Triggers Render deploy hook (or rebuilds docker-compose)

If license key is expired or revoked: sync stops, customer keeps their code at the last version.
If license server is unreachable: sync proceeds with warning (fail open).

### SETUP_AGENT.md

A prompt designed for AI coding agents (Claude Code, Codex, etc.). Contains step-by-step instructions that the agent follows:
- Fork repo, add critical configuration
- Interactively collect API keys from the user
- Run migrations, deploy edge functions
- Configure and deploy to Render or Docker
- Verify the deployment works

This makes the paid experience: "paste this into Claude Code and answer a few questions -> fully deployed in 2 hours."

---

## 9. What Changes vs. What Stays

### Changes (Infrastructure Layer)

| Component | From (SaaS) | To (Self-Hosted) |
|-----------|-------------|-------------------|
| Database | DynamoDB (NoSQL, single-table) | PostgreSQL with pgvector |
| Scheduling | EventBridge + Lambda | pg_cron + pg_net + Edge Functions |
| Serverless | Lambda (Python) | Edge Functions (Deno/TypeScript) |
| Auth | MuckRock OAuth 2.0 | Supabase Auth (email/password) |
| Storage queries | boto3 | asyncpg (primary) + supabase-py (auth admin only) |
| TTL cleanup | DynamoDB native | pg_cron SECURITY DEFINER functions |
| Embeddings | Compressed float32 arrays in binary | pgvector native `vector(1536)` |
| User management | MuckRock API + DynamoDB | Supabase `auth.users` + `user_preferences` |

### Stays Unchanged (Business Logic)

- FastAPI backend -- all orchestrators, services, AI logic
- SvelteKit frontend (except auth flow)
- Scout types: web, beat, social, civic
- External APIs: OpenRouter, Firecrawl, Apify, Resend, MapTiler
- Email notification templates
- Pydantic schemas
- Deduplication logic (cosine similarity threshold, content hashing)
- Social scout post diffing (ID-based comparison)
- AI analysis prompts and response parsing

---

## 10. Implementation Phases

### Phase 0: Pre-Phase Refactoring

Targeted refactors to make the adapter extraction (Phase 1) easier. No behavior changes.

1. **Break up `schedule_service.py`** -- split the monolith (~800 lines) into: `scout_crud.py` (SCRAPER# CRUD), `run_recorder.py` (TIME# storage), `scout_runner.py` (run_scout orchestration), and a slim `schedule_service.py` (EventBridge only)
2. **Move inline boto3 out of routers** -- extract DynamoDB calls from `social.py` and `scraper.py` routers into a `PostSnapshotService`
3. **Split `dependencies.py`** -- separate auth, billing, and DI wiring into `dependencies/auth.py`, `dependencies/billing.py`, `dependencies/providers.py`
4. **Consolidate duplicated utilities** -- extract `build_schedule_name()`, `sanitize_name()` from 4 files into `utils/schedule_naming.py`
5. **Refactor credit call sites** -- change all ~30 direct calls to `validate_user_credits()` and `decrement_credit()` across 9 routers to use a single injected dependency (prep for BillingPort)
6. Verify: all existing tests pass, zero behavior change

### Phase 1: Adapter Refactoring

Extract ALL boto3-coupled code behind abstract port interfaces.

1. Create port interfaces (`storage.py`, `scheduler.py`, `auth.py`, `billing.py`)
2. Move current boto3 code into `backend/app/adapters/aws/`, including:
   - `feed_search_service.py` (441 lines, separate `information-units` table)
   - `atomic_unit_service.py` (799 lines, same separate table)
   - `execution_deduplication.py` (308 lines)
   - `civic_orchestrator.py` (1120 lines, DynamoDB for promises)
3. **Decompose `ScheduleService`** -- currently conflates storage, scheduling, and execution orchestration. Split into:
   - Storage port implementations (ScoutStorage, RunStorage, etc.)
   - `SchedulerPort` implementation (EventBridge adapter)
   - New `ScoutManager` service for `run_scout()` orchestration logic
4. **Standardize scout identifiers** -- the codebase currently uses `(user_id, scraper_name)` as the primary key. The PostgreSQL schema uses UUID `scout_id`. During this phase, ensure internal references can work with either scheme so the Supabase adapter can use UUIDs.
5. Update all services and routers to use dependency injection
6. Add `DEPLOYMENT_TARGET` config with `aws` as default
7. Verify: existing SaaS deployment works identically

### Phase 2: Supabase Implementation

Build the Supabase adapter and infrastructure.

1. Write SQL migrations (schema from Section 3)
2. Implement `SupabaseScoutStorage`, `SupabaseExecutionStorage`, etc.
3. Implement `SupabaseScheduler` (pg_cron management)
4. Implement `SupabaseAuth` adapter
5. Create Edge Functions (`execute-scout`, `manage-schedule`)
6. Frontend: add Supabase Auth flow (conditional on `PUBLIC_DEPLOYMENT_TARGET`)
7. Verify: full scout execution cycle on Supabase (create, schedule, execute, notify)

### Phase 3: Deploy Configs & Mirror

Set up the distribution pipeline.

1. Write `render.yaml` blueprint
2. Write `docker-compose.yml` for self-hosted
3. Create `scoutpost-os` public repo on GitHub (only one mirror repo needed)
4. Build `mirror-oss.yml` GitHub Action with validation step (imports stripped codebase and verifies it starts)
5. Write setup documentation
6. Verify: mirror runs on push to main, stripped codebase boots with `DEPLOYMENT_TARGET=supabase`

### Phase 4: License Key Infrastructure

Build the license key system (see `docs/architecture/license-key-infrastructure.md`).

1. Create Stripe product + price for annual license
2. Build `routers/license.py` and `services/license_key_service.py`
3. Build Stripe webhook handler for subscription lifecycle (checkout, payment, cancellation)
4. Implement license key generation, hashing, and validation
5. Add rate limiting on validation endpoint
6. Verify: full lifecycle -- subscribe, receive key, validate, cancel, key expires

### Phase 5: Automation Scripts

Build the license-gated automation in the `automation/` directory.

1. Build `setup.sh` with license key validation + full bootstrap flow
2. Build `sync-upstream.yml` GitHub Action with license validation + auto-merge + migration detection
3. Write `SETUP_AGENT.md` prompt for AI coding agents
4. Test end-to-end: license key -> setup.sh -> deployed instance -> sync receives updates
5. Verify: expired key stops sync, unreachable server fails open

---

## 11. Key Technical Considerations

| Challenge | Solution |
|-----------|----------|
| No existing DB abstraction | Port/adapter pattern. Extract AWS code first, then build Supabase adapter. |
| Single-table DynamoDB → normalized Postgres | Schema in Section 3 maps every record type. `ON DELETE CASCADE` replaces manual batch deletes. |
| RLS blocks server-side operations | Backend uses service role key (bypasses RLS). pg_cron uses `SECURITY DEFINER` functions. |
| Compressed embeddings → pgvector | pgvector `vector(1536)` handles storage natively. No compress/decompress needed. |
| EventBridge → pg_cron | pg_cron schedules `pg_net.http_post()` to Edge Functions. Same HTTP-trigger pattern. |
| 5 Lambdas → 2 Edge Functions | `return-scraper-results` becomes direct queries. `service-key-authorizer` replaced by Supabase Auth. |
| DynamoDB TTL → Postgres cleanup | `SECURITY DEFINER` functions on staggered cron schedules with partial indexes on `expires_at`. |
| Invalid `DEPLOYMENT_TARGET` | Fail fast at startup with clear error message if value is not `aws` or `supabase` |
| Duplicated utility functions | Consolidate `build_schedule_name()`, `sanitize_name()` into shared module during adapter refactoring. |
