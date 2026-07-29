#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_ROOT="${MARKETPLACE_DEPLOY_ROOT:-/opt/meta-agent-plugin-marketplace}"
DEPLOY_REPO="$DEPLOY_ROOT/repo"
SERVER_DIR="$DEPLOY_REPO/packages/plugin-marketplace-server"
WEB_DIR="$DEPLOY_REPO/packages/plugin-marketplace-web"
PUBLIC_URL="${MARKETPLACE_PUBLIC_BASE_URL:-http://100.91.230.10:4317}"
WEB_URL="${MARKETPLACE_WEB_URL:-http://127.0.0.1:4318}"
IMAGE_TAG="${MARKETPLACE_IMAGE_TAG:-${GITHUB_SHA:-$(date -u +%Y%m%dT%H%M%SZ)}}"
IMAGE_TAG="${IMAGE_TAG:0:64}"
SERVER_IMAGE="meta-agent-plugin-marketplace:$IMAGE_TAG"
WEB_IMAGE="meta-agent-plugin-marketplace-web:$IMAGE_TAG"

if [[ ! "$IMAGE_TAG" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  echo "Marketplace image tag contains invalid Docker tag characters" >&2
  exit 1
fi
if [[ "${MARKETPLACE_DATABASE_URL:-}" == *$'\n'* ]]; then
  echo "MARKETPLACE_DATABASE_URL must not contain newlines" >&2
  exit 1
fi

wait_for_url() {
  local url="$1"
  for attempt in {1..30}; do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null; then
      return 0
    fi
    if [[ "$attempt" -eq 30 ]]; then
      return 1
    fi
    sleep 2
  done
}

postgres_marketplace_state() {
  docker run --rm \
    -e MARKETPLACE_DATABASE_URL \
    -v "$REPO_ROOT:/workspace" \
    -w /workspace \
    node:22.22.1-bookworm \
    bash -lc 'test -d node_modules/pg || npm ci --ignore-scripts >&2; npm --silent --prefix packages/plugin-marketplace-server run postgres:state'
}

if [[ "${MARKETPLACE_SKIP_CHECK:-false}" != "true" ]]; then
  docker run --rm \
    -v "$REPO_ROOT:/workspace" \
    -w /workspace \
    node:22.22.1-bookworm \
    bash -lc 'npm ci --ignore-scripts && npm --prefix packages/plugin-marketplace-server run typecheck && cd packages/plugin-marketplace-server && node ../../node_modules/vitest/dist/cli.js --run test/config-and-catalog.test.ts test/marketplace-http.test.ts test/marketplace-accounts-publish.test.ts && cd ../plugin-marketplace-web && npx tsc --noEmit -p tsconfig.app.json && npx tsc --noEmit -p tsconfig.node.json'
fi

mkdir -p "$SERVER_DIR" "$WEB_DIR"
rsync -a \
  "$REPO_ROOT/package.json" \
  "$REPO_ROOT/package-lock.json" \
  "$REPO_ROOT/tsconfig.base.json" \
  "$REPO_ROOT/.dockerignore" \
  "$DEPLOY_REPO/"
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .env.production \
  --exclude .postgres-cutover-pending \
  "$REPO_ROOT/packages/plugin-marketplace-server/" \
  "$SERVER_DIR/"
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  "$REPO_ROOT/packages/plugin-marketplace-web/" \
  "$WEB_DIR/"

SERVER_CONTAINER="$(cd "$SERVER_DIR" && docker compose ps -q plugin-marketplace)"
SERVER_PREVIOUS=""
if [[ -n "$SERVER_CONTAINER" ]]; then
  SERVER_PREVIOUS="$(docker inspect --format='{{.Config.Image}}' "$SERVER_CONTAINER")"
  printf '%s\n' "$SERVER_PREVIOUS" > "$SERVER_DIR/.previous-image"
fi

ENV_PATH="$SERVER_DIR/.env.production"
CUTOVER_MARKER="$SERVER_DIR/.postgres-cutover-pending"
POSTGRES_CUTOVER=false
if [[ -f "$CUTOVER_MARKER" ]]; then
  POSTGRES_CUTOVER=true
fi
if [[ ! -f "$ENV_PATH" ]]; then
  if [[ -z "${MARKETPLACE_DATABASE_URL:-}" ]]; then
    echo "MARKETPLACE_DATABASE_URL is required for the initial PostgreSQL deployment" >&2
    exit 1
  fi
  ADMIN_TOKEN="$(openssl rand -hex 32)"
  umask 077
  {
    printf 'MARKETPLACE_HOST=0.0.0.0\n'
    printf 'MARKETPLACE_PORT=4317\n'
    printf 'MARKETPLACE_BASE_PATH=\n'
    printf 'MARKETPLACE_PUBLIC_BASE_URL=%s\n' "$PUBLIC_URL"
    printf 'MARKETPLACE_ID=meta-agent-development\n'
    printf 'MARKETPLACE_DATABASE_URL=%s\n' "$MARKETPLACE_DATABASE_URL"
    printf 'MARKETPLACE_ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN"
  } > "$ENV_PATH"
  unset ADMIN_TOKEN
else
  sed -i \
    -e '/^MARKETPLACE_ARTIFACT_ORIGINS=/d' \
    -e '/^MARKETPLACE_SIGNING_PRIVATE_KEY=/d' \
    -e '/^MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY=/d' \
    "$ENV_PATH"
  if ! grep -q '^MARKETPLACE_DATABASE_URL=' "$ENV_PATH"; then
    if [[ -z "${MARKETPLACE_DATABASE_URL:-}" ]]; then
      echo "MARKETPLACE_DATABASE_URL is required to migrate the existing SQLite deployment" >&2
      exit 1
    fi
    POSTGRES_STATE=""
    if ! POSTGRES_STATE="$(postgres_marketplace_state)"; then
      echo "Unable to inspect the configured PostgreSQL database" >&2
      exit 1
    fi
    case "$POSTGRES_STATE" in
      populated)
        echo "PostgreSQL contains a complete marketplace dataset; preparing cutover"
        ;;
      empty)
        echo "PostgreSQL is empty; run the documented SQLite migration before deployment" >&2
        exit 1
        ;;
      inconsistent)
        echo "PostgreSQL marketplace schema is partial or inconsistent; refusing cutover" >&2
        exit 1
        ;;
      *)
        echo "Unexpected PostgreSQL state: $POSTGRES_STATE" >&2
        exit 1
        ;;
    esac
    POSTGRES_CUTOVER=true
    : > "$CUTOVER_MARKER"
    printf 'MARKETPLACE_DATABASE_URL=%s\n' "$MARKETPLACE_DATABASE_URL" >> "$ENV_PATH"
  fi
