# Documentation Guide

## Project-Wide Rules

Read the nearest parent `AGENTS.md` / `AGENTS.md` before editing; its session preflight points to the canonical coding-rules skill. This file only adds directory-specific context.

## Documentation Structure

```
docs/
├── AGENTS.md                              # This file
├── architecture/                          # Shared / SaaS-specific
│   ├── developer-guide.md                 # Local setup, extending scouts, contributing
│   └── fastapi-endpoints.md               # All REST endpoints with examples
├── features/                              # What each feature does
│   ├── civic.md                           # Civic Scout: council monitoring, promises (incl. design ref)
│   ├── beat.md                           # Beat Scout (type `beat`)
│   ├── social.md                          # Social media monitoring (Apify)
│   ├── page-archive.md                    # Page Archive: retrieve/toggle evidence snapshots (UI⇄agent parity)
│   └── web-scouts.md                      # Website change detection
├── mcp/                                   # MCP remote server (separate, read first if touching MCP)
│   ├── README.md                          # Index + 30-second overview
│   ├── architecture.md                    # FastAPI proxy + Supabase EF + broker, request flow
│   ├── oauth.md                           # DCR + PKCE + magiclink + server-side mint chain
│   ├── endpoints.md                       # Every public endpoint with curl probes
│   ├── clients.md                         # Per-client setup recipes (Cowork, Codex Desktop, Cursor, etc.)
│   ├── self-hosting.md                    # Required env vars, allowlists, OSS adopter checklist
│   └── debugging.md                       # Configure-vs-Connect, request_id, common failure modes
├── supabase/                              # Authoritative Supabase system docs (read these)
│   ├── README.md                          # Index + conventions
│   ├── architecture-overview.md           # Who-calls-what diagram
│   ├── migrations.md                      # One-liner per migration file
│   ├── auth-users.md                      # auth.users + user_preferences
│   ├── credits-entitlements.md            # orgs, credit_accounts, decrement RPC, webhook
│   ├── scouts-runs.md                     # scouts, scout_runs, scheduling, failure handling
│   ├── units-entities.md                  # information_units, entities, semantic search
│   ├── projects-ingest.md                 # projects, project_members, ingests
│   ├── civic-pipeline.md                  # civic_extraction_queue + worker
│   ├── social-apify.md                    # apify_run_queue + callback/reconcile
│   ├── mcp-oauth.md                       # MCP OAuth flow + tables
│   ├── cron-jobs.md                       # Every pg_cron job in one place
│   ├── rls-reference.md                   # Every RLS policy
│   ├── rpc-reference.md                   # Every RPC function
│   ├── edge-functions.md                  # Every Edge Function
│   ├── notifications.md                   # Scout email notifications (Resend, templates, i18n, benchmark)
│   ├── benchmarks.md                      # End-to-end scout benchmark scripts (web, beat, civic, social)
│   ├── vault-secrets.md                   # vault.decrypted_secrets usage
│   └── retention.md                       # TTL + cleanup cadence
├── oss/                                   # OSS distribution strategy (not Supabase-specific)
│   ├── architecture.md                    # Strategy: two-repo model, licensing, what ships
│   ├── adapter-pattern.md                 # Port/adapter design, DI wiring, async patterns
│   ├── supabase-schema.md                 # Legacy: superseded by docs/supabase/*
│   ├── edge-functions.md                  # Legacy: superseded by docs/supabase/edge-functions.md
│   ├── license-key.md                     # License key format, validation
│   ├── deployment-and-mirror.md           # Docker, Render, GitHub mirror CI
│   └── self-hosting-automation.md         # setup.sh, sync-upstream, agent instructions
├── muckrock/                              # MuckRock integration (auth + billing)
│   ├── oauth-integration.md               # OpenID flow, scopes, session cookies
│   ├── userinfo-and-orgs.md               # Userinfo schema, org structure
│   ├── webhooks.md                        # Webhook payloads, signature verification
│   ├── plans-and-entitlements.md          # Tier definitions (Free/Pro/Team), credit costs
│   ├── entitlements-pro-design.md         # Pro tier design: resolution, pricing, webhooks
│   └── entitlements-team-design.md        # Team plan: shared credit pools, ORG# records, seats
└── operations/                            # Current operator runbooks only
```

## Key Documentation by Topic

