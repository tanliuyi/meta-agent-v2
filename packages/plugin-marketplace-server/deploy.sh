#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_HOST="${MARKETPLACE_DEPLOY_HOST:-100.91.230.10}"
DEPLOY_USER="${MARKETPLACE_DEPLOY_USER:-root}"
DEPLOY_ROOT="${MARKETPLACE_DEPLOY_ROOT:-/opt/meta-agent-plugin-marketplace}"
PUBLIC_URL="${MARKETPLACE_PUBLIC_BASE_URL:-http://100.91.230.10:4317}"
WEB_URL="${MARKETPLACE_WEB_PUBLIC_URL:-http://100.91.230.10:4318}"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

IMAGE_TAG="${MARKETPLACE_IMAGE_TAG:-$(date -u +%Y%m%dT%H%M%SZ)}"
API_IMAGE="meta-agent-plugin-marketplace:${IMAGE_TAG}"
WEB_IMAGE="meta-agent-plugin-marketplace-web:${IMAGE_TAG}"
REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTIONS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

if [[ -n "${SSHPASS:-}" ]]; then
  command -v sshpass >/dev/null 2>&1 || {
    echo "SSHPASS is set but sshpass is unavailable" >&2
    exit 1
  }
  SSH_COMMAND=(sshpass -e ssh "${SSH_OPTIONS[@]}")
  RSYNC_SHELL="sshpass -e ssh ${SSH_OPTIONS[*]}"
else
  SSH_COMMAND=(ssh "${SSH_OPTIONS[@]}")
  RSYNC_SHELL="ssh ${SSH_OPTIONS[*]}"
fi

remote() {
  "${SSH_COMMAND[@]}" "$REMOTE" "$@"
}

random_secret() {
  node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"));'
}

assert_secret() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "ERROR: $name must be a non-empty single-line value" >&2
    exit 1
  fi
}

append_remote_env() {
  local key="$1"
  local value="$2"
  if ! remote "grep -q '^${key}=' '$ENV_PATH'"; then
    printf '%s=%s\n' "$key" "$value" | remote "umask 077; cat >> '$ENV_PATH'"
  fi
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
WEB_DIR="$DEPLOY_ROOT/repo/packages/plugin-marketplace-web"
ENV_PATH="$COMPOSE_DIR/.env.production"
remote "mkdir -p '$COMPOSE_DIR' '$WEB_DIR'"
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
  "$REMOTE:$COMPOSE_DIR/"
rsync -az --delete -e "$RSYNC_SHELL" \
  --exclude node_modules \
  --exclude dist \
  "$REPO_ROOT/packages/plugin-marketplace-web/" \
  "$REMOTE:$WEB_DIR/"

ADMIN_PASSWORD="${MARKETPLACE_DEFAULT_ADMIN_PASSWORD:-}"
SUPER_PASSWORD="${MARKETPLACE_DEFAULT_SUPER_PASSWORD:-}"
assert_secret MARKETPLACE_DEFAULT_ADMIN_PASSWORD "$ADMIN_PASSWORD"
assert_secret MARKETPLACE_DEFAULT_SUPER_PASSWORD "$SUPER_PASSWORD"

if ! remote "test -f '$ENV_PATH'"; then
  SIGNING_KEY="$({
    node --input-type=module -e '
      import { generateKeyPairSync } from "node:crypto";
      const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
      process.stdout.write(Buffer.from(pem).toString("base64"));
    '
  })"
  ADMIN_TOKEN="$(random_secret)"
  POSTGRES_PASSWORD="$(random_secret)"
  MINIO_SECRET="$(random_secret)"
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
    printf 'MARKETPLACE_DATABASE_URL=postgresql://marketplace:%s@postgres:5432/plugin_marketplace\n' "$POSTGRES_PASSWORD"
    printf 'MARKETPLACE_MINIO_ENDPOINT=http://minio:9000\n'
    printf 'MARKETPLACE_MINIO_ACCESS_KEY=marketplace\n'
    printf 'MARKETPLACE_MINIO_SECRET_KEY=%s\n' "$MINIO_SECRET"
    printf 'MARKETPLACE_MINIO_BUCKET=meta-agent-plugins\n'
    printf 'MARKETPLACE_MINIO_REGION=us-east-1\n'
    printf 'MARKETPLACE_DEFAULT_ADMIN_USERNAME=admin\n'
    printf 'MARKETPLACE_DEFAULT_ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD"
    printf 'MARKETPLACE_DEFAULT_SUPER_USERNAME=super\n'
    printf 'MARKETPLACE_DEFAULT_SUPER_PASSWORD=%s\n' "$SUPER_PASSWORD"
    printf 'MARKETPLACE_ALLOW_REGISTRATION=false\n'
    printf 'POSTGRES_USER=marketplace\n'
    printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
    printf 'POSTGRES_DB=plugin_marketplace\n'
    printf 'MINIO_ROOT_USER=marketplace\n'
    printf 'MINIO_ROOT_PASSWORD=%s\n' "$MINIO_SECRET"
  } | remote "umask 077; cat > '$ENV_PATH'"
  unset SIGNING_KEY ADMIN_TOKEN POSTGRES_PASSWORD MINIO_SECRET
