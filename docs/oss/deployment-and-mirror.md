# Phase 3: Deploy Configs & Mirror Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the public OSS repository, CI/CD mirror pipeline, and deployment configurations so newsrooms can deploy coJournalist on Render or Docker.

**Architecture:** GitHub Action mirrors code from private dev repo to public OSS repo on every push to main, stripping AWS/MuckRock/billing code. Deploy configs (render.yaml, docker-compose) are included in the public repo. Two deployment paths: managed (Supabase Cloud + Render) and self-hosted (Docker Compose with full Supabase stack).

**Tech Stack:** GitHub Actions, Docker Compose, Render, Supabase CLI

**Depends on:** Phase 2 (Supabase implementation) must be complete. The codebase must have working `DEPLOYMENT_TARGET=supabase` support with adapter pattern in place.

---

## File Structure

```
deploy/
├── render/
│   └── render.yaml              # Render Blueprint (backend + frontend static)
├── docker/
│   ├── docker-compose.yml       # Self-hosted: Supabase stack + app
│   ├── kong.yml                 # Kong API gateway declarative config (auth/rest/edge-functions routing)
│   ├── init/
│   │   └── 00000_init_roles.sh  # Creates PostgreSQL roles (supabase_auth_admin, authenticator, anon)
│   └── .env.example             # Template for all required env vars
└── SETUP.md                     # Deployment guide (managed + self-hosted paths)

.github/workflows/
└── mirror-oss.yml               # Auto-mirror to public OSS repo on push to main

LICENSE                          # Sustainable Use License (n8n-style)
```

---

## Task 3.1: Render Blueprint

**Files:**
- Create: `deploy/render/render.yaml`

The Render Blueprint defines two services: a Python web service for the backend and a static site for the frontend. All Supabase env vars are declared so Render prompts the user during setup.

- [ ] **Step 1: Create `deploy/render/render.yaml`**

```yaml
# Render Blueprint for coJournalist (Supabase edition)
# Deploy: Click "New Blueprint Instance" in Render, point to the OSS repo.
# Docs: https://docs.render.com/infrastructure-as-code

services:
  # --- Backend (FastAPI) ---
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
      # Deployment target — must be "supabase" for OSS
      - key: DEPLOYMENT_TARGET
        value: supabase

      # Supabase connection
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_KEY
        sync: false
      - key: SUPABASE_ANON_KEY
        sync: false
      - key: SUPABASE_JWT_SECRET
        sync: false

      # LLM — Gemini models use direct API, others route to OpenRouter
      - key: GEMINI_API_KEY
        sync: false
      - key: LLM_MODEL
        value: gemini-2.5-flash-lite
      - key: OPENROUTER_API_KEY
        sync: false  # optional — only needed for non-Gemini models

      # Web scraping
      - key: FIRECRAWL_API_KEY
        sync: false

      # Email notifications
      - key: RESEND_API_KEY
        sync: false
      - key: RESEND_FROM_EMAIL
        value: scouts@newsroom.org

      # Social media scraping
      - key: APIFY_API_TOKEN
        sync: false

      # Internal service key (Edge Functions -> FastAPI auth)
      - key: INTERNAL_SERVICE_KEY
        generateValue: true

  # --- Frontend (SvelteKit static SPA) ---
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
      # Build-time: controls auth flow (Supabase Auth vs MuckRock OAuth)
      - key: PUBLIC_DEPLOYMENT_TARGET
        value: supabase
      - key: PUBLIC_SUPABASE_URL
        sync: false
      - key: PUBLIC_SUPABASE_ANON_KEY
        sync: false
      # Geocoding
      - key: PUBLIC_MAPTILER_API_KEY
        sync: false
    routes:
      # Proxy API requests to the backend service
      - type: rewrite
        source: /api/*
        destination: https://cojournalist-api.onrender.com/api/*
```

