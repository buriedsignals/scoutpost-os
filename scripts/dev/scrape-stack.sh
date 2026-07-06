#!/usr/bin/env bash
# Build and run the local scrape-service container, wait for /health, print
# the endpoint + token for adapter smokes. SCRAPING-MIGRATION-PRD U1.
#
# Usage: scripts/dev/scrape-stack.sh [up|down|status]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="scoutpost-scrape-service:dev"
NAME="scoutpost-scrape-dev"
PORT="${SCRAPE_STACK_PORT:-8787}"
TOKEN_FILE="$REPO_ROOT/.scrape-stack-token"

cmd="${1:-up}"

case "$cmd" in
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "scrape-stack: stopped"
    exit 0
    ;;
  status)
    docker ps --filter "name=$NAME" --format '{{.Names}} {{.Status}}'
    exit 0
    ;;
  up) ;;
  *)
    echo "usage: $0 [up|down|status]" >&2
    exit 1
    ;;
esac

# Stable per-checkout token so repeated up/down keeps adapter envs valid.
if [ ! -f "$TOKEN_FILE" ]; then
  head -c 32 /dev/urandom | base64 | tr -d '/+=' > "$TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"

echo "scrape-stack: building $IMAGE ..."
docker build -q -t "$IMAGE" "$REPO_ROOT/scrape-service" >/dev/null

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -p "$PORT:8080" \
  -e "SCRAPE_SERVICE_TOKEN=$TOKEN" \
  --shm-size=1g \
  "$IMAGE" >/dev/null

echo -n "scrape-stack: waiting for /health "
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo ""
    echo "scrape-stack: ready"
    echo "  SCRAPE_SERVICE_URL=http://127.0.0.1:$PORT"
    echo "  SCRAPE_SERVICE_TOKEN=$TOKEN"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo ""
echo "scrape-stack: /health never came up; last logs:" >&2
docker logs --tail 40 "$NAME" >&2
exit 1