### Scout System
- **Page Scout** (type `web`): `features/web-scouts.md` - fresh crawl4ai scrape + local canonical-hash baselines
- **Page Archive**: `features/page-archive.md` - retrieve/toggle evidence snapshots (CLI `scout snapshots`, MCP `list_snapshots`/`get_snapshot_url`, REST `/snapshots`)
- **Beat Scout** (type `beat`): `features/beat.md` - Multi-language search, AI filtering
- **Social Scout** (type `social`): `features/social.md` - Social media monitoring, Apify scraping
- **Civic Scout** (type `civic`): `features/civic.md` - Council monitoring, promise extraction, design reference

### Units & Ingest
- **Units / Entities**: `supabase/units-entities.md` - Canonical information units, search, verification, and lifecycle
- **Ingest / Projects**: `supabase/projects-ingest.md` - Manual ingest, raw captures, ingests, and project scope

### Architecture
- **API Endpoints**: `architecture/fastapi-endpoints.md` - All REST endpoints
- **Developer Guide**: `architecture/developer-guide.md` - Local setup, extending scouts, contributing

### OSS / Self-Hosted
- **Strategy**: `oss/architecture.md` - Two-repo model, licensing, what ships in the OSS mirror
- **Adapter Pattern**: `oss/adapter-pattern.md` - Port/adapter design, DI wiring, how to add adapters
- **Supabase Schema**: `oss/supabase-schema.md` - PostgreSQL tables, indexes, RLS policies
- **Edge Functions**: `oss/edge-functions.md` - Supabase Edge Function reference
- **License Key**: `oss/license-key.md` - legacy/private validation design; public setup does not require license keys
- **Deployment & Mirror**: `oss/deployment-and-mirror.md` - Docker, Render, GitHub mirror CI
- **Self-hosting automation**: `oss/self-hosting-automation.md` - setup.sh, sync-upstream, agent instructions

### MCP (remote MCP server)
- **Index**: `mcp/README.md` — what's in `docs/mcp/`, surface area, related docs
- **Architecture**: `mcp/architecture.md` — proxy + EF + broker, why two layers
- **OAuth flow**: `mcp/oauth.md` — full DCR/PKCE/magiclink/server-side-mint chain
- **Endpoints**: `mcp/endpoints.md` — every well-known + OAuth + JSON-RPC endpoint with curl
- **Clients**: `mcp/clients.md` — Cowork, Desktop, Codex Desktop, Cursor, Windsurf, Antigravity, Goose, Hermes
- **Self-hosting**: `mcp/self-hosting.md` — env vars, redirect-URL allowlists, sanity probes
- **Debugging**: `mcp/debugging.md` — Configure-vs-Connect, request_id correlation, incident timeline

### MuckRock / Billing
- **OAuth**: `muckrock/oauth-integration.md` - OpenID flow, session cookies
- **Plans & Credits**: `muckrock/plans-and-entitlements.md` - Tier definitions, credit costs
- **Pro Design**: `muckrock/entitlements-pro-design.md` - Pro tier resolution, pricing page
- **Team Design**: `muckrock/entitlements-team-design.md` - Shared credit pools, seats
- **Webhooks**: `muckrock/webhooks.md` - Webhook payloads, processing flow

## Updating Documentation

When making code changes:

1. **New feature**: Create doc in `features/`
2. **API change**: Update `architecture/fastapi-endpoints.md`
3. **Schema change**: Update `oss/supabase-schema.md`
4. **Adapter change**: Update `oss/adapter-pattern.md`
5. **Edge Function change**: Update `oss/edge-functions.md`
   - **MCP-related EF change** (`mcp-server`, `mcp-auth`): also update `mcp/architecture.md` and `mcp/oauth.md`
6. **Billing change**: Update `muckrock/plans-and-entitlements.md`
7. **New integration**: Document within relevant feature doc in `features/`
8. **Auth flow / local dev auth change**: Update all of:
   - `docs/architecture/developer-guide.md`
   - `docs/architecture/fastapi-endpoints.md`
   - root `AGENTS.md`
   - root `AGENTS.md`
   - `backend/AGENTS.md`
   - `frontend/AGENTS.md`

For the private repo specifically, keep these auth distinctions explicit:

- production hosted auth = MuckRock callback/webhook proxied to Supabase Edge Functions
- local daily SaaS testing = localhost frontend + local FastAPI broker + hosted Supabase data
- local demo testing = local Supabase Auth + dummy/demo data only
