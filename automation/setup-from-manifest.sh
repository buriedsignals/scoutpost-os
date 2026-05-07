#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: automation/setup-from-manifest.sh <scoutpost-setup.json>" >&2
  exit 2
fi

MANIFEST="$1"
if [ ! -f "$MANIFEST" ]; then
  echo "Manifest not found: $MANIFEST" >&2
  exit 2
fi

log() { printf "\n== %s ==\n" "$1"; }
ok() { printf "OK: %s\n" "$1"; }
warn() { printf "WARN: %s\n" "$1" >&2; }
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required. Install it and re-run setup." >&2
    exit 1
  fi
}
jqv() { jq -r "$1 // empty" "$MANIFEST"; }
sql_literal() { printf "%s" "$1" | sed "s/'/''/g"; }

need jq
need git
need openssl

VERSION="$(jqv '.version')"
if [ "$VERSION" != "1" ]; then
  echo "Unsupported manifest version: ${VERSION:-<missing>}" >&2
  exit 1
fi

PROJECT_NAME="$(jqv '.project.name')"
APP_URL="$(jq -r '(.project.app_url // .frontend.production_url // "")' "$MANIFEST" | sed 's:/*$::')"
SUPABASE_MODE="$(jqv '.supabase.mode')"
MANIFEST_SUPABASE_ACCESS_TOKEN="$(jqv '.supabase.access_token')"
FRONTEND_PROVIDER="$(jqv '.frontend.provider')"
ADMIN_EMAIL="$(jqv '.auth.admin_email')"
SIGNUP_DOMAINS="$(jq -r '.auth.signup_allowed_domains // [] | map(select(. != "")) | join(",")' "$MANIFEST")"

GEMINI_API_KEY="$(jqv '.services.gemini_api_key')"
FIRECRAWL_API_KEY="$(jqv '.services.firecrawl_api_key')"
APIFY_API_TOKEN="$(jqv '.services.apify_api_token')"
RESEND_API_KEY="$(jqv '.services.resend_api_key')"
RESEND_FROM_EMAIL="$(jqv '.services.resend_from_email')"
PUBLIC_MAPTILER_API_KEY="$(jqv '.services.public_maptiler_api_key')"
CUSTOM_MCP_URL="$(jqv '.agents.custom_mcp_url' | sed 's:/*$::')"
RENDER_DEPLOY_HOOK="$(jqv '.options.render_deploy_hook')"

for required in PROJECT_NAME SUPABASE_MODE FRONTEND_PROVIDER ADMIN_EMAIL SIGNUP_DOMAINS GEMINI_API_KEY FIRECRAWL_API_KEY APIFY_API_TOKEN RESEND_API_KEY RESEND_FROM_EMAIL PUBLIC_MAPTILER_API_KEY; do
  if [ -z "${!required:-}" ]; then
    echo "Manifest missing required value: $required" >&2
    exit 1
  fi
done

if [ ! -d "supabase/functions" ] || [ ! -d "frontend" ]; then
  echo "Run this script from the Scoutpost repository root." >&2
  exit 1
fi

install_node_tooling() {
  log "Agent and provider tooling"
  if [ "${SCOUTPOST_INSTALL_AGENT_TOOLING:-${COJOURNALIST_INSTALL_AGENT_TOOLING:-false}}" != "true" ]; then
    ok "Skipping optional local CLI installs. The manifest supplies service credentials; install provider CLIs separately only if this operator machine needs them."
    return
  fi

  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not found; skipping agent/helper CLI installs."
    return
  fi

  if [ "$(jq -r 'if .agents.install_firecrawl_skill == false then "false" else "true" end' "$MANIFEST")" = "true" ]; then
    warn "Skipping Firecrawl browser authentication. The setup manifest already provides FIRECRAWL_API_KEY for the deployment."
  fi
  if [ "$(jq -r 'if .agents.install_supabase_skill == false then "false" else "true" end' "$MANIFEST")" = "true" ]; then
    npx skills add supabase/agent-skills --skill supabase || warn "Supabase skill install failed; continue setup."
  fi

  case "$FRONTEND_PROVIDER" in
    netlify)
      command -v netlify >/dev/null 2>&1 || npm install -g netlify-cli
      ;;
    vercel)
      command -v vercel >/dev/null 2>&1 || npm install -g vercel
      ;;
    cloudflare)
      command -v wrangler >/dev/null 2>&1 || npm install -g wrangler
      ;;
    render)
      if ! command -v render >/dev/null 2>&1; then
        if command -v brew >/dev/null 2>&1; then
          brew install render || warn "Render CLI install failed."
        else
          warn "Render selected but brew is unavailable; install Render CLI manually."
        fi
      fi
      render skills install --scope project || warn "Render skills install failed; continue setup."
      ;;
    manual)
      ok "Manual frontend hosting selected"
      ;;
    *)
      echo "Unknown frontend provider: $FRONTEND_PROVIDER" >&2
      exit 1
      ;;
  esac
}

