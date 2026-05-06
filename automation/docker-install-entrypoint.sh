#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-install}"
WORKSPACE="${COJOURNALIST_WORKSPACE:-/workspace}"
MANIFEST="${COJOURNALIST_SETUP_MANIFEST:-/config/cojournalist-setup.json}"
REPO_DIR="${COJOURNALIST_REPO_DIR:-}"
UPSTREAM_REPO="${COJOURNALIST_UPSTREAM_REPO:-https://github.com/buriedsignals/cojournalist-os.git}"

log() { printf "\n== %s ==\n" "$1"; }
warn() { printf "WARN: %s\n" "$1" >&2; }

find_or_clone_repo() {
  if [ -n "$REPO_DIR" ]; then
    mkdir -p "$(dirname "$REPO_DIR")"
  elif [ -e "$WORKSPACE/.git" ] || [ -d "$WORKSPACE/automation" ]; then
    REPO_DIR="$WORKSPACE"
  else
    REPO_DIR="$WORKSPACE/cojournalist-os"
  fi

  if [ -e "$REPO_DIR/.git" ]; then
    return
  fi

  if [ -e "$REPO_DIR" ] && [ -n "$(find "$REPO_DIR" -mindepth 1 -maxdepth 1 2>/dev/null || true)" ]; then
    echo "Target repo directory exists but is not an empty Git checkout: $REPO_DIR" >&2
    exit 1
  fi

  log "Clone coJournalist OSS"
  git clone "$UPSTREAM_REPO" "$REPO_DIR"
  git -C "$REPO_DIR" checkout master
}

require_manifest() {
  if [ ! -f "$MANIFEST" ]; then
    echo "Setup manifest not found: $MANIFEST" >&2
    echo "Mount it with: -v ./cojournalist-setup.json:/config/cojournalist-setup.json:ro" >&2
    exit 2
  fi
}

install_instance() {
  require_manifest
  find_or_clone_repo
  log "Install from manifest"
  cd "$REPO_DIR"
  bash automation/setup-from-manifest.sh "$MANIFEST"
}

doctor() {
  find_or_clone_repo
  log "Self-host doctor"
  cd "$REPO_DIR"
  bash automation/selfhost-doctor.sh
}

update_instance() {
  find_or_clone_repo
  cd "$REPO_DIR"

  if [ -n "$(git status --porcelain)" ]; then
    echo "Refusing to prepare an update branch from a dirty checkout: $REPO_DIR" >&2
    echo "Commit, stash, or remove local changes before running cojournalist-installer update." >&2
    exit 1
  fi

  log "Pre-update doctor"
  bash automation/selfhost-doctor.sh || true

  log "Fetch upstream"
  git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || true
  git fetch upstream master

  local branch="cojournalist/upstream-maintenance-$(date -u +%Y-%m-%d)"
  git switch -C "$branch"
  git merge upstream/master --no-edit -m "sync: merge upstream $(date -u +%Y-%m-%d)"

  mkdir -p .github/workflows
  cp automation/sync-upstream.yml .github/workflows/sync-upstream.yml

  log "Post-update doctor"
  bash automation/selfhost-doctor.sh || true

  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    git add .github/workflows/sync-upstream.yml
    if ! git diff --cached --quiet; then
      git commit -m "ci: refresh coJournalist upstream sync workflow"
    fi
    git push -u origin "$branch"
    gh pr create \
      --base master \
      --head "$branch" \
      --title "sync: merge upstream coJournalist OSS" \
      --body "Automated upstream maintenance branch created by the coJournalist installer container."
  else
    warn "GitHub CLI is not authenticated; branch prepared locally only: $branch"
  fi
}

case "$COMMAND" in
  install) install_instance ;;
  doctor) doctor ;;
  update) update_instance ;;
  *)
    echo "Usage: cojournalist-installer {install|doctor|update}" >&2
    exit 2
    ;;
esac
