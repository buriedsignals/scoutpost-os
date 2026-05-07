#!/usr/bin/env bash
set -euo pipefail

EXPECTED_AUTH_HOOK="pg-functions://postgres/public/hook_restrict_signup_by_allowlist"
HOSTED_SUPABASE_REF="gfmdziplticfoak"
HOSTED_SUPABASE_REF="${HOSTED_SUPABASE_REF}hrfpt"

info() { printf "INFO: %s\n" "$1"; }
ok() { printf "OK: %s\n" "$1"; }
warn() { printf "WARN: %s\n" "$1"; }
blocker() {
  printf "BLOCKER: %s\n" "$1"
  BLOCKERS=$((BLOCKERS + 1))
}

BLOCKERS=0
REPO_ROOT=""
FOUND_NESTED_REPO=0

find_repo_root() {
  local top
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    REPO_ROOT="$(git rev-parse --show-toplevel)"
    return 0
  fi

  local roots=()
  local child seen
  for child in "$PWD"/*; do
    [ -d "$child" ] || continue
    if top="$(git -C "$child" rev-parse --show-toplevel 2>/dev/null)"; then
      seen=0
      for existing in "${roots[@]:-}"; do
        if [ "$existing" = "$top" ]; then
          seen=1
          break
        fi
      done
      if [ "$seen" -eq 0 ]; then
        roots+=("$top")
      fi
    fi
  done

  if [ "${#roots[@]}" -eq 1 ]; then
    REPO_ROOT="${roots[0]}"
    FOUND_NESTED_REPO=1
    return 0
  fi

  if [ "${#roots[@]}" -gt 1 ]; then
    blocker "Multiple nested Git checkouts found; cd into the intended scoutpost-os checkout before updating."
  else
    blocker "No Git checkout found here or one level down."
  fi
  return 1
}

print_status_block() {
  local label="$1"
  local body="$2"
  printf "%s\n" "$label"
  printf "%s\n" "$body" | sed 's/^/  /'
}

extract_auth_hook_uri() {
  local config_file="$1"
  awk '
    /^\[auth\.hook\.before_user_created\]/ { in_block = 1; next }
    /^\[/ { in_block = 0 }
    in_block && /^[[:space:]]*uri[[:space:]]*=/ {
      sub(/^[[:space:]]*uri[[:space:]]*=[[:space:]]*/, "")
      gsub(/"/, "")
      print
      exit
    }
  ' "$config_file"
}

