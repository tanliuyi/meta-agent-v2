# Plugin Marketplace Server

NestJS backend for the Meta Agent Desktop plugin marketplace protocol. It is a standalone workspace package and does not use Pi's npm/git package distribution.

## Prerequisites

- Node.js >= 22.19.0
- A PostgreSQL 15+ database (local or remote)
- The `pg` driver (bundled in `node_modules`)

## Development

```bash
npm install --ignore-scripts
# `packages/plugin-marketplace-server/.env.develop` contains the development configuration.
npm --prefix packages/plugin-marketplace-server run dev
```

The development script always uses an ephemeral signing key and ignores `MARKETPLACE_SIGNING_PRIVATE_KEY` from the shell. It loads `packages/plugin-marketplace-server/.env.develop` when present, falling back to the git-ignored `.env` used by older checkouts. The development server listens on `127.0.0.1:4317` by default.

### Environment variables (development `.env.develop`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `MARKETPLACE_DATABASE_URL` | Yes | — | PostgreSQL connection URL, e.g. `postgresql://user:password@host:5432/database` |
| `MARKETPLACE_MINIO_ENDPOINT` | Yes | — | MinIO S3 API origin, e.g. `http://127.0.0.1:9000` (not the console on port 9001) |
| `MARKETPLACE_MINIO_ACCESS_KEY` | Yes | — | MinIO access key |
| `MARKETPLACE_MINIO_SECRET_KEY` | Yes | — | MinIO secret key |
| `MARKETPLACE_MINIO_BUCKET` | No | `meta-agent-plugins` | Bucket used for plugin artifacts |
| `MARKETPLACE_MINIO_REGION` | No | `us-east-1` | MinIO bucket region |
| `MARKETPLACE_ALLOW_EPHEMERAL_SIGNING_KEY` | No | `true` in dev | Generate a fresh signing key on each start (dev only) |
| `MARKETPLACE_ADMIN_TOKEN` | No | — | Static admin bearer token; generate one locally for development |
| `MARKETPLACE_HOST` | No | `127.0.0.1` | HTTP listen address |
| `MARKETPLACE_PORT` | No | `4317` | HTTP listen port |
| `MARKETPLACE_BASE_PATH` | No | — | URL path prefix for reverse-proxy deployments |
| `MARKETPLACE_PUBLIC_BASE_URL` | No | `http://{host}:{port}{basePath}` | Externally visible base URL |
| `MARKETPLACE_ID` | No | `meta-agent-development` | Marketplace identifier |
| `MARKETPLACE_SIGNING_PRIVATE_KEY` | No (dev) | — | Base64-encoded PKCS#8 Ed25519 private key |
| `MARKETPLACE_MAX_ARTIFACT_BYTES` | No | 33554432 | Maximum uploaded artifact size in bytes |
| `MARKETPLACE_ALLOW_REGISTRATION` | No | `true` | Whether new user accounts can self-register |
| `MARKETPLACE_MAX_LOGIN_FAILURES` | No | `10` | Failed login attempts before rate-limiting; `0` disables |
| `MARKETPLACE_ARTIFACT_ORIGINS` | No | — | Comma-separated HTTP(S) origins allowed for artifact hosting |

The development script (`scripts/dev.mjs`) loads `.env.develop` when it exists and otherwise falls back to `.env`. The startup entry point (`main.ts`) reads environment variables directly and does not load an environment file automatically; production environments set variables through Docker Compose or systemd.

## Endpoints

Public read API:

- `GET /.well-known/meta-agent-marketplace.json`
- `GET /health`
- `GET /v1/plugins`
- `GET /v1/plugins/:pluginId`
- `GET /v1/plugins/:pluginId/versions`
- `GET /v1/plugins/:pluginId/versions/:version`
- `GET /v1/plugins/:pluginId/versions/:version/artifacts`
- `GET /v1/plugins/:pluginId/versions/:version/artifacts/:artifactId/download`
- `GET /v1/plugins/:pluginId/ratings`
- `GET /v1/plugins/:pluginId/stats`
- `GET /v1/artifacts/:pluginId/:version/:artifactId`
- `GET /v1/revocations`

Accounts (`Authorization: Bearer <token>` where noted):

- `POST /v1/auth/register` — `{ username, password }`, disabled when `MARKETPLACE_ALLOW_REGISTRATION=false`
- `POST /v1/auth/login`
- `POST /v1/auth/logout` (auth)
- `GET /v1/auth/me` (auth)

Ratings (user account token):

- `PUT /v1/plugins/:pluginId/rating` — `{ stars: 1..5, review? }`, one rating per user, upsert
- `DELETE /v1/plugins/:pluginId/rating`

Publishing (publisher member or admin token):

- `GET /v1/publish/plugins` — list plugins managed by the current publisher memberships, including drafts
- `GET /v1/publish/plugins/:pluginId` — publisher view including drafts
- `PUT /v1/publish/plugins/:pluginId` — create or update plugin metadata
- `POST /v1/publish/plugins/:pluginId/versions` — declare a draft version and its artifacts
- `PUT /v1/publish/plugins/:pluginId/versions/:version/artifacts/:artifactId` — upload a payload zip (`application/zip` or `application/octet-stream` raw body)
- `POST /v1/publish/plugins/:pluginId/versions/:version/publish`
- `POST /v1/publish/plugins/:pluginId/versions/:version/deprecate`
- `DELETE /v1/publish/plugins/:pluginId/versions/:version` — drafts only