resolve_supabase() {
  log "Supabase"
  if [ -n "$MANIFEST_SUPABASE_ACCESS_TOKEN" ]; then
    export SUPABASE_ACCESS_TOKEN="$MANIFEST_SUPABASE_ACCESS_TOKEN"
  fi
  if command -v supabase >/dev/null 2>&1; then
    SUPABASE_CLI="supabase"
  elif command -v npx >/dev/null 2>&1; then
    SUPABASE_CLI="npx supabase"
  else
    echo "Supabase CLI not found. Install it first: npm install -g supabase" >&2
    exit 1
  fi

  if [ "$SUPABASE_MODE" != "self-hosted" ]; then
    if ! $SUPABASE_CLI projects list >/dev/null 2>&1; then
      echo "Supabase CLI is not authenticated. Add supabase.access_token to scoutpost-setup.json or set SUPABASE_ACCESS_TOKEN, then rerun setup." >&2
      exit 1
    fi
  fi

  case "$SUPABASE_MODE" in
    cloud-create)
      ORG_ID="$(jqv '.supabase.org_id')"
      REGION="$(jqv '.supabase.region')"
      DB_PASSWORD="$(jqv '.supabase.db_password')"
      if [ -z "$ORG_ID" ] || [ -z "$REGION" ] || [ -z "$DB_PASSWORD" ]; then
        echo "cloud-create requires supabase.org_id, supabase.region, and supabase.db_password" >&2
        exit 1
      fi
      CREATE_JSON="$($SUPABASE_CLI projects create "$PROJECT_NAME" --org-id "$ORG_ID" --db-password "$DB_PASSWORD" --region "$REGION" -o json)"
      SUPABASE_PROJECT_REF="$(printf '%s' "$CREATE_JSON" | jq -r '.ref // .id // .project_ref // empty')"
      if [ -z "$SUPABASE_PROJECT_REF" ]; then
        echo "Could not parse project ref from Supabase create output:" >&2
        printf '%s\n' "$CREATE_JSON" >&2
        exit 1
      fi
      SUPABASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co"
      KEYS_JSON="$($SUPABASE_CLI projects api-keys --project-ref "$SUPABASE_PROJECT_REF" -o json)"
      SUPABASE_ANON_KEY="$(printf '%s' "$KEYS_JSON" | jq -r '.[] | select((.name // .key_name // "") | test("anon"; "i")) | .api_key // .key // empty' | head -1)"
      SUPABASE_SERVICE_KEY="$(printf '%s' "$KEYS_JSON" | jq -r '.[] | select((.name // .key_name // "") | test("service"; "i")) | .api_key // .key // empty' | head -1)"
      SUPABASE_JWT_SECRET="$(jqv '.supabase.jwt_secret')"
      ;;
    cloud-existing)
      SUPABASE_PROJECT_REF="$(jqv '.supabase.project_ref')"
      SUPABASE_URL="$(jqv '.supabase.project_url' | sed 's:/*$::')"
      SUPABASE_ANON_KEY="$(jqv '.supabase.anon_key')"
      SUPABASE_SERVICE_KEY="$(jqv '.supabase.service_role_key')"
      SUPABASE_JWT_SECRET="$(jqv '.supabase.jwt_secret')"
      ;;
    self-hosted)
      SUPABASE_PROJECT_REF="$(jqv '.supabase.project_ref')"
      SUPABASE_URL="$(jqv '.supabase.project_url' | sed 's:/*$::')"
      SUPABASE_ANON_KEY="$(jqv '.supabase.anon_key')"
      SUPABASE_SERVICE_KEY="$(jqv '.supabase.service_role_key')"
      SUPABASE_JWT_SECRET="$(jqv '.supabase.jwt_secret')"
      ;;
    *)
      echo "Unknown Supabase mode: $SUPABASE_MODE" >&2
      exit 1
      ;;
  esac

  for required in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY; do
    if [ -z "${!required:-}" ]; then
      echo "Unable to resolve $required from manifest/Supabase CLI." >&2
      exit 1
    fi
  done

  if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
    $SUPABASE_CLI link --project-ref "$SUPABASE_PROJECT_REF"
    $SUPABASE_CLI config push || warn "supabase config push failed; verify Auth hooks in the dashboard."
    $SUPABASE_CLI db push
    $SUPABASE_CLI functions deploy --all
  elif [ "$SUPABASE_MODE" = "self-hosted" ]; then
    warn "No project ref supplied for self-hosted Supabase; skipping CLI link/db push/functions deploy."
  fi
}