- [ ] **Step 2: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('deploy/render/render.yaml'))" && echo "YAML valid"
```

Expected: `YAML valid`

- [ ] **Step 3: Commit**

```bash
git add deploy/render/render.yaml
git commit -m "deploy: add Render Blueprint for Supabase deployment"
```

---

## Task 3.2: Docker Compose for Self-Hosted

**Files:**
- Create: `deploy/docker/docker-compose.yml`
- Create: `deploy/docker/.env.example`

Full self-hosted stack: Supabase services (postgres, gotrue, postgrest, edge-runtime, kong) plus the coJournalist backend and frontend. Based on the spec Section 6 skeleton, expanded with all required configuration.

- [ ] **Step 1: Create `deploy/docker/.env.example`**

```bash
# =============================================================================
# coJournalist Self-Hosted Environment Variables
# =============================================================================
# Copy this file to .env and fill in all values before running docker-compose.
#
# Required: All variables without defaults must be set.
# Optional: Variables with defaults can be overridden.
# =============================================================================

# --- Postgres ---
POSTGRES_PASSWORD=change-me-to-a-strong-password

# --- Supabase Auth (GoTrue) ---
# Generate with: openssl rand -hex 32
SUPABASE_JWT_SECRET=change-me-generate-with-openssl-rand-hex-32
SUPABASE_ANON_KEY=generate-via-supabase-cli-or-jwt-tool
SUPABASE_SERVICE_KEY=generate-via-supabase-cli-or-jwt-tool

# Site URL for auth redirects (your public-facing URL)
SITE_URL=http://localhost:3000

# --- Supabase API ---
# Internal URL used by backend to reach Supabase services
SUPABASE_URL=http://kong:8000

# --- LLM ---
# Gemini models use direct API; others route to OpenRouter
GEMINI_API_KEY=
LLM_MODEL=gemini-2.5-flash-lite
# Optional: only needed for non-Gemini models
OPENROUTER_API_KEY=

# --- Web Scraping ---
FIRECRAWL_API_KEY=

# --- Email Notifications ---
RESEND_API_KEY=
RESEND_FROM_EMAIL=scouts@newsroom.org

# --- Social Media Scraping ---
APIFY_API_TOKEN=

# --- Geocoding ---
PUBLIC_MAPTILER_API_KEY=

# --- Internal Service Key ---
# Used for Edge Functions -> FastAPI auth. Generate with: openssl rand -hex 32
INTERNAL_SERVICE_KEY=change-me-generate-with-openssl-rand-hex-32
```

- [ ] **Step 2: Create `deploy/docker/docker-compose.yml`**

```yaml
# coJournalist Self-Hosted Stack
#
# Usage:
#   1. Copy .env.example to .env and fill in all values
#   2. Run: docker compose up -d
#   3. Run migrations: docker compose exec db psql -U postgres -f /migrations/001_initial.sql
#   4. Open http://localhost:3000
#
# Architecture:
#   kong (API gateway) -> auth (GoTrue) + rest (PostgREST) + edge-functions
#   backend (FastAPI) -> db (PostgreSQL) directly via DATABASE_URL
#   frontend (SvelteKit) -> kong (for Supabase client) + backend (for API)