Administration (`MARKETPLACE_ADMIN_TOKEN` bearer token):

- `GET /v1/admin/publishers`
- `PUT /v1/admin/publishers/:publisherId` — `{ displayName, verified }`
- `PUT /v1/admin/publishers/:publisherId/members/:username`
- `DELETE /v1/admin/publishers/:publisherId/members/:username`
- `POST /v1/admin/revocations` — `{ pluginId, version, status: withdrawn|blocked, reasonCode, message, artifactIds?, replacementVersion? }`

`MARKETPLACE_BASE_PATH` prefixes every endpoint for reverse-proxy deployments. `MARKETPLACE_PUBLIC_BASE_URL` is the externally visible HTTP or HTTPS base URL returned in discovery metadata. `MARKETPLACE_ARTIFACT_ORIGINS` is a comma-separated HTTP(S) allowlist added to the server's own public origin. HTTP is supported for internal deployments regardless of signing-key policy; operators remain responsible for the confidentiality and integrity properties of their transport network.

## Storage and accounts

State lives in a PostgreSQL database via the `pg` driver (no native SQLite dependencies). When the database is empty on first startup, the server creates all required tables and seeds the catalog from `catalog/plugins.json`. A PostgreSQL advisory transaction lock prevents concurrent seeding.

Accounts are username/password (scrypt-hashed) with 30-day bearer session tokens. The admin surface uses the static `MARKETPLACE_ADMIN_TOKEN` instead of a user account; admins create publishers and grant publish rights by adding usernames as publisher members. Failed logins are throttled per client IP: after `MARKETPLACE_MAX_LOGIN_FAILURES` failures (default 10) within a 15-minute window, further login attempts return `429 AUTH_RATE_LIMITED` until the window expires. A successful login resets the counter; `0` disables throttling.

### Database setup

The server expects the target database to already exist. It creates tables and indexes automatically on startup. To create the database:

```sql
CREATE DATABASE plugin_marketplace;
```

The connecting user must have `CREATE` privileges on the public schema (or a dedicated schema set via `search_path`).

## Publishing workflow

1. Admin: `PUT /v1/admin/publishers/acme` then `PUT /v1/admin/publishers/acme/members/alice`.
2. Publisher: `PUT /v1/publish/plugins/com.acme.tools` with name, description, categories, and `publisherId`.
3. Declare a draft version with changelog, Desktop compatibility, capabilities, and artifact metadata including each artifact's `entry` (payload-relative) and target.
4. Upload each artifact as a zip of payload files. The server validates the archive (path safety, duplicate case-normalized paths, file-count and size limits), builds the canonical `market-manifest.json`, signs it with the marketplace key, and repacks a deterministic `.meta-plugin` archive containing `market-manifest.json`, `signature.json`, and `payload/**`.
5. `POST .../publish` makes the version publicly listed; drafts are invisible to the read API. Publishers can deprecate published versions; withdrawing or blocking goes through `POST /v1/admin/revocations`, which also feeds the signed `/v1/revocations` list.

Uploads are capped by `MARKETPLACE_MAX_ARTIFACT_BYTES` (default 32 MiB). The download metadata always reports the final signed archive SHA-256 and byte size, and `/v1/artifacts/...` serves the stored bytes; catalog-supplied local paths are never served.

## Ratings and download statistics

Authenticated users can rate each plugin once (1..5 stars plus optional review); ratings aggregate into `rating: { count, average }` on plugin summaries and details, with a histogram and recent entries on `/v1/plugins/:pluginId/ratings`. Artifact byte downloads increment per-version counters exposed as `downloadCount` on summaries/details and as totals on `/v1/plugins/:pluginId/stats`. These marketplace-level fields are additive; Desktop clients that only validate the core catalog contract ignore them.

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

On the first deployment, the script generates an Ed25519 key and an admin token locally and writes them to the remote `.env.production` with mode `0600`. It reads `MARKETPLACE_DATABASE_URL` from the shell or the development environment file; the connection URL is never stored in the tracked deployment script. Subsequent deployments preserve the remote file so the marketplace fingerprint remains stable. Back up `.env.production` separately; deleting it creates a new marketplace identity that Desktop clients must confirm again.

The container does not persist state locally; all data lives in the configured PostgreSQL database. Back up the database with standard PostgreSQL tools (`pg_dump`, WAL archival, or replication).

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
# Integration tests require MARKETPLACE_TEST_DATABASE_URL
MARKETPLACE_TEST_DATABASE_URL=postgresql://user:password@host:5432/test_db npm --prefix packages/plugin-marketplace-server test
bash -n packages/plugin-marketplace-server/deploy.sh
docker compose -f packages/plugin-marketplace-server/compose.yaml config
```

## Backup and restore

The database is the single source of truth for accounts, published plugins, ratings, and download counters. Use standard PostgreSQL backup procedures:

```bash
pg_dump -h 100.91.230.10 -U root -d plugin_marketplace > marketplace_backup.sql
```

To restore:

```bash
psql -h 100.91.230.10 -U root -d plugin_marketplace < marketplace_backup.sql
```

Also back up `.env.production` separately; it contains the signing private key and admin token.