else
  # 对旧部署做一次幂等补全，已有密钥和数据库连接不被覆盖。
  MINIO_SECRET="$(random_secret)"
  append_remote_env MARKETPLACE_MINIO_ENDPOINT http://minio:9000
  append_remote_env MARKETPLACE_MINIO_ACCESS_KEY marketplace
  append_remote_env MARKETPLACE_MINIO_SECRET_KEY "$MINIO_SECRET"
  append_remote_env MARKETPLACE_MINIO_BUCKET meta-agent-plugins
  append_remote_env MARKETPLACE_MINIO_REGION us-east-1
  append_remote_env MARKETPLACE_DEFAULT_ADMIN_USERNAME admin
  append_remote_env MARKETPLACE_DEFAULT_ADMIN_PASSWORD "$ADMIN_PASSWORD"
  append_remote_env MARKETPLACE_DEFAULT_SUPER_USERNAME super
  append_remote_env MARKETPLACE_DEFAULT_SUPER_PASSWORD "$SUPER_PASSWORD"
  append_remote_env MARKETPLACE_ALLOW_REGISTRATION false
  append_remote_env MINIO_ROOT_USER marketplace
  append_remote_env MINIO_ROOT_PASSWORD "$MINIO_SECRET"
  unset MINIO_SECRET
fi
unset ADMIN_PASSWORD SUPER_PASSWORD MARKETPLACE_DEFAULT_ADMIN_PASSWORD MARKETPLACE_DEFAULT_SUPER_PASSWORD

remote "set -eu; chmod 600 '$ENV_PATH'; cd '$COMPOSE_DIR'; api=\$(docker compose ps -q plugin-marketplace); web=\$(docker compose ps -q plugin-marketplace-web); if [ -n \"\$api\" ]; then docker inspect --format='{{.Config.Image}}' \"\$api\" > .previous-api-image; fi; if [ -n \"\$web\" ]; then docker inspect --format='{{.Config.Image}}' \"\$web\" > .previous-web-image; fi; MARKETPLACE_IMAGE='$API_IMAGE' MARKETPLACE_WEB_IMAGE='$WEB_IMAGE' docker compose up -d --build --remove-orphans"

rollback_remote() {
  remote "set -eu; cd '$COMPOSE_DIR'; test -s .previous-api-image; previous_api=\$(cat .previous-api-image); previous_web=\$(cat .previous-web-image 2>/dev/null || printf '%s' '$WEB_IMAGE'); MARKETPLACE_IMAGE=\"\$previous_api\" MARKETPLACE_WEB_IMAGE=\"\$previous_web\" docker compose up -d --no-build --force-recreate plugin-marketplace plugin-marketplace-web"
}

for attempt in {1..45}; do
  if curl --fail --silent --show-error --max-time 5 "${PUBLIC_URL%/}/health" >/dev/null && \
    curl --fail --silent --show-error --max-time 5 "${WEB_URL%/}/healthz" >/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 45 ]]; then
    echo "Marketplace health check failed" >&2
    rollback_remote || echo "No complete previous deployment was available for rollback" >&2
    exit 1
  fi
  sleep 2
done

remote "printf '%s\n' '$API_IMAGE' > '$COMPOSE_DIR/.current-api-image'; printf '%s\n' '$WEB_IMAGE' > '$COMPOSE_DIR/.current-web-image'"
curl --fail --silent --show-error "${PUBLIC_URL%/}/health"
printf '\n'
curl --fail --silent --show-error "${PUBLIC_URL%/}/.well-known/meta-agent-marketplace.json"
printf '\n'
curl --fail --silent --show-error "${WEB_URL%/}/healthz"
printf '\n'