services:
  # =========================================================================
  # Supabase Core
  # =========================================================================

  db:
    image: supabase/postgres:15.6.1.143
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: postgres
      # Enable required extensions at init
      POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256
    volumes:
      - db-data:/var/lib/postgresql/data
      - ../../supabase/migrations:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  auth:
    image: supabase/gotrue:v2.170.0
    depends_on:
      db:
        condition: service_healthy
    environment:
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:${POSTGRES_PASSWORD}@db:5432/postgres
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_JWT_SECRET: ${SUPABASE_JWT_SECRET}
      GOTRUE_JWT_EXP: 3600
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_API_HOST: 0.0.0.0
      API_EXTERNAL_URL: ${SITE_URL}
      GOTRUE_SITE_URL: ${SITE_URL}
      GOTRUE_MAILER_AUTOCONFIRM: "true"
      GOTRUE_DISABLE_SIGNUP: "false"
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
    restart: unless-stopped

  rest:
    image: postgrest/postgrest:v12.2.8
    depends_on:
      db:
        condition: service_healthy
    environment:
      PGRST_DB_URI: postgres://authenticator:${POSTGRES_PASSWORD}@db:5432/postgres
      PGRST_DB_SCHEMAS: public,storage
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: ${SUPABASE_JWT_SECRET}
      PGRST_DB_USE_LEGACY_GUCS: "false"
    restart: unless-stopped

  edge-functions:
    image: supabase/edge-runtime:v1.67.4
    depends_on:
      db:
        condition: service_healthy
    environment:
      SUPABASE_URL: http://kong:8000
      SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY}
      SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_KEY}
      SUPABASE_DB_URL: postgres://postgres:${POSTGRES_PASSWORD}@db:5432/postgres
      INTERNAL_SERVICE_KEY: ${INTERNAL_SERVICE_KEY}
      VERIFY_JWT: "false"
    volumes:
      - ../../supabase/functions:/home/deno/functions
    restart: unless-stopped

  kong:
    image: kong:3.8
    depends_on:
      - auth
      - rest
      - edge-functions
    ports:
      - "8000:8000"
    environment:
      KONG_DATABASE: "off"
      KONG_DECLARATIVE_CONFIG: /kong/kong.yml
      KONG_DNS_ORDER: LAST,A,CNAME
      KONG_PLUGINS: request-transformer,cors,key-auth,acl
      KONG_PROXY_ACCESS_LOG: /dev/stdout
      KONG_PROXY_ERROR_LOG: /dev/stderr
      SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY}
      SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY}
    volumes:
      - ./kong.yml:/kong/kong.yml:ro
    restart: unless-stopped

  # =========================================================================
  # Application
  # =========================================================================

  backend:
    build:
      context: ../../backend
      dockerfile: Dockerfile.dev
    depends_on:
      db:
        condition: service_healthy
      auth:
        condition: service_started
    ports:
      - "8080:8000"
    environment:
      DEPLOYMENT_TARGET: supabase
      SUPABASE_URL: http://kong:8000
      SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY}
      SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY}
      SUPABASE_JWT_SECRET: ${SUPABASE_JWT_SECRET}
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@db:5432/postgres
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      LLM_MODEL: ${LLM_MODEL:-gemini-2.5-flash-lite}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      FIRECRAWL_API_KEY: ${FIRECRAWL_API_KEY}
      RESEND_API_KEY: ${RESEND_API_KEY}
      RESEND_FROM_EMAIL: ${RESEND_FROM_EMAIL:-scouts@newsroom.org}
      APIFY_API_TOKEN: ${APIFY_API_TOKEN}
      INTERNAL_SERVICE_KEY: ${INTERNAL_SERVICE_KEY}
    restart: unless-stopped

  frontend:
    build:
      context: ../../frontend
      dockerfile: Dockerfile.dev
      args:
        PUBLIC_DEPLOYMENT_TARGET: supabase
        PUBLIC_SUPABASE_URL: http://localhost:8000
        PUBLIC_SUPABASE_ANON_KEY: ${SUPABASE_ANON_KEY}
        PUBLIC_MAPTILER_API_KEY: ${PUBLIC_MAPTILER_API_KEY:-}
    depends_on:
      - backend
    ports:
      - "3000:3000"
    restart: unless-stopped

volumes:
  db-data:
```

- [ ] **Step 3: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('deploy/docker/docker-compose.yml'))" && echo "YAML valid"
```

Expected: `YAML valid`

- [ ] **Step 4: Commit**

```bash
git add deploy/docker/docker-compose.yml deploy/docker/.env.example
git commit -m "deploy: add Docker Compose stack for self-hosted deployment"
```

---

## Task 3.3: Create OSS Repo & Sustainable Use License

**Files:**
- Create: `LICENSE` (in repo root)

