#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_HOST="${MARKETPLACE_DEPLOY_HOST:-100.91.230.10}"
DEPLOY_USER="${MARKETPLACE_DEPLOY_USER:-root}"
DEPLOY_ROOT="${MARKETPLACE_DEPLOY_ROOT:-/opt/meta-agent-plugin-marketplace}"
PUBLIC_URL="${MARKETPLACE_PUBLIC_BASE_URL:-http://100.91.230.10:4317}"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi
DATABASE_URL="${MARKETPLACE_DATABASE_URL:-}"
IMAGE_TAG="${MARKETPLACE_IMAGE_TAG:-$(date -u +%Y%m%dT%H%M%SZ)}"
IMAGE="meta-agent-plugin-marketplace:${IMAGE_TAG}"
REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTIONS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

if [[ -n "${SSHPASS:-}" ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "SSHPASS is set but sshpass is unavailable" >&2
    exit 1
  fi
  SSH_COMMAND=(sshpass -e ssh "${SSH_OPTIONS[@]}")
  RSYNC_SHELL="sshpass -e ssh ${SSH_OPTIONS[*]}"
else
  SSH_COMMAND=(ssh "${SSH_OPTIONS[@]}")
  RSYNC_SHELL="ssh ${SSH_OPTIONS[*]}"
fi

remote() {
  "${SSH_COMMAND[@]}" "$REMOTE" "$@"
}

command -v rsync >/dev/null 2>&1 || {
  echo "rsync is required" >&2
  exit 1
}
if [[ ! "$IMAGE_TAG" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  echo "MARKETPLACE_IMAGE_TAG contains invalid Docker tag characters" >&2
  exit 1
fi

COMPOSE_DIR="$DEPLOY_ROOT/repo/packages/plugin-marketplace-server"
remote "mkdir -p '$COMPOSE_DIR'"
rsync -az -e "$RSYNC_SHELL" \
  "$REPO_ROOT/package.json" \
  "$REPO_ROOT/package-lock.json" \
  "$REPO_ROOT/tsconfig.base.json" \
  "$REPO_ROOT/.dockerignore" \
  "$REMOTE:$DEPLOY_ROOT/repo/"
rsync -az --delete -e "$RSYNC_SHELL" \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude .env.production \
  "$SCRIPT_DIR/" \
  "$REMOTE:$DEPLOY_ROOT/repo/packages/plugin-marketplace-server/"

ENV_PATH="$DEPLOY_ROOT/repo/packages/plugin-marketplace-server/.env.production"
if remote "test -f '$ENV_PATH'"; then
  if ! remote "grep -q '^MARKETPLACE_DATABASE_URL=' '$ENV_PATH'"; then
    if [[ -z "$DATABASE_URL" ]]; then
      echo "ERROR: Existing $ENV_PATH is missing MARKETPLACE_DATABASE_URL and no local value is configured" >&2
      exit 1
    fi
    printf 'MARKETPLACE_DATABASE_URL=%s\n' "$DATABASE_URL" | remote "umask 077; cat >> '$ENV_PATH'"
  fi
else
  if [[ -z "$DATABASE_URL" ]]; then
    echo "ERROR: MARKETPLACE_DATABASE_URL is required in $SCRIPT_DIR/.env or the shell environment" >&2
    exit 1
  fi
  SIGNING_KEY="$({
    node --input-type=module -e '
      import { generateKeyPairSync } from "node:crypto";
      const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
      process.stdout.write(Buffer.from(pem).toString("base64"));
    '
  })"
  ADMIN_TOKEN="$({
    node --input-type=module -e '
      import { randomBytes } from "node:crypto";
      process.stdout.write(randomBytes(32).toString("base64url"));
    '
  })"
  {
    printf 'MARKETPLACE_HOST=0.0.0.0\n'
    printf 'MARKETPLACE_PORT=4317\n'
    printf 'MARKETPLACE_BASE_PATH=\n'
    printf 'MARKETPLACE_PUBLIC_BASE_URL=%s\n' "$PUBLIC_URL"
    printf 'MARKETPLACE_ID=meta-agent-development\n'
    printf 'MARKETPLACE_ARTIFACT_ORIGINS=\n'
    printf 'MARKETPLACE_SIGNING_PRIVATE_KEY=%s\n' "$SIGNING_KEY"
    printf 'MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY=false\n'
    printf 'MARKETPLACE_ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN"
    printf 'MARKETPLACE_DATABASE_URL=%s\n' "$DATABASE_URL"
  } | remote "umask 077; cat > '$ENV_PATH'"
  unset SIGNING_KEY
  unset ADMIN_TOKEN
fi
unset DATABASE_URL
unset MARKETPLACE_DATABASE_URL

remote "set -eu; chmod 600 '$ENV_PATH'; cd '$COMPOSE_DIR'; current=\$(docker compose ps -q plugin-marketplace); if [ -n \"\$current\" ]; then docker inspect --format='{{.Config.Image}}' \"\$current\" > .previous-image; fi; MARKETPLACE_IMAGE='$IMAGE' docker compose up -d --build --remove-orphans"

rollback_remote() {
  remote "set -eu; cd '$COMPOSE_DIR'; if [ ! -s .previous-image ]; then exit 1; fi; previous=\$(cat .previous-image); MARKETPLACE_IMAGE=\"\$previous\" docker compose up -d --no-build --force-recreate plugin-marketplace"
}

HEALTH_URL="${PUBLIC_URL%/}/health"
for attempt in {1..30}; do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    echo "Marketplace health check failed: $HEALTH_URL" >&2
    if rollback_remote; then
      echo "Rolled back to the previous marketplace image" >&2
    else
      echo "No previous marketplace image was available for rollback" >&2
    fi
    exit 1
  fi
  sleep 2
done

remote "printf '%s\n' '$IMAGE' > '$COMPOSE_DIR/.current-image'"
curl --fail --silent --show-error "$HEALTH_URL"
printf '\n'
curl --fail --silent --show-error "${PUBLIC_URL%/}/.well-known/meta-agent-marketplace.json"
printf '\n'
