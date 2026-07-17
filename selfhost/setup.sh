#!/usr/bin/env bash
# =============================================================================
# Scoutpost Setup Script
# =============================================================================
#
# Automated bootstrap for deploying Scoutpost on Supabase plus either
# static hosting + optional Render FastAPI add-on, or full Docker self-hosting.
# No license key required — the repository is public and self-hosting is free
# under the Sustainable Use License.
#
# Usage:
#   bash setup.sh
#
# What this script does:
#   1. Forks the OSS repo to your GitHub account
#   2. Collects API keys interactively
#   3. Initializes Supabase project (or connects to existing)
#   4. Runs database migrations
#   5. Deploys Edge Functions
#   6. Writes .env configuration
#   7. Deploys to Render or starts Docker Compose
#   8. Installs sync-upstream.yml GitHub Action
#   9. Runs health check
#
# =============================================================================
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Upstream OSS repo
UPSTREAM_REPO="buriedsignals/scoutpost-os"

# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

prompt_required() {
    local var_name="$1"
    local prompt_text="$2"
    local value=""

    while [ -z "$value" ]; do
        read -rp "  $prompt_text: " value
        if [ -z "$value" ]; then
            echo "    This field is required."
        fi
    done
    eval "$var_name='$value'"
}

prompt_optional() {
    local var_name="$1"
    local prompt_text="$2"
    local default_value="${3:-}"
    local value=""

    if [ -n "$default_value" ]; then
        read -rp "  $prompt_text [$default_value]: " value
        value="${value:-$default_value}"
    else
        read -rp "  $prompt_text (optional, press Enter to skip): " value
    fi
    eval "$var_name='$value'"
}

sql_literal() {
    printf "%s" "$1" | sed "s/'/''/g"
}