The public OSS repo is created via `gh`, and the Sustainable Use License (modeled after n8n's) is added to the private dev repo root. The mirror action will copy it to the public repo.

- [ ] **Step 1: Create the public GitHub repo**

```bash
gh repo create buriedsignals/scoutpost-os \
  --public \
  --description "AI-powered local news monitoring for newsrooms. Self-hosted on Supabase." \
  --homepage "https://www.scoutpost.ai"
```

Expected: `https://github.com/buriedsignals/scoutpost-os`

- [ ] **Step 2: Create the Sustainable Use License**

Create `LICENSE` in the repo root. This is modeled after n8n's Sustainable Use License, adapted for coJournalist.

```text
Sustainable Use License
Version 1.0

Copyright (c) 2026 Buried Signals

Permission is hereby granted, free of charge, to any person or organization
("Licensee") obtaining a copy of this software and associated documentation
files (the "Software"), to use, copy, modify, and distribute the Software,
subject to the following conditions:

1. PERMITTED USE

   The Licensee may use the Software for any purpose, including commercial
   internal use within a single organization (e.g., a newsroom deploying
   the Software for its own journalists and editors), subject to the
   restrictions in Section 2.

2. RESTRICTIONS

   The Licensee SHALL NOT:

   a) Offer the Software, or any derivative work based on the Software,
      as a hosted or managed service to third parties (i.e., operate it as
      a service bureau, SaaS platform, or "as-a-service" offering where
      third parties access the functionality of the Software).

   b) Remove or obscure any licensing, copyright, or attribution notices
      from the Software.

   c) Sell, resell, sublicense, or distribute the Software or derivative
      works as a standalone product to third parties.

   d) White-label, rebrand, or otherwise present the Software as the
      Licensee's own product for external distribution.

3. AUTOMATION SCRIPTS

   The automation scripts included in the "automation/" directory
   (setup.sh, sync-upstream.yml, SETUP_AGENT.md) require a valid
   license key for automated execution. Manual execution of the steps
   described in these scripts does not require a license key. The
   application itself does not require a license key for any functionality.

4. CONTRIBUTIONS

   Contributions to the Software (e.g., pull requests) are welcome and
   will be licensed under this same Sustainable Use License unless
   otherwise agreed in writing.

5. DISCLAIMER

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
   IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
   CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
   SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

6. TERMINATION

   This license is effective until terminated. It will terminate
   automatically if the Licensee fails to comply with any term of this
   license. Upon termination, the Licensee must destroy all copies of the
   Software in their possession.
```

- [ ] **Step 3: Add MIRROR_PAT secret to the private repo**

This is a manual step. Create a GitHub Personal Access Token (PAT) with `repo` scope for the `buriedsignals` account, then add it as a repository secret.

```bash
# Manual: Go to GitHub Settings -> Developer Settings -> Personal Access Tokens
# Create a fine-grained token with:
#   - Repository access: buriedsignals/scoutpost-os (write)
#   - Permissions: Contents (read/write)
#
# Then add it as a secret to the private dev repo:
gh secret set MIRROR_PAT --repo buriedsignals/cojournalist
# Paste the token when prompted
```

- [ ] **Step 4: Commit license**

```bash
git add LICENSE
git commit -m "legal: add Sustainable Use License"
```

---

## Task 3.4: Mirror GitHub Action

**Files:**
- Create: `.github/workflows/mirror-oss.yml`

The mirror action runs on every push to `main` in the private dev repo. It strips AWS/MuckRock/billing code, validates the stripped codebase boots with `DEPLOYMENT_TARGET=supabase`, and pushes to the public OSS repo.

- [ ] **Step 1: Create `.github/workflows/mirror-oss.yml`**

```yaml
name: Mirror to OSS Repo

on:
  push:
    branches: [main]

jobs:
  mirror:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout private repo
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Strip SaaS-only code
        run: |
          # ---------------------------------------------------------------
          # Remove AWS infrastructure (SaaS only)
          # ---------------------------------------------------------------
          rm -rf aws/

          # Remove AWS adapter (SaaS DynamoDB/EventBridge implementation)
          rm -rf backend/app/adapters/aws/

          # ---------------------------------------------------------------
          # Remove SaaS-only auth (MuckRock OAuth)
          # ---------------------------------------------------------------
          rm -f backend/app/routers/auth.py
          rm -f backend/app/services/muckrock_client.py

          # ---------------------------------------------------------------
          # Remove SaaS-only billing and credit management
          # ---------------------------------------------------------------
          rm -f backend/app/utils/credits.py
          rm -f backend/app/services/cron.py
          rm -f backend/app/services/seed_data_service.py

          # ---------------------------------------------------------------
          # Remove CI workflows that reference the dev repo
          # ---------------------------------------------------------------
          rm -f .github/workflows/mirror-*.yml
          rm -f .github/workflows/claude*.yml

          # ---------------------------------------------------------------
          # Keep everything else:
          #   deploy/, automation/, supabase/, all features,
          #   all scout types, all 12 languages, v1 API,
          #   api_key_service, LICENSE
          # ---------------------------------------------------------------

          # ---------------------------------------------------------------
          # Replace auth system (MuckRock OAuth → Supabase Auth)
          # ---------------------------------------------------------------
          # Rewrite auth.ts to import from auth-supabase instead of auth-muckrock
          cat > frontend/src/lib/stores/auth.ts << 'AUTHEOF'
          ...Supabase auth store re-exports...
          AUTHEOF
          rm -f frontend/src/lib/stores/auth-muckrock.ts

          # Replace MuckRock login page with Supabase email/password login
          rm -rf frontend/src/routes/login/
          mv frontend/src/routes/login-supabase/ frontend/src/routes/login/

          # Fix layout and setup page references to /pricing (doesn't exist in OSS)
          sed -i "s|'/login', '/pricing', '/setup'|'/login', '/setup'|" frontend/src/routes/+layout.svelte
          sed -i 's|href="/pricing"|href="/"|' frontend/src/routes/setup/+page.svelte

          # Validate: no MuckRock or /pricing references remain
          if grep -ri "muckrock" frontend/src/lib/stores/ frontend/src/routes/login/; then
            echo "ERROR: MuckRock references found in OSS build"; exit 1
          fi
          if grep -r "'/pricing'" frontend/src/; then
            echo "ERROR: /pricing references found in OSS build"; exit 1
          fi

          echo "Stripped files:"
          echo "  - aws/ (Lambda functions, infrastructure)"
          echo "  - backend/app/adapters/aws/ (DynamoDB/EventBridge adapters)"
          echo "  - backend/app/routers/auth.py (MuckRock OAuth)"
          echo "  - backend/app/services/muckrock_client.py"
          echo "  - backend/app/utils/credits.py"
          echo "  - backend/app/services/cron.py"
          echo "  - backend/app/services/seed_data_service.py"
          echo "  - .github/workflows/mirror-*.yml"
          echo "  - .github/workflows/claude*.yml"
          echo "  - frontend/src/lib/stores/auth-muckrock.ts (replaced with Supabase)"
          echo "  - frontend/src/routes/login/ (replaced with Supabase login)"

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Validate stripped codebase
        run: |
          cd backend
          pip install -r requirements.txt
          DEPLOYMENT_TARGET=supabase python -c "from app.main import app; print('App boots OK')"

      - name: Push to OSS repo
        uses: cpina/github-action-push-to-another-repository@v1
        env:
          API_TOKEN_GITHUB: ${{ secrets.MIRROR_PAT }}
        with:
          source-directory: .
          destination-github-username: buriedsignals
          destination-repository-name: scoutpost-os
          target-branch: main
          create-target-branch-if-needed: true
          commit-message: "mirror: sync from upstream (${{ github.sha }})"
```

- [ ] **Step 2: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/mirror-oss.yml'))" && echo "YAML valid"
```

Expected: `YAML valid`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/mirror-oss.yml
git commit -m "ci: add OSS mirror pipeline (strips AWS/MuckRock code)"
```

---

## Task 3.5: Setup Documentation

**Files:**
- Create: `deploy/SETUP.md`

Two deployment paths: managed (Supabase Cloud + Render) and self-hosted (Docker Compose). Step-by-step instructions for each.

- [ ] **Step 1: Create `deploy/SETUP.md`**

```markdown
# coJournalist Deployment Guide

Two deployment paths: **Managed** (Supabase Cloud + Render) and **Self-Hosted** (Docker Compose). Both run the same code.

**Estimated time:** 1-2 hours with API keys ready. With a license key, `automation/setup.sh` automates most steps.

---

## Prerequisites

Before starting either path, you need API keys for external services:

| Service | Purpose | Get it at |
|---------|---------|-----------|
| **Gemini** | LLM + embeddings (required) | [aistudio.google.com](https://aistudio.google.com) |
| **Firecrawl** | Web scraping (required) | [firecrawl.dev](https://www.firecrawl.dev) |
| **Resend** | Email notifications (required) | [resend.com](https://resend.com) |
| **Apify** | Social media scraping (required for Social Scout) | [apify.com](https://www.apify.com) |
| **MapTiler** | Geocoding/location scouts | [maptiler.com](https://www.maptiler.com) |
| **OpenRouter** | Alternative LLMs (optional) | [openrouter.ai](https://openrouter.ai) |

---

## Path 1: Managed (Supabase Cloud + Render)

Best for: Newsrooms that want minimal infrastructure management.

### 1.1 Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your project URL, anon key, service role key, and JWT secret (Settings -> API)
3. Enable the required extensions in SQL Editor:

```sql
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_cron";
CREATE EXTENSION IF NOT EXISTS "pg_net";
```

### 1.2 Run Migrations

In the Supabase SQL Editor, run each migration file from `supabase/migrations/` in order. The files are numbered sequentially (e.g., `001_initial.sql`, `002_indexes.sql`).

Alternatively, use the Supabase CLI:

```bash
supabase db push --project-ref YOUR_PROJECT_REF
```

### 1.3 Deploy Edge Functions

```bash
supabase functions deploy execute-scout --project-ref YOUR_PROJECT_REF
supabase functions deploy manage-schedule --project-ref YOUR_PROJECT_REF
```

Set the Edge Function secrets:

```bash
supabase secrets set INTERNAL_SERVICE_KEY=your-service-key --project-ref YOUR_PROJECT_REF
```

### 1.4 Deploy to Render

1. Fork the `buriedsignals/scoutpost-os` repo to your GitHub account
2. Go to [render.com](https://render.com) -> "New Blueprint Instance"
3. Connect your forked repo
4. Render reads `deploy/render/render.yaml` and creates both services
5. Fill in the environment variables when prompted:
   - `SUPABASE_URL`: Your Supabase project URL
   - `SUPABASE_SERVICE_KEY`: Service role key
   - `SUPABASE_ANON_KEY`: Anon key
   - `SUPABASE_JWT_SECRET`: JWT secret
   - `GEMINI_API_KEY`, `FIRECRAWL_API_KEY`, `RESEND_API_KEY`, `APIFY_API_TOKEN`
   - `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` (for frontend)
   - `PUBLIC_MAPTILER_API_KEY`

### 1.5 Verify

```bash
curl https://your-render-url.onrender.com/api/health
```

Expected: `{"status": "healthy"}`

---

## Path 2: Self-Hosted (Docker Compose)

Best for: Newsrooms with Docker infrastructure or wanting full control.

### 2.1 Clone and Configure

```bash
git clone https://github.com/buriedsignals/scoutpost-os.git
cd scoutpost-os/deploy/docker
cp .env.example .env
```

Edit `.env` with your API keys and generated secrets:

```bash
# Generate secrets
openssl rand -hex 32  # Use for SUPABASE_JWT_SECRET
openssl rand -hex 32  # Use for INTERNAL_SERVICE_KEY
openssl rand -hex 32  # Use for POSTGRES_PASSWORD
```

### 2.2 Generate Supabase Keys

The anon and service role keys are JWTs signed with your `SUPABASE_JWT_SECRET`. Generate them:

```bash
# Install supabase CLI if needed: npm install -g supabase
# Or generate JWTs manually — see https://supabase.com/docs/guides/self-hosting

# Anon key payload: {"role": "anon", "iss": "supabase", "iat": ..., "exp": ...}
# Service key payload: {"role": "service_role", "iss": "supabase", "iat": ..., "exp": ...}
```

Add the generated keys to `.env` as `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_KEY`.

### 2.3 Start the Stack

```bash
docker compose up -d
```

Wait for all services to be healthy:

```bash
docker compose ps
```

All services should show `Up` status.

### 2.4 Run Migrations

```bash
docker compose exec db psql -U postgres -d postgres \
  -f /docker-entrypoint-initdb.d/001_initial.sql
```

Repeat for each migration file in sequence.

### 2.5 Verify

```bash
curl http://localhost:8080/api/health
```

Expected: `{"status": "healthy"}`

Open http://localhost:3000 in your browser to access the frontend.

---

## Automated Setup (License Key Required)

If you have a coJournalist license key, the setup can be automated:

```bash
export COJOURNALIST_LICENSE_KEY="cjl_your-key-here"
bash automation/setup.sh
```

This handles forking, API key collection, migration, deployment, and verification. See `automation/SETUP_AGENT.md` for AI-assisted setup.

---

## Updating

### With License Key (Automatic)

The `sync-upstream.yml` GitHub Action runs weekly and:
1. Validates your license key
2. Fetches updates from the upstream OSS repo
3. Runs any new database migrations
4. Triggers a Render deploy (or rebuilds Docker containers)

### Without License Key (Manual)

```bash
git remote add upstream https://github.com/buriedsignals/scoutpost-os.git
git fetch upstream
git merge upstream/main
# Check for new files in supabase/migrations/ and run them
# Restart services
```
```

- [ ] **Step 2: Commit**

```bash
git add deploy/SETUP.md
git commit -m "docs: add deployment guide (managed + self-hosted paths)"
```

---

## Task 3.6: Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Verify file structure**

```bash
ls deploy/render/render.yaml
ls deploy/docker/docker-compose.yml
ls deploy/docker/.env.example
ls deploy/SETUP.md
ls .github/workflows/mirror-oss.yml
ls LICENSE
```

All six files should exist.

- [ ] **Step 2: Validate all YAML files parse correctly**

```bash
python3 -c "
import yaml
files = [
    'deploy/render/render.yaml',
    'deploy/docker/docker-compose.yml',
    '.github/workflows/mirror-oss.yml',
]
for f in files:
    yaml.safe_load(open(f))
    print(f'{f}: OK')
print('All YAML files valid')
"
```

Expected: All three files report OK.

- [ ] **Step 3: Verify OSS repo exists (if created)**

```bash
gh repo view buriedsignals/scoutpost-os --json name,visibility
```

Expected: `{"name":"scoutpost-os","visibility":"PUBLIC"}`

- [ ] **Step 4: Verify .env.example covers all docker-compose env vars**

```bash
# Extract env var names from docker-compose and check they appear in .env.example
cd deploy/docker
grep -oP '\$\{([A-Z_]+)' docker-compose.yml | sort -u | sed 's/\${//' | while read var; do
  if grep -q "^${var}=" .env.example; then
    echo "OK: $var"
  else
    echo "MISSING: $var"
  fi
done
```

Expected: All variables show `OK`.

- [ ] **Step 5: Verify mirror action strip list matches spec**

The spec (Section 1) lists these items to strip:
- `aws/` -- Lambda functions, infrastructure
- `backend/app/adapters/aws/` -- DynamoDB/EventBridge adapters
- `backend/app/routers/auth.py` -- MuckRock OAuth
- `backend/app/services/muckrock_client.py`
- `backend/app/utils/credits.py` -- SaaS billing
- `backend/app/services/cron.py` -- EventBridge cron
- `backend/app/services/seed_data_service.py` -- SaaS seed data
- `.github/workflows/mirror-*.yml` -- Mirror workflows
- `.github/workflows/claude*.yml` -- Claude workflows

Verify all are present in the `rm` commands in `mirror-oss.yml`:

```bash
grep -c "rm " .github/workflows/mirror-oss.yml
```

Expected: 9 (matching the 9 items above, some using `-rf`, some using `-f`)

- [ ] **Step 6: Commit milestone**

```bash
git commit --allow-empty -m "milestone: Phase 3 complete — deploy configs and mirror pipeline ready"
```

---

## Task Dependency Graph

```
3.1 (render.yaml) ─────────────────────────┐
                                            │
3.2 (docker-compose + .env.example) ────────┤
                                            ├── 3.6 (verification)
3.3 (OSS repo + license) ──── 3.4 (mirror) ┤
                                            │
3.5 (SETUP.md) ─────────────────────────────┘
```

Tasks 3.1, 3.2, 3.3, and 3.5 can run in parallel. Task 3.4 depends on 3.3 (the OSS repo must exist). Task 3.6 depends on all others.