fi
chmod 600 "$ENV_PATH"

if ! (
  cd "$SERVER_DIR"
  MARKETPLACE_IMAGE="$SERVER_IMAGE" docker compose up -d --build --remove-orphans
); then
  echo "Marketplace server replacement failed" >&2
  if [[ "$POSTGRES_CUTOVER" == "true" ]]; then
    echo "Not rolling back to writable SQLite after PostgreSQL cutover" >&2
  elif [[ -n "$SERVER_PREVIOUS" ]]; then
    (
      cd "$SERVER_DIR"
      MARKETPLACE_IMAGE="$SERVER_PREVIOUS" docker compose up -d --no-build --force-recreate plugin-marketplace
    )
  fi
  exit 1
fi
if ! wait_for_url "${PUBLIC_URL%/}/health"; then
  echo "Marketplace server health check failed" >&2
  if [[ "$POSTGRES_CUTOVER" == "true" ]]; then
    echo "Not rolling back to writable SQLite after PostgreSQL cutover" >&2
  elif [[ -n "$SERVER_PREVIOUS" ]]; then
    (
      cd "$SERVER_DIR"
      MARKETPLACE_IMAGE="$SERVER_PREVIOUS" docker compose up -d --no-build --force-recreate plugin-marketplace
    )
  fi
  exit 1
fi
rm -f "$CUTOVER_MARKER"
printf '%s\n' "$SERVER_IMAGE" > "$SERVER_DIR/.current-image"

WEB_PREVIOUS=""
WEB_CONTAINER="$(cd "$WEB_DIR" && docker compose ps -q web 2>/dev/null || true)"
if [[ -n "$WEB_CONTAINER" ]]; then
  WEB_PREVIOUS="$(docker inspect --format='{{.Config.Image}}' "$WEB_CONTAINER")"
  printf '%s\n' "$WEB_PREVIOUS" > "$WEB_DIR/.previous-image"
fi

(
  cd "$WEB_DIR"
  MARKETPLACE_WEB_IMAGE="$WEB_IMAGE" docker compose up -d --build --remove-orphans
)
if ! wait_for_url "${WEB_URL%/}/" || ! wait_for_url "${WEB_URL%/}/marketplace-api/v1/plugins?limit=1&includeIncompatible=true"; then
  echo "Marketplace web health check failed" >&2
  if [[ "$WEB_PREVIOUS" == meta-agent-plugin-marketplace-web:* ]]; then
    (
      cd "$WEB_DIR"
      MARKETPLACE_WEB_IMAGE="$WEB_PREVIOUS" docker compose up -d --no-build --force-recreate web
    )
  fi
  exit 1
fi
printf '%s\n' "$WEB_IMAGE" > "$WEB_DIR/.current-image"

printf 'Marketplace server deployed: %s\n' "$SERVER_IMAGE"
printf 'Marketplace web deployed: %s\n' "$WEB_IMAGE"
