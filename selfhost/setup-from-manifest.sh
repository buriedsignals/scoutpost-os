#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: selfhost/setup-from-manifest.sh <scoutpost-setup.json>" >&2
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
case "$VERSION" in
  1|2) ;;
  *)
    echo "Unsupported manifest version: ${VERSION:-<missing>}. Expected version 2 (or version 1 with services.openrouter_api_key for compatibility)." >&2
    exit 1
    ;;
esac

PROJECT_NAME="$(jqv '.project.name')"
APP_URL="$(jq -r '(.project.app_url // .frontend.production_url // "")' "$MANIFEST" | sed 's:/*$::')"
DATA_PLATFORM_PROVIDER="$(jq -r '.data_platform.provider // "supabase"' "$MANIFEST")"
SUPABASE_MODE="$(jqv '.supabase.mode')"
MANIFEST_SUPABASE_ACCESS_TOKEN="$(jqv '.supabase.access_token')"
FRONTEND_PROVIDER="$(jqv '.frontend.provider')"
ADMIN_EMAIL="$(jqv '.auth.admin_email')"
SIGNUP_DOMAINS="$(jq -r '.auth.signup_allowed_domains // [] | map(select(. != "")) | join(",")' "$MANIFEST")"

OPENROUTER_API_KEY="$(jqv '.services.openrouter_api_key')"
FIRECRAWL_API_KEY="$(jqv '.services.firecrawl_api_key')"
EXA_API_KEY="$(jqv '.services.exa_api_key')"
APIFY_API_TOKEN="$(jqv '.services.apify_api_token')"
RESEND_API_KEY="$(jqv '.services.resend_api_key')"
RESEND_FROM_EMAIL="$(jqv '.services.resend_from_email')"
PUBLIC_MAPTILER_API_KEY="$(jqv '.services.public_maptiler_api_key')"
CUSTOM_MCP_URL="$(jqv '.agents.custom_mcp_url' | sed 's:/*$::')"
RENDER_DEPLOY_HOOK="$(jqv '.options.render_deploy_hook')"

if [ "$VERSION" = "1" ] && [ -z "$OPENROUTER_API_KEY" ]; then
  echo "Manifest version 1 is Gemini-only and cannot configure the current Scoutpost runtime." >&2
  echo "Add services.openrouter_api_key (or generate a version 2 manifest) and rerun setup; GEMINI_API_KEY is no longer used." >&2
  exit 1
fi

if [ "$VERSION" = "2" ] && jq -e '.services | has("gemini_api_key")' "$MANIFEST" >/dev/null; then
  echo "Manifest version 2 must not contain services.gemini_api_key." >&2
  echo "Remove that deprecated field and keep services.openrouter_api_key as the single AI credential." >&2
  exit 1
fi

case "$DATA_PLATFORM_PROVIDER" in
  supabase|manual) ;;
  *)
    echo "Unknown data_platform.provider: $DATA_PLATFORM_PROVIDER" >&2
    exit 1
    ;;
esac

for required in PROJECT_NAME FRONTEND_PROVIDER ADMIN_EMAIL SIGNUP_DOMAINS OPENROUTER_API_KEY FIRECRAWL_API_KEY APIFY_API_TOKEN RESEND_API_KEY RESEND_FROM_EMAIL PUBLIC_MAPTILER_API_KEY; do
  if [ -z "${!required:-}" ]; then
    echo "Manifest missing required value: $required" >&2
    exit 1
  fi
done

if [ "$DATA_PLATFORM_PROVIDER" = "supabase" ] && [ -z "$SUPABASE_MODE" ]; then
  echo "Manifest missing required value: SUPABASE_MODE" >&2
  exit 1
fi

if [ ! -d "supabase/functions" ] || [ ! -d "frontend" ]; then
  echo "Run this script from the Scoutpost repository root." >&2
  exit 1
fi

write_manual_provider_packet() {
  log "Manual provider packet"
  local provider_name provider_notes api_base mcp_url app_url docs_file
  provider_name="$(jqv '.data_platform.provider_name')"
  provider_notes="$(jqv '.data_platform.operator_notes')"
  api_base="$(jqv '.data_platform.api_base_url')"
  mcp_url="$(jqv '.data_platform.mcp_url')"
  app_url="${APP_URL:-To be assigned after frontend deploy.}"
  docs_file="$(mktemp "${TMPDIR:-/tmp}/scoutpost-provider-docs.XXXXXX")"
  jq -r '.data_platform.docs_urls // [] | map(select(. != "")) | .[]' "$MANIFEST" > "$docs_file"

  if [ -z "$provider_name" ] && [ -z "$provider_notes" ]; then
    echo "Manual provider mode requires data_platform.provider_name or data_platform.operator_notes." >&2
    rm -f "$docs_file"
    exit 1
  fi

  {
    cat <<EOF
# Scoutpost provider porting packet

Provider: ${provider_name:-Manual provider}
Manifest: $MANIFEST

## Operator notes

${provider_notes:-None supplied.}

## Provider references

EOF
    if [ -s "$docs_file" ]; then
      sed 's/^/- /' "$docs_file"
    else
      printf "%s\n" "- Add official provider documentation before implementation."
    fi
    cat <<EOF

## Target endpoints

- App URL: $app_url
- API base URL: ${api_base:-To be defined by the provider integration.}
- MCP URL: ${mcp_url:-To be defined by the provider integration.}

## Canonical Scoutpost source material

- Migration index: docs/supabase/migrations.md
- Migration directory: supabase/migrations/
- Runtime directory: supabase/functions/
- Agent/API contract: docs/mcp/clients.md and supabase/functions/mcp-server/

The Supabase migrations are the canonical product data model. Do not apply them
blindly to another provider. Translate them into the selected provider's
database, auth, scheduling, secrets, and API model for human review.

## Runtime assumptions to translate

- Supabase Auth user identity and JWT verification.
- Row-level security policies and service-role bypass.
- PostgREST/Supabase client conventions used by Edge Functions.
- SQL RPCs used by CLI, MCP, API keys, credits, search, scheduling, and queues.
- pgvector embeddings and vector indexes.
- pg_cron scheduled jobs.
- pg_net HTTP dispatch to worker functions.
- Vault-backed secrets for scheduled execution.
- Supabase Edge Functions as the current API, worker, MCP, and auth runtime.

## Migration translation checklist

- Tables, columns, constraints, defaults, and enum/check constraints.
- Indexes, including trigram and vector-search equivalents.
- Access control equivalent for every RLS policy.
- Auth identity mapping from provider users to Scoutpost user IDs.
- API key storage, hashing, validation, and bearer-token precedence.
- Scout scheduling and retry behavior.
- Background HTTP dispatch for scout execution and queue workers.
- Secrets management for service keys and provider API credentials.
- RPC/function equivalents for search, deduplication, credits, queues, and MCP.
- Local validation and CI smoke tests before production use.

## Human review gate

Before applying anything, produce a reviewable implementation plan with provider
documentation links, a migration mapping table, unsupported semantics, exact
commands, rollback notes, and files to change.

Do not apply database, auth, scheduling, secrets, or production infrastructure
changes without explicit operator approval.
EOF
  } > scoutpost-provider-porting.md
  rm -f "$docs_file"
  ok "Wrote scoutpost-provider-porting.md. Manual provider mode does not run Supabase CLI commands."
}

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
  elif [ "$SUPABASE_MODE" = "self-hosted" ]; then
    warn "No project ref supplied for self-hosted Supabase; skipping CLI link/db push/functions deploy."
  fi
}

