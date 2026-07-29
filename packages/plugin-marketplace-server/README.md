# Plugin Marketplace Server

NestJS backend for the Meta Agent Desktop plugin marketplace protocol. It is a standalone workspace package and does not use Pi's npm/git package distribution.

## Development

```bash
npm install --ignore-scripts
MARKETPLACE_DATABASE_URL='postgres://root:<password>@100.91.230.10:5432/plugin_marketplace' \
  npm --prefix packages/plugin-marketplace-server run dev
```

The default development server listens on `127.0.0.1:4317`. It reads settings from the process environment and does not load `.env` files implicitly. `MARKETPLACE_DATABASE_URL` must point to a PostgreSQL database unless a pool is injected by a test.

## Architecture

- `src/database/` owns the PostgreSQL pool, schema, catalog seed, transaction boundaries, and focused user, publisher, plugin, rating, and download stores.
- `src/http/` owns NestJS controller factories, HTTP validation/error mapping, and API response mapping.
- Root `src/` modules contain application assembly, protocol contracts, catalog validation/querying, authentication primitives, and artifact building.
- `scripts/` contains development and one-time operational commands; `test/pg-mem-helper.ts` provides isolated PostgreSQL-compatible test databases.

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

`MARKETPLACE_BASE_PATH` prefixes every endpoint for reverse-proxy deployments. `MARKETPLACE_PUBLIC_BASE_URL` is the externally visible HTTP or HTTPS base URL returned in discovery metadata.

## Storage and accounts

State lives in PostgreSQL through the `pg` connection pool configured by `MARKETPLACE_DATABASE_URL`. Startup creates missing tables and seeds `catalog/plugins.json` only when the database has not previously been seeded. A transaction-scoped PostgreSQL advisory lock serializes schema seeding across concurrent server instances.

Artifact archives from new uploads are stored in `BYTEA`; accounts, sessions, publisher memberships, ratings, and download counters are stored in relational tables. For compatibility with the already deployed PostgreSQL schema, rows that have an `object_key` but no `bytes` are read from the path beneath `MARKETPLACE_DATA_DIR`; path traversal and SHA-256/size mismatches are rejected. Tests inject isolated pg-mem pools and never use the configured production database.

### Migrating an existing SQLite database

Stop the marketplace server and back up both the SQLite file and PostgreSQL database. The destination PostgreSQL database must be empty; the migration aborts if any marketplace table already contains rows.

```bash
MARKETPLACE_DATABASE_URL='postgres://root:<password>@100.91.230.10:5432/plugin_marketplace' \
  npm --prefix packages/plugin-marketplace-server run migrate:sqlite -- /path/to/marketplace.db
```

The command copies catalog state, accounts, sessions, publishers, memberships, plugin versions and artifacts, ratings, and download counters in one PostgreSQL transaction, then advances the users sequence. After it succeeds, add `MARKETPLACE_DATABASE_URL` to `.env.production` and start the PostgreSQL-backed server. Deployment scripts refuse to modify an existing SQLite-era environment automatically. The server does not automatically import SQLite files.

Accounts are username/password (scrypt-hashed) with 30-day bearer session tokens. The admin surface uses the static `MARKETPLACE_ADMIN_TOKEN` instead of a user account; admins create publishers and grant publish rights by adding usernames as publisher members. Failed logins are throttled per client IP: after `MARKETPLACE_MAX_LOGIN_FAILURES` failures (default 10) within a 15-minute window, further login attempts return `429 AUTH_RATE_LIMITED` until the window expires. A successful login resets the counter; `0` disables throttling.

## Publishing workflow

1. Admin: `PUT /v1/admin/publishers/acme` then `PUT /v1/admin/publishers/acme/members/alice`.
2. Publisher: `PUT /v1/publish/plugins/com.acme.tools` with name, description, categories, and `publisherId`.
3. Declare a draft version with changelog, Desktop compatibility, capabilities, and artifact metadata including each artifact's `entry` (payload-relative) and target.
4. Upload each artifact as a zip of payload files. The server validates the archive (path safety, duplicate case-normalized paths, file-count and size limits), builds the canonical `market-manifest.json`, and repacks a deterministic `.meta-plugin` archive containing `market-manifest.json` and `payload/**`.
5. `POST .../publish` makes the version publicly listed; drafts are invisible to the read API. Publishers can deprecate published versions.

Uploads are capped by `MARKETPLACE_MAX_ARTIFACT_BYTES` (default 32 MiB). The download metadata reports the final archive SHA-256 as an opaque artifact key plus the byte size, and `/v1/artifacts/...` serves the stored bytes; catalog-supplied local paths are never served.

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

On the first deployment, set `MARKETPLACE_DATABASE_URL` in the deploy command environment. The script generates an admin token locally and writes both values to the remote `.env.production` with mode `0600`. Subsequent deployments preserve that file. Deployments upgrading from SQLite must run the migration command above and add the URL to `.env.production` before deployment; the scripts deliberately stop when an existing environment has no database URL.

The Compose file temporarily retains the legacy `marketplace-data` volume and `MARKETPLACE_DATA_DIR=/data` so rollback to the previous SQLite image remains possible during the migration window and PostgreSQL rows with legacy `object_key` artifacts remain downloadable. New PostgreSQL uploads use `BYTEA`. Remove the legacy volume only after all object-key artifacts have been backfilled or retired and the rollback path has been verified.

Back up the PostgreSQL database and `.env.production` independently. Deleting `.env.production` resets the admin token and removes the server's database connection configuration.

Override the SSH destination or remote root without editing tracked files:

```bash
MARKETPLACE_DATABASE_URL='postgres://root:<password>@100.91.230.10:5432/plugin_marketplace' \
MARKETPLACE_DEPLOY_HOST=100.91.230.10 \
MARKETPLACE_DEPLOY_USER=root \
MARKETPLACE_DEPLOY_ROOT=/opt/meta-agent-plugin-marketplace \
packages/plugin-marketplace-server/deploy.sh
```

Each deployment builds `meta-agent-plugin-marketplace:<UTC timestamp>` and records `.current-image` and `.previous-image` beside the Compose file. If the new service does not pass `/health`, the script recreates the service from `.previous-image` without rebuilding.

### Gitea Actions deployment

The repository includes `.gitea/workflows/deploy-marketplace.yml` for the `marketplace-deploy` host runner. It is intentionally manual-only: pushing a branch does not build or deploy production. Open the workflow in Gitea, select the committed ref to deploy, and run it with `workflow_dispatch`.

The runner clones the selected commit from the local Gitea bare repository and runs `scripts/deploy-plugin-marketplace-local.sh`. Configure `MARKETPLACE_DATABASE_URL` in the runner environment before the first PostgreSQL deployment; the script stores it in the server's mode-`0600` `.env.production`. Validation and both application builds run in Docker, so the CentOS host does not need a working Node.js installation. The script deploys the server on port 4317 and the Web console on port 4318, verifies both health endpoints, and rolls back to the previous self-contained image after a failed replacement.

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