seed_signup_allowlist() {
  log "Signup allowlist"
  if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
    warn "No Supabase project ref; seed signup allowlist manually."
    return
  fi
  if [ ! -x "automation/adopt-signup-allowlist.sh" ]; then
    warn "automation/adopt-signup-allowlist.sh not found; seed signup allowlist manually."
    return
  fi

  IFS=',' read -r -a domains <<< "$SIGNUP_DOMAINS"
  for domain in "${domains[@]}"; do
    clean="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | sed 's/^@//')"
    if [ -n "$clean" ]; then
      SUPABASE_URL="$SUPABASE_URL" \
      SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_KEY" \
        automation/adopt-signup-allowlist.sh \
          --admin "$ADMIN_EMAIL" \
          --domain "$clean" \
          --project-ref "$SUPABASE_PROJECT_REF"
    fi
  done
}

set_supabase_secrets() {
  if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
    warn "No Supabase project ref; set Edge Function secrets manually."
    return
  fi
  log "Edge Function secrets"
  INTERNAL_SERVICE_KEY="$(openssl rand -hex 32)"
  $SUPABASE_CLI secrets set \
    "ADMIN_EMAILS=${ADMIN_EMAIL}" \
    "INTERNAL_SERVICE_KEY=${INTERNAL_SERVICE_KEY}" \
    "GEMINI_API_KEY=${GEMINI_API_KEY}" \
    "FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}" \
    "APIFY_API_TOKEN=${APIFY_API_TOKEN}" \
    "RESEND_API_KEY=${RESEND_API_KEY}" \
    "RESEND_FROM_EMAIL=${RESEND_FROM_EMAIL}" \
    "PUBLIC_MAPTILER_API_KEY=${PUBLIC_MAPTILER_API_KEY}"
  if [ -n "$CUSTOM_MCP_URL" ]; then
    $SUPABASE_CLI secrets set "MCP_SERVER_BASE_URL=${CUSTOM_MCP_URL}"
  fi
}

seed_vault_secrets() {
  if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
    warn "No Supabase project ref; set Vault secrets project_url and internal_service_key manually."
    return
  fi
  if [ -z "${INTERNAL_SERVICE_KEY:-}" ]; then
    warn "INTERNAL_SERVICE_KEY missing; cannot seed Vault internal_service_key."
    return
  fi
  log "Vault secrets"
  local url_sql key_sql
  url_sql="$(sql_literal "$SUPABASE_URL")"
  key_sql="$(sql_literal "$INTERNAL_SERVICE_KEY")"
  $SUPABASE_CLI db execute --sql "
    SELECT vault.create_secret('${url_sql}', 'project_url')
    WHERE NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'project_url');
    SELECT vault.create_secret('${key_sql}', 'internal_service_key')
    WHERE NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_service_key');
  " || warn "Could not seed Vault secrets automatically; create project_url and internal_service_key in Supabase Vault before scheduling scouts."
}