check_command() {
    if ! command -v "$1" &>/dev/null; then
        log_error "$1 is required but not installed."
        echo "  Install it: $2"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Step 1: Check prerequisites
# ---------------------------------------------------------------------------

check_prerequisites() {
    log_info "Checking prerequisites..."

    check_command "git" "https://git-scm.com/downloads"
    check_command "gh" "brew install gh (macOS) or https://cli.github.com"
    check_command "curl" "should be pre-installed on most systems"
    check_command "jq" "brew install jq (macOS) or apt install jq (Linux)"

    # Check gh auth status
    if ! gh auth status &>/dev/null; then
        log_error "GitHub CLI not authenticated. Run: gh auth login"
        exit 1
    fi

    log_success "All prerequisites met"
}

# ---------------------------------------------------------------------------
# Step 3: Fork the OSS repo
# ---------------------------------------------------------------------------

fork_repo() {
    log_info "Forking the Scoutpost OSS repo..."

    # Check if fork already exists
    GH_USER=$(gh api user --jq '.login')

    if gh repo view "${GH_USER}/scoutpost-os" &>/dev/null; then
        log_warn "Fork already exists: ${GH_USER}/scoutpost-os"
        read -rp "  Use existing fork? (y/n): " use_existing
        if [ "$use_existing" != "y" ]; then
            log_error "Please delete the existing fork first, then re-run setup."
            exit 1
        fi
    else
        gh repo fork "${UPSTREAM_REPO}" --clone=false
        log_success "Forked to ${GH_USER}/scoutpost-os"
    fi

    # Clone the fork
    REPO_DIR="scoutpost-os"
    if [ -d "$REPO_DIR" ]; then
        log_warn "Directory ${REPO_DIR} already exists. Using it."
    else
        gh repo clone "${GH_USER}/scoutpost-os"
        log_success "Cloned to ./${REPO_DIR}"
    fi

    cd "$REPO_DIR"
    git checkout master

    # Set upstream remote
    if ! git remote get-url upstream &>/dev/null; then
        git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
    fi

    log_success "Repository ready"
}

# ---------------------------------------------------------------------------
# Step 4: Collect API keys
# ---------------------------------------------------------------------------

collect_api_keys() {
    log_info "Collecting API keys..."
    echo ""
    echo "  You need API keys for the following services."
    echo "  Sign up at the URLs below if you don't have accounts yet."
    echo ""

    echo "  -- Required --"
    echo ""

    echo "  OpenRouter (Google Vertex extraction + scanned-PDF fallback): https://openrouter.ai/keys"
    prompt_required OPENROUTER_API_KEY "OpenRouter API key"

    echo ""
    echo "  Firecrawl (web scraping): https://www.firecrawl.dev"
    prompt_required FIRECRAWL_API_KEY "Firecrawl API key"

    echo ""
    echo "  Resend (email notifications): https://resend.com"
    prompt_required RESEND_API_KEY "Resend API key"

    echo ""
    echo "  Apify (social media scraping): https://www.apify.com"
    prompt_required APIFY_API_TOKEN "Apify API token"

    echo ""
    echo "  -- Optional --"
    echo ""

    echo "  MapTiler (geocoding/location): https://www.maptiler.com"
    prompt_required PUBLIC_MAPTILER_API_KEY "MapTiler API key"

    echo ""
    prompt_optional RESEND_FROM_EMAIL "Notification sender email" "scouts@newsroom.org"

    prompt_optional LLM_MODEL "LLM model" "google/gemini-2.5-flash-lite"
    case "$LLM_MODEL" in
        google/*) ;;
        *) die "LLM_MODEL must use the google/ namespace because Scoutpost pins Google Vertex." ;;
    esac

    echo ""
    echo "  -- Signup controls --"
    prompt_required ADMIN_EMAILS "Admin email"
    prompt_required SIGNUP_ALLOWED_DOMAINS "Allowed signup domains (comma-separated, e.g. example.com,newsroom.org)"

    log_success "API keys collected"
}

# ---------------------------------------------------------------------------
# Step 5: Supabase setup
# ---------------------------------------------------------------------------

setup_supabase() {
    log_info "Setting up Supabase..."
    echo ""
    echo "  Choose your Supabase deployment:"
    echo "  1) Managed (Supabase Cloud) -- recommended"
    echo "  2) Self-hosted (Docker, already running)"
    echo ""
    read -rp "  Choice (1 or 2): " supabase_choice

    if [ "$supabase_choice" = "1" ]; then
        setup_supabase_managed
    elif [ "$supabase_choice" = "2" ]; then
        setup_supabase_selfhosted
    else
        log_error "Invalid choice. Please enter 1 or 2."
        exit 1
    fi
}

setup_supabase_managed() {
    log_info "Configuring managed Supabase..."

    # Check for Supabase CLI
    if command -v supabase &>/dev/null; then
        SUPABASE_CLI="supabase"
    elif command -v npx &>/dev/null; then
        SUPABASE_CLI="npx supabase"
    else
        log_error "Supabase CLI not found. Install: npm install -g supabase"
        exit 1
    fi

    echo ""
    echo "  Go to https://supabase.com and create a new project (or use existing)."
    echo "  Then find these values in Settings -> API:"
    echo ""

    prompt_required SUPABASE_URL "Supabase project URL (e.g., https://xxx.supabase.co)"
    prompt_required SUPABASE_ANON_KEY "Supabase anon key"
    prompt_required SUPABASE_SERVICE_KEY "Supabase service role key"
    prompt_required SUPABASE_JWT_SECRET "Supabase JWT secret"

    echo ""
    prompt_required SUPABASE_PROJECT_REF "Supabase project ref (from URL, e.g., abcdefghij)"
    prompt_required EMBEDDING_SERVICE_URL "Public EmbeddingGemma service URL"
    EMBEDDING_SERVICE_URL="${EMBEDDING_SERVICE_URL%/}"

    # Link the Supabase CLI to the project
    log_info "Linking Supabase CLI to project..."
    $SUPABASE_CLI link --project-ref "$SUPABASE_PROJECT_REF"

    # Enable required extensions
    log_info "Enabling PostgreSQL extensions..."
    $SUPABASE_CLI db execute --sql "CREATE EXTENSION IF NOT EXISTS \"vector\";"
    $SUPABASE_CLI db execute --sql "CREATE EXTENSION IF NOT EXISTS \"pg_cron\";"
    $SUPABASE_CLI db execute --sql "CREATE EXTENSION IF NOT EXISTS \"pg_net\";"
    log_success "Extensions enabled"

    # Provision credentials before activating any OpenRouter-only function.
    $SUPABASE_CLI secrets set \
        "INTERNAL_SERVICE_KEY=${INTERNAL_SERVICE_KEY}" \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "EMBEDDING_SERVICE_URL=${EMBEDDING_SERVICE_URL}" \
        "EMBEDDING_SERVICE_TOKEN=${EMBEDDING_SERVICE_TOKEN}" \
        "FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}" \
        "RESEND_API_KEY=${RESEND_API_KEY}" \
        "RESEND_FROM_EMAIL=${RESEND_FROM_EMAIL}" \
        "APIFY_API_TOKEN=${APIFY_API_TOKEN}" \
        "PUBLIC_MAPTILER_API_KEY=${PUBLIC_MAPTILER_API_KEY}" \
        "ADMIN_EMAILS=${ADMIN_EMAILS}"
    log_success "Edge Function secrets provisioned"

    # Run migrations
    log_info "Running database migrations..."
    $SUPABASE_CLI db push
    log_success "Migrations applied"

    # Seed signup allowlist for the before-user-created auth hook.
    log_info "Seeding signup allowlist..."
    IFS=',' read -r -a allowed_domains <<< "$SIGNUP_ALLOWED_DOMAINS"
    for domain in "${allowed_domains[@]}"; do
        clean_domain="$(printf "%s" "$domain" | tr '[:upper:]' '[:lower:]' | sed 's/^@//' | xargs)"
        if [ -n "$clean_domain" ]; then
            SUPABASE_URL="$SUPABASE_URL" \
            SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_KEY" \
                selfhost/adopt-signup-allowlist.sh \
                    --admin "$ADMIN_EMAILS" \
                    --domain "$clean_domain" \
                    --project-ref "$SUPABASE_PROJECT_REF"
        fi
    done
    log_success "Signup allowlist seeded"

    # Deploy Edge Functions
    log_info "Deploying Edge Functions..."
    $SUPABASE_CLI functions deploy --all
    log_success "Edge Functions deployed"

    log_info "Seeding Supabase Vault secrets..."
    PROJECT_URL_SQL="$(sql_literal "$SUPABASE_URL")"
    INTERNAL_KEY_SQL="$(sql_literal "$INTERNAL_SERVICE_KEY")"
    $SUPABASE_CLI db execute --sql "
        SELECT vault.create_secret('${PROJECT_URL_SQL}', 'project_url')
        WHERE NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url');
        SELECT vault.create_secret('${INTERNAL_KEY_SQL}', 'internal_service_key')
        WHERE NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
    " || log_warn "Could not seed Vault secrets automatically. Create project_url and internal_service_key in Supabase Vault before scheduling scouts."

    DEPLOY_MODE="managed"
}

setup_supabase_selfhosted() {
    log_info "Configuring self-hosted Supabase..."
    echo ""
    echo "  Enter the connection details for your self-hosted Supabase instance."
    echo ""

    prompt_required SUPABASE_URL "Supabase URL (e.g., http://localhost:8000)"
    prompt_required SUPABASE_ANON_KEY "Supabase anon key"
    prompt_required SUPABASE_SERVICE_KEY "Supabase service role key"
    prompt_required SUPABASE_JWT_SECRET "Supabase JWT secret"
    prompt_required POSTGRES_PASSWORD "PostgreSQL password"
    EMBEDDING_SERVICE_URL="http://embedding-service:8080"

    # Run migrations directly against the database
    log_info "Running database migrations..."
    DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@localhost:5432/postgres"

    for migration in supabase/migrations/*.sql; do
        if [ -f "$migration" ]; then
            log_info "Applying $(basename "$migration")..."
            psql "$DATABASE_URL" -f "$migration"
        fi
    done
    log_success "Migrations applied"

    DEPLOY_MODE="selfhosted"
}

# ---------------------------------------------------------------------------
# Step 6: Generate internal service key
# ---------------------------------------------------------------------------

generate_service_key() {
    INTERNAL_SERVICE_KEY=$(openssl rand -hex 32)
    EMBEDDING_SERVICE_TOKEN=$(openssl rand -hex 32)
    log_success "Generated internal service keys"
}

# ---------------------------------------------------------------------------
# Step 7: Write .env file
# ---------------------------------------------------------------------------

write_env_file() {
    log_info "Writing .env file..."

    cat > .env << ENVEOF
# =============================================================================
# Scoutpost Configuration
# Generated by setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# =============================================================================

# Deployment target
DEPLOYMENT_TARGET=supabase

# Supabase
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET}

# LLM
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
LLM_MODEL=${LLM_MODEL}
EMBEDDING_SERVICE_URL=${EMBEDDING_SERVICE_URL}
EMBEDDING_SERVICE_TOKEN=${EMBEDDING_SERVICE_TOKEN}

# Web scraping
FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}

# Email
RESEND_API_KEY=${RESEND_API_KEY}
RESEND_FROM_EMAIL=${RESEND_FROM_EMAIL}

# Social media
APIFY_API_TOKEN=${APIFY_API_TOKEN}

# Geocoding
PUBLIC_MAPTILER_API_KEY=${PUBLIC_MAPTILER_API_KEY}

# Signup controls
ADMIN_EMAILS=${ADMIN_EMAILS}
SIGNUP_ALLOWED_DOMAINS=${SIGNUP_ALLOWED_DOMAINS}

# Internal
INTERNAL_SERVICE_KEY=${INTERNAL_SERVICE_KEY}

# Frontend build-time vars
PUBLIC_DEPLOYMENT_TARGET=supabase
PUBLIC_SUPABASE_URL=${SUPABASE_URL}
PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
VITE_API_URL=${SUPABASE_URL}/functions/v1
PUBLIC_MUCKROCK_ENABLED=false
PUBLIC_LOCAL_DEMO_MODE=false
ENVEOF

    if [ "${DEPLOY_MODE}" = "selfhosted" ]; then
        cat >> .env << ENVEOF

# Self-hosted only
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@db:5432/postgres
ENVEOF
    fi

    cat > frontend/.env.production << ENVEOF
PUBLIC_DEPLOYMENT_TARGET=supabase
PUBLIC_SUPABASE_URL=${SUPABASE_URL}
PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
VITE_API_URL=${SUPABASE_URL}/functions/v1
PUBLIC_MAPTILER_API_KEY=${PUBLIC_MAPTILER_API_KEY}
PUBLIC_MUCKROCK_ENABLED=false
PUBLIC_LOCAL_DEMO_MODE=false
ENVEOF

    log_success ".env file written"
}

# ---------------------------------------------------------------------------
# Step 8: Deploy
# ---------------------------------------------------------------------------

deploy() {
    log_info "Deploying Scoutpost..."
    echo ""
    echo "  Choose your deployment target:"
    echo "  1) Render blueprint (static frontend + optional Python API add-on)"
    echo "  2) Docker Compose (self-hosted)"
    echo ""
    read -rp "  Choice (1 or 2): " deploy_choice

    if [ "$deploy_choice" = "1" ]; then
        deploy_render
    elif [ "$deploy_choice" = "2" ]; then
        deploy_docker
    else
        log_error "Invalid choice. Please enter 1 or 2."
        exit 1
    fi
}

deploy_render() {
    log_info "Deploying to Render..."

    GH_USER=$(gh api user --jq '.login')

    echo ""
    echo "  To deploy on Render:"
    echo ""
    echo "  1. Go to https://dashboard.render.com"
    echo "  2. Click 'New' -> 'Blueprint'"
    echo "  3. Connect your forked repo: ${GH_USER}/scoutpost-os"
    echo "  4. Render reads deploy/render/render.yaml automatically"
    echo "  5. Fill in the environment variables when prompted"
    echo ""
    echo "  Your .env file contains all the values you need."
    echo "  Copy them from: $(pwd)/.env"
    echo ""

    read -rp "  Press Enter when Render deployment is complete..."

    # Get the Render URL
    prompt_required RENDER_URL "Optional FastAPI URL (e.g., https://scoutpost-api-optional.onrender.com)"
    HEALTH_URL="${RENDER_URL}/api/health"
}

deploy_docker() {
    log_info "Starting Docker Compose stack..."

    # Copy .env to the docker deploy directory
    cp .env deploy/docker/.env

    cd deploy/docker
    docker compose up -d
    cd ../..

    log_info "Waiting for services to start (30 seconds)..."
    sleep 30

    # Check if all services are running
    cd deploy/docker
    if docker compose ps | grep -q "Exit"; then
        log_error "Some services failed to start. Check: docker compose logs"
        docker compose ps
        exit 1
    fi
    cd ../..

    log_success "Docker stack running"
    HEALTH_URL="http://localhost:8080/api/health"
}

# ---------------------------------------------------------------------------
# Step 9: Install sync-upstream.yml
# ---------------------------------------------------------------------------

install_sync_action() {
    log_info "Installing sync-upstream GitHub Action..."

    GH_USER=$(gh api user --jq '.login')

    # Create .github/workflows directory in the fork
    mkdir -p .github/workflows

    # Copy the sync action
    cp selfhost/sync-upstream.yml .github/workflows/sync-upstream.yml

    # If deploying to Render, optionally record the deploy hook as a secret so
    # upstream sync PRs can report deployment readiness without printing values.
    if [ "${deploy_choice:-}" = "1" ]; then
        echo ""
        echo "  Optional: record the Render deploy hook for upstream sync PR reporting."
        echo "  Go to Render Dashboard -> Your Service -> Settings -> Deploy Hook"
        echo ""
        prompt_optional RENDER_DEPLOY_HOOK "Render deploy hook URL"
        if [ -n "$RENDER_DEPLOY_HOOK" ]; then
            echo "$RENDER_DEPLOY_HOOK" | gh secret set RENDER_DEPLOY_HOOK --repo "${GH_USER}/scoutpost-os"
        fi
    fi

    # Commit and push the workflow
    git add .github/workflows/sync-upstream.yml
    git commit -m "ci: install sync-upstream GitHub Action"
    git push origin master

    log_success "Sync action installed (runs weekly on Mondays at 6 AM UTC)"
}

# ---------------------------------------------------------------------------
# Step 10: Health check
# ---------------------------------------------------------------------------

health_check() {
    log_info "Running health check..."

    RETRIES=5
    for i in $(seq 1 $RETRIES); do
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" --max-time 10 2>/dev/null || echo "000")

        if [ "$HTTP_CODE" = "200" ]; then
            log_success "Health check passed: ${HEALTH_URL}"
            return 0
        fi

        if [ "$i" -lt "$RETRIES" ]; then
            log_warn "Health check attempt $i/$RETRIES failed (HTTP $HTTP_CODE). Retrying in 15s..."
            sleep 15
        fi
    done

    log_error "Health check failed after $RETRIES attempts."
    echo "  Check the deployment logs for errors."
    echo "  URL: ${HEALTH_URL}"
    return 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    echo ""
    echo "  ======================================"
    echo "  Scoutpost Setup"
    echo "  ======================================"
    echo ""

    check_prerequisites
    fork_repo
    generate_service_key
    collect_api_keys
    setup_supabase
    write_env_file
    deploy
    install_sync_action
    health_check

    echo ""
    echo "  ======================================"
    echo "  Setup complete!"
    echo "  ======================================"
    echo ""
    echo "  Your Scoutpost instance is running at: ${HEALTH_URL%/api/health}"
    echo "  Configuration saved to: $(pwd)/.env"
    echo ""
    echo "  Next steps:"
    echo "  - Open your instance in a browser and create an account"
    echo "  - Create your first scout to start monitoring"
    echo "  - The sync action will keep your fork up to date weekly"
    echo ""
}

main "$@"
