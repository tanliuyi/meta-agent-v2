# Plugin Marketplace Server

NestJS backend for the Meta Agent Desktop plugin marketplace protocol. It is a standalone workspace package and does not use Pi's npm/git package distribution.

## Development

```bash
npm install --ignore-scripts
set -a
. packages/plugin-marketplace-server/.env.example
set +a
npm --prefix packages/plugin-marketplace-server run dev
```

The server reads the process environment directly; it does not load `.env` files implicitly. The default development server listens on `127.0.0.1:4317`. Ephemeral signing keys are rejected unless `MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY=true` is set explicitly. Production deployments must provide `MARKETPLACE_SIGNING_PRIVATE_KEY` as a base64-encoded PKCS#8 PEM value.

## Endpoints

- `GET /.well-known/meta-agent-marketplace.json`
- `GET /health`
- `GET /v1/plugins`
- `GET /v1/plugins/:pluginId`
- `GET /v1/plugins/:pluginId/versions`
- `GET /v1/plugins/:pluginId/versions/:version`
- `GET /v1/plugins/:pluginId/versions/:version/artifacts`
- `GET /v1/plugins/:pluginId/versions/:version/artifacts/:artifactId/download`
- `GET /v1/artifacts/:pluginId/:version/:artifactId`
- `GET /v1/revocations`

`MARKETPLACE_BASE_PATH` prefixes every endpoint for reverse-proxy deployments. `MARKETPLACE_PUBLIC_BASE_URL` is the externally visible HTTP or HTTPS base URL returned in discovery metadata. `MARKETPLACE_ARTIFACT_ORIGINS` is a comma-separated HTTP(S) allowlist added to the server's own public origin. HTTP is supported for internal deployments regardless of signing-key policy; operators remain responsible for the confidentiality and integrity properties of their transport network.

The catalog in `catalog/plugins.json` is deterministic seed data. The server generates and caches a signed `.meta-plugin` reference artifact for each catalog artifact identity, reports its actual SHA-256 and size, and serves it from the fixed `/v1/artifacts/...` route. It never serves a catalog-supplied local path.

Each archive contains canonical `market-manifest.json`, detached `signature.json`, and declared files beneath `payload/`. The Ed25519 signature covers the exact canonical manifest bytes; the download metadata covers the complete archive SHA-256 and byte size. Artifact URLs are short-lived transport metadata and are not plugin identity. Replace the seed repository and generated reference artifacts through their service boundaries when persistent storage is introduced.

## Docker deployment

The production container uses a multi-stage Node 22 Alpine build, runs as the unprivileged `node` user, has a read-only root filesystem, and binds the host port only on the configured Tailscale address.

The project deployment workflow targets `100.91.230.10` by default:

```bash
# Preferred: SSH key authentication
packages/plugin-marketplace-server/deploy.sh

# Temporary password authentication; the password is not stored by the script.
SSHPASS='<password>' packages/plugin-marketplace-server/deploy.sh
```

Defaults:

- Remote root: `/opt/meta-agent-plugin-marketplace`
- Compose project: `/opt/meta-agent-plugin-marketplace/repo/packages/plugin-marketplace-server`
- Public URL: `http://100.91.230.10:4317`
- Host binding: `100.91.230.10:4317`
- Marketplace ID: `meta-agent-development`

On the first deployment, the script generates an Ed25519 key locally and writes only its base64 PKCS#8 value to the remote `.env.production` with mode `0600`. Subsequent deployments preserve that file so the marketplace fingerprint remains stable. Back up `.env.production` separately; deleting it creates a new marketplace identity that Desktop clients must confirm again.

Override the SSH destination or remote root without editing tracked files:

```bash
MARKETPLACE_DEPLOY_HOST=100.91.230.10 \
MARKETPLACE_DEPLOY_USER=root \
MARKETPLACE_DEPLOY_ROOT=/opt/meta-agent-plugin-marketplace \
packages/plugin-marketplace-server/deploy.sh
```

Each deployment builds `meta-agent-plugin-marketplace:<UTC timestamp>` and records `.current-image` and `.previous-image` beside the Compose file. If the new service does not pass `/health`, the script recreates the service from `.previous-image` without rebuilding. The signing environment is preserved across image rollback.

After deployment, the script requires both `/health` and `/.well-known/meta-agent-marketplace.json` to succeed. Operational checks:

```bash
ssh root@100.91.230.10 \
  'cd /opt/meta-agent-plugin-marketplace/repo/packages/plugin-marketplace-server && docker compose ps'

curl --fail http://100.91.230.10:4317/health
curl --fail http://100.91.230.10:4317/.well-known/meta-agent-marketplace.json

# Manual image rollback
ssh root@100.91.230.10 '
  cd /opt/meta-agent-plugin-marketplace/repo/packages/plugin-marketplace-server
  previous=$(cat .previous-image)
  MARKETPLACE_IMAGE="$previous" docker compose up -d --no-build --force-recreate plugin-marketplace
'
```

## Validation

```bash
npm --prefix packages/plugin-marketplace-server run typecheck
npm --prefix packages/plugin-marketplace-server test
bash -n packages/plugin-marketplace-server/deploy.sh
docker compose -f packages/plugin-marketplace-server/compose.yaml config
```