write_env_files() {
  log "Environment files"
  cat > .env <<ENVEOF
DEPLOYMENT_TARGET=supabase
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET:-}
GEMINI_API_KEY=${GEMINI_API_KEY}
LLM_MODEL=gemini-2.5-flash-lite
FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}
RESEND_API_KEY=${RESEND_API_KEY}
RESEND_FROM_EMAIL=${RESEND_FROM_EMAIL}
APIFY_API_TOKEN=${APIFY_API_TOKEN}
PUBLIC_MAPTILER_API_KEY=${PUBLIC_MAPTILER_API_KEY}
PUBLIC_DEPLOYMENT_TARGET=supabase
PUBLIC_SUPABASE_URL=${SUPABASE_URL}
PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
VITE_API_URL=${SUPABASE_URL}/functions/v1
PUBLIC_MUCKROCK_ENABLED=false
PUBLIC_LOCAL_DEMO_MODE=false
ADMIN_EMAILS=${ADMIN_EMAIL}
SIGNUP_ALLOWED_DOMAINS=${SIGNUP_DOMAINS}
ENVEOF
  chmod 600 .env

  cat > frontend/.env.production.local <<ENVEOF
PUBLIC_DEPLOYMENT_TARGET=supabase
PUBLIC_SUPABASE_URL=${SUPABASE_URL}
PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
VITE_API_URL=${SUPABASE_URL}/functions/v1
PUBLIC_MAPTILER_API_KEY=${PUBLIC_MAPTILER_API_KEY}
PUBLIC_MUCKROCK_ENABLED=false
PUBLIC_LOCAL_DEMO_MODE=false
ENVEOF
  chmod 600 frontend/.env.production.local
}

build_frontend() {
  log "Frontend build"
  if [ -f frontend/.nvmrc ] && command -v nvm >/dev/null 2>&1; then
    (cd frontend && nvm use)
  fi
  if command -v npm >/dev/null 2>&1; then
    (cd frontend && npm ci && npm run build)
  else
    warn "npm not found; skipping frontend build."
  fi
}

install_sync_workflow() {
  if [ "$(jq -r 'if .options.install_sync_workflow == false then "false" else "true" end' "$MANIFEST")" != "true" ]; then
    return
  fi
  log "Sync workflow"
  mkdir -p .github/workflows
  cp automation/sync-upstream.yml .github/workflows/sync-upstream.yml
  ok "Copied .github/workflows/sync-upstream.yml. Commit and push it to enable weekly upstream syncs."
  if command -v gh >/dev/null 2>&1 && [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
    printf '%s' "$SUPABASE_PROJECT_REF" | gh secret set SUPABASE_PROJECT_REF || warn "Could not set SUPABASE_PROJECT_REF."
  fi
  if command -v gh >/dev/null 2>&1 && [ -n "$RENDER_DEPLOY_HOOK" ]; then
    printf '%s' "$RENDER_DEPLOY_HOOK" | gh secret set RENDER_DEPLOY_HOOK || warn "Could not set RENDER_DEPLOY_HOOK."
  fi
  warn "For automatic migration updates, add GitHub secret SUPABASE_ACCESS_TOKEN in the fork."
}

install_node_tooling
resolve_supabase
seed_signup_allowlist
set_supabase_secrets
seed_vault_secrets
write_env_files
build_frontend
install_sync_workflow

cat <<EOF

coJournalist setup completed.

App URL: ${APP_URL:-<set after frontend deploy>}
Supabase URL: ${SUPABASE_URL}
API base: ${SUPABASE_URL}/functions/v1
MCP URL: ${CUSTOM_MCP_URL:-${SUPABASE_URL}/functions/v1/mcp-server}

Next: deploy frontend/build with ${FRONTEND_PROVIDER}, then send newsroom-onboarding.md to journalists.
EOF