deploy_edge_functions() {
  if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
    log "Deploy Edge Functions"
    # Omitting a function name deploys every local function. Supabase CLI has
    # no --all flag for this command.
    $SUPABASE_CLI functions deploy
  fi
}

seed_signup_allowlist() {
  log "Signup allowlist"
  if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
    warn "No Supabase project ref; seed signup allowlist manually."
    return
  fi
  if [ ! -x "selfhost/adopt-signup-allowlist.sh" ]; then
    warn "selfhost/adopt-signup-allowlist.sh not found; seed signup allowlist manually."
    return
  fi

  IFS=',' read -r -a domains <<< "$SIGNUP_DOMAINS"
  for domain in "${domains[@]}"; do
    clean="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | sed 's/^@//')"
    if [ -n "$clean" ]; then
      SUPABASE_URL="$SUPABASE_URL" \
      SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_KEY" \
        selfhost/adopt-signup-allowlist.sh \
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
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}" \
    "APIFY_API_TOKEN=${APIFY_API_TOKEN}" \
    "RESEND_API_KEY=${RESEND_API_KEY}" \
    "RESEND_FROM_EMAIL=${RESEND_FROM_EMAIL}" \
    "PUBLIC_MAPTILER_API_KEY=${PUBLIC_MAPTILER_API_KEY}"
  if [ -n "$EXA_API_KEY" ]; then
    $SUPABASE_CLI secrets set "EXA_API_KEY=${EXA_API_KEY}"
  else
    warn "EXA_API_KEY not supplied. Beat Scout will fall back to Firecrawl-only retrieval until you set EXA_API_KEY (Exa is the default retrieval port — see docs/architecture/retrieval-ports.md)."
  fi
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
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
LLM_MODEL=google/gemini-2.5-flash-lite
FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}
EXA_API_KEY=${EXA_API_KEY}
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
  cp selfhost/sync-upstream.yml .github/workflows/sync-upstream.yml
  ok "Copied .github/workflows/sync-upstream.yml. Commit and push it to enable weekly upstream syncs."
  if command -v gh >/dev/null 2>&1 && [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
    printf '%s' "$SUPABASE_PROJECT_REF" | gh secret set SUPABASE_PROJECT_REF || warn "Could not set SUPABASE_PROJECT_REF."
  fi
  if command -v gh >/dev/null 2>&1 && [ -n "$RENDER_DEPLOY_HOOK" ]; then
    printf '%s' "$RENDER_DEPLOY_HOOK" | gh secret set RENDER_DEPLOY_HOOK || warn "Could not set RENDER_DEPLOY_HOOK."
  fi
  warn "For automatic migration updates, add GitHub secret SUPABASE_ACCESS_TOKEN in the fork."
}

if [ "$DATA_PLATFORM_PROVIDER" = "manual" ]; then
  write_manual_provider_packet
  cat <<EOF

Scoutpost manual provider packet generated.

Provider: $(jqv '.data_platform.provider_name')
App URL: ${APP_URL:-<set after frontend deploy>}
Packet: scoutpost-provider-porting.md

Next: have the operator's technical team review the packet, inspect
docs/supabase/migrations.md and supabase/migrations/, fetch the selected
provider's official documentation, and prepare a provider-specific integration
plan before applying any infrastructure changes.
EOF
  exit 0
fi

install_node_tooling
resolve_supabase
set_supabase_secrets
seed_signup_allowlist
seed_vault_secrets
deploy_edge_functions
write_env_files
build_frontend
install_sync_workflow

cat <<EOF

Scoutpost setup completed.

App URL: ${APP_URL:-<set after frontend deploy>}
Supabase URL: ${SUPABASE_URL}
API base: ${SUPABASE_URL}/functions/v1
MCP URL: ${CUSTOM_MCP_URL:-${SUPABASE_URL}/functions/v1/mcp-server}

Next: deploy frontend/build with ${FRONTEND_PROVIDER}, then send newsroom-onboarding.md to journalists.
EOF