extract_auth_hook_enabled() {
  local config_file="$1"
  awk '
    /^\[auth\.hook\.before_user_created\]/ { in_block = 1; next }
    /^\[/ { in_block = 0 }
    in_block && /^[[:space:]]*enabled[[:space:]]*=/ {
      sub(/^[[:space:]]*enabled[[:space:]]*=[[:space:]]*/, "")
      gsub(/"/, "")
      print
      exit
    }
  ' "$config_file"
}

env_file_value() {
  local file="$1"
  local key="$2"
  local line value
  [ -f "$file" ] || return 1
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 1
  value="${line#*=}"
  printf "%s" "$value" | sed \
    -e 's/^[[:space:]]*//' \
    -e 's/[[:space:]]*$//' \
    -e 's/^"//' \
    -e 's/"$//' \
    -e "s/^'//" \
    -e "s/'$//"
}

normalize_url() {
  printf "%s" "$1" | sed -e 's/[[:space:]]//g' -e 's:/*$::'
}

scan_hosted_supabase_refs() {
  local file matches
  local files=(
    ".env"
    ".env.production"
    "frontend/.env.production.local"
    "frontend/.env.production"
    "frontend/.env.local"
    "frontend/build/_app/env.js"
    "scoutpost-setup.json"
    "generated-cli-instructions.txt"
  )
  for file in "${files[@]}"; do
    [ -f "$file" ] || continue
    if grep -q "$HOSTED_SUPABASE_REF" "$file"; then
      matches="$(grep -n "$HOSTED_SUPABASE_REF" "$file" | cut -d: -f1 | paste -sd, -)"
      blocker "Hosted Scoutpost Supabase project ref found in $file line(s): $matches. Regenerate this deployment config for the newsroom project."
    fi
  done
}

check_frontend_supabase_consistency() {
  local root_url frontend_env frontend_url vite_api_url expected_api
  root_url="$(env_file_value ".env" "SUPABASE_URL" || true)"
  if [ -z "$root_url" ]; then
    root_url="$(env_file_value ".env" "PUBLIC_SUPABASE_URL" || true)"
  fi
  frontend_env="frontend/.env.production.local"
  if [ ! -f "$frontend_env" ]; then
    frontend_env="frontend/.env.production"
  fi
  frontend_url="$(env_file_value "$frontend_env" "PUBLIC_SUPABASE_URL" || true)"
  vite_api_url="$(env_file_value "$frontend_env" "VITE_API_URL" || true)"

  root_url="$(normalize_url "$root_url")"
  frontend_url="$(normalize_url "$frontend_url")"
  vite_api_url="$(normalize_url "$vite_api_url")"

  if [ -n "$root_url" ] && [ -n "$frontend_url" ] && [ "$root_url" != "$frontend_url" ]; then
    blocker "Root .env Supabase URL ($root_url) does not match $frontend_env PUBLIC_SUPABASE_URL ($frontend_url). Regenerate deployment files before deploying."
  fi

  if [ -n "$frontend_url" ] && [ -n "$vite_api_url" ]; then
    expected_api="${frontend_url}/functions/v1"
    if [ "$vite_api_url" != "$expected_api" ]; then
      blocker "$frontend_env VITE_API_URL ($vite_api_url) does not point at PUBLIC_SUPABASE_URL ($frontend_url)."
    fi
  fi
}

if ! command -v git >/dev/null 2>&1; then
  echo "BLOCKER: git is required." >&2
  exit 1
fi

find_repo_root || true
if [ -z "${REPO_ROOT:-}" ]; then
  printf "\nResolve the blocker above, then re-run automation/selfhost-doctor.sh.\n"
  exit 1
fi

cd "$REPO_ROOT"
printf "Scoutpost self-host doctor\n"
printf "Repository: %s\n\n" "$REPO_ROOT"
if [ "$FOUND_NESTED_REPO" -eq 1 ]; then
  info "Current directory is not a Git worktree; using nested checkout $REPO_ROOT"
fi

if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
  print_status_block "Unresolved merge conflicts:" "$(git diff --name-only --diff-filter=U)"
  blocker "Resolve merge conflicts before running upstream maintenance."
else
  ok "No unresolved merge conflicts."
fi

STATUS="$(git status --short)"
if [ -n "$STATUS" ]; then
  print_status_block "Working tree changes:" "$STATUS"
else
  ok "Working tree is clean."
fi

TRACKED_DIRTY="$(git status --porcelain | awk '$1 != "??" { print }')"
if [ -n "$TRACKED_DIRTY" ]; then
  warn "Tracked local edits are present; preserve them during upstream merges."
fi

UNTRACKED_MIGRATIONS="$(git ls-files --others --exclude-standard -- supabase/migrations)"
if [ -n "$UNTRACKED_MIGRATIONS" ]; then
  print_status_block "Untracked Supabase migrations:" "$UNTRACKED_MIGRATIONS"
  warn "Review these before running supabase db push; they may be local-only deployment migrations."
fi

scan_hosted_supabase_refs
check_frontend_supabase_consistency

USER_NAME="$(git config user.name || true)"
USER_EMAIL="$(git config user.email || true)"
if [ -z "$USER_NAME" ] || [ -z "$USER_EMAIL" ]; then
  warn "Git committer identity is missing in this repository."
  printf "  git config user.name \"Scoutpost Maintenance\"\n"
  printf "  git config user.email \"maintenance@scoutpost.local\"\n"
else
  ok "Git committer identity is configured."
fi

if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    ok "GitHub CLI is installed and authenticated."
  else
    warn "GitHub CLI is installed but not authenticated. Run: gh auth login"
  fi
else
  warn "GitHub CLI is not installed. Install gh before opening or updating sync PRs."
fi

if command -v supabase >/dev/null 2>&1; then
  if [ -f "supabase/.temp/project-ref" ]; then
    ok "Supabase CLI is installed and linked to project $(cat supabase/.temp/project-ref)."
  else
    warn "Supabase CLI is installed but this checkout is not linked. Run: supabase link --project-ref <project-ref>"
  fi
else
  warn "Supabase CLI is not installed. Install it before applying migrations or deploying functions."
fi

CONFIG_FILE="supabase/config.toml"
if [ -f "$CONFIG_FILE" ]; then
  HOOK_ENABLED="$(extract_auth_hook_enabled "$CONFIG_FILE")"
  HOOK_URI="$(extract_auth_hook_uri "$CONFIG_FILE")"
  if [ "$HOOK_ENABLED" = "true" ] && [ -n "$HOOK_URI" ] && [ "$HOOK_URI" != "$EXPECTED_AUTH_HOOK" ]; then
    warn "Custom Supabase signup hook detected: $HOOK_URI"
    printf "  To adopt the upstream allowlist, first run:\n"
    printf "  automation/adopt-signup-allowlist.sh --domain <newsroom-domain> --admin <admin-email>\n"
    printf "  Then update supabase/config.toml to use: %s\n" "$EXPECTED_AUTH_HOOK"
  elif [ "$HOOK_ENABLED" = "true" ] && [ "$HOOK_URI" = "$EXPECTED_AUTH_HOOK" ]; then
    ok "Supabase signup hook uses the upstream allowlist."
  else
    warn "No enabled before-user-created signup hook found in supabase/config.toml."
  fi
else
  warn "supabase/config.toml not found."
fi

printf "\nRecommended existing-install update path:\n"
printf "  git fetch upstream master\n"
printf "  git switch -c scoutpost/upstream-maintenance-$(date -u +%Y-%m-%d)\n"
printf "  automation/selfhost-doctor.sh\n"
printf "  git merge upstream/master\n"
printf "  # review local migrations and auth-hook changes before applying database updates\n"
printf "  supabase db push\n"
printf "  supabase functions deploy --all\n"

if [ "$BLOCKERS" -gt 0 ]; then
  printf "\nFound %s blocker(s). Resolve them before merging or deploying upstream changes.\n" "$BLOCKERS"
  exit 1
fi

printf "\nNo blocking issues found. Review warnings before continuing.\n"
