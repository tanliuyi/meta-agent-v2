# Marketplace Publish API v1

Fetch `GET /.well-known/meta-agent-marketplace.json` from the marketplace public base URL. The response is a signed `{ data, signature }` envelope. Trust and verify the Ed25519 signing identity before using `data.apiRoot`; that value already ends in `/v1`. Every route below is relative to the exact `{apiRoot}` value, so never insert a second `/v1`. All authenticated requests use `Authorization: Bearer <token>`. JSON requests use `Content-Type: application/json`; artifact uploads use a raw `application/zip` or `application/octet-stream` body.

## Discovery and Accounts

### Register

`POST {apiRoot}/auth/register`

```json
{
  "username": "alice",
  "password": "secret-from-secure-input"
}
```

Registration returns a 30-day user session token and can be disabled by the marketplace.

### Login

`POST {apiRoot}/auth/login`

```json
{
  "username": "alice",
  "password": "secret-from-secure-input"
}
```

### Current Principal

`GET {apiRoot}/auth/me`

A normal publisher user returns:

```json
{
  "admin": false,
  "user": { "username": "alice", "createdAt": 0 },
  "publisherIds": ["acme"]
}
```

The static server admin token returns `admin: true`; the username `admin` has no special meaning.

### Logout

`POST {apiRoot}/auth/logout` returns `204` and invalidates the supplied user session token.

## Publisher Administration

These routes require the static server admin token:

- `GET {apiRoot}/admin/publishers`
- `PUT {apiRoot}/admin/publishers/:publisherId`
- `PUT {apiRoot}/admin/publishers/:publisherId/members/:username`
- `DELETE {apiRoot}/admin/publishers/:publisherId/members/:username`

Create or update a publisher:

```json
{
  "displayName": "Acme",
  "verified": false
}
```

Adding a member has no JSON body. Confirm the user exists first.

## Plugin Metadata

`PUT {apiRoot}/publish/plugins/:pluginId`

The caller must be a member of `publisherId` or use the static admin token. Plugin IDs must match a lowercase dotted identifier such as `com.acme.tools`.

```json
{
  "name": "Acme Tools",
  "description": "Automation tools for Desktop.",
  "publisherId": "acme",
  "categories": ["productivity"],
  "iconAssetId": "optional-icon-id"
}
```

`GET {apiRoot}/publish/plugins/:pluginId` returns publisher-visible state including drafts and upload completion.

## Draft Version

`POST {apiRoot}/publish/plugins/:pluginId/versions`

```json
{
  "version": "1.0.0",
  "changelog": "Initial release.",
  "desktop": {
    "hostProfileVersion": 1,
    "minVersion": "0.0.31",
    "maxVersionExclusive": "0.1.0"
  },
  "capabilities": ["tools.register", "events.subscribe", "configuration.read"],
  "configuration": {
    "version": 1,
    "fields": [
      {
        "key": "endpoint",
        "label": "API Endpoint",
        "type": "text",
        "required": true,
        "defaultValue": "https://api.example.com"
      },
      {
        "key": "apiKey",
        "label": "API Key",
        "type": "secret",
        "required": true
      }
    ]
  },
  "artifacts": [
    {
      "id": "universal",
      "target": {
        "platform": "universal",
        "arch": "universal"
      },
      "entry": "index.mjs",
      "containsNativeCode": false,
      "preferred": true
    }
  ]
}
```

`version` and optional Desktop bounds must be valid semver. Artifact IDs must be unique. `entry` is relative to the uploaded payload ZIP root.

`configuration` is optional signed metadata for Desktop's host-rendered plugin settings form. It must use schema `version: 1`, contain at most 64 unique fields, and may use `text`, `textarea`, `path`, `number`, `boolean`, `select`, or `secret`. Each field requires a stable `key` and user-facing `label`; type-specific defaults and constraints are validated by the marketplace before the draft is created. Plugins read the immutable runtime values through `pi.getConfig()`. Declare `configuration.read` when configuration is used. Secret values are supplied by users after installation and must never be included in the schema as defaults.

Target fields supported by protocol v1:

- `platform`
- `arch`
- optional `nodeVersion`
- optional `modulesAbi`
- optional `minimumNapi`
- optional `osRelease`
- optional `libc`
- optional `toolchain`
- optional `piVersion`
- optional `runtimeCompatibilityId`

Current server limitation: artifact construction always emits `nativeModules: []`, `executables: []`, and file mode `0644`. Publish only pure JS/TS payloads and set `containsNativeCode: false`. A platform-specific target does not make native addons or executables installable.

## Artifact Upload

`PUT {apiRoot}/publish/plugins/:pluginId/versions/:version/artifacts/:artifactId`

Send the payload ZIP as the raw request body. The ZIP contains payload files only. The server validates and repacks it as a signed `.meta-plugin` with:

```text
market-manifest.json
signature.json
payload/<entry and support files>
```

Successful upload returns:

```json
{
  "pluginId": "com.acme.tools",
  "version": "1.0.0",
  "artifactId": "universal",
  "sha256": "...",
  "size": 12345
}
```

The hash and size describe the final signed archive, not the uploaded payload ZIP.

## Publish and Lifecycle

Publish an uploaded draft:

`POST {apiRoot}/publish/plugins/:pluginId/versions/:version/publish`

The request fails when declared artifacts are incomplete. Success exposes the version through the public read API.

Delete an unpublished draft:

`DELETE {apiRoot}/publish/plugins/:pluginId/versions/:version`

Deprecate a published version:

`POST {apiRoot}/publish/plugins/:pluginId/versions/:version/deprecate`

Published versions cannot be deleted through the draft endpoint. Security withdrawal or blocking requires the static server admin token:

`POST {apiRoot}/admin/revocations`

```json
{
  "pluginId": "com.acme.tools",
  "version": "1.0.0",
  "status": "withdrawn",
  "reasonCode": "security-incident",
  "message": "Withdrawn while a corrected release is prepared.",
  "artifactIds": ["universal"],
  "replacementVersion": "1.0.1"
}
```

`status` must be `withdrawn` or `blocked`. `artifactIds` and `replacementVersion` are optional; `replacementVersion`, when present, must be valid semver. `artifactIds` is recorded as revocation metadata but does not scope enforcement: the server changes the whole version status, and every artifact in that version becomes unavailable. Use revocation only with explicit administrator authorization.

## Public Verification

After publication, verify:

- `GET {apiRoot}/plugins/:pluginId`
- `GET {apiRoot}/plugins/:pluginId/versions/:version`
- `GET {apiRoot}/plugins/:pluginId/versions/:version/artifacts`
- `GET {apiRoot}/plugins/:pluginId/versions/:version/artifacts/:artifactId/download`
- download URL returned by the previous endpoint
- `GET {apiRoot}/revocations`

Recompute the downloaded archive SHA-256 and compare its byte length with catalog metadata. Verify `signature.json` over canonical JSON for `market-manifest.json` using the Ed25519 public key from discovery. Canonical JSON recursively sorts object keys while preserving array order.

## Important Error Semantics

- `401`: missing, invalid, expired, or logged-out token.
- `403 PUBLISHER_MEMBERSHIP_REQUIRED`: authenticated user is not authorized for that publisher/plugin.
- `404`: plugin/version/artifact does not exist for that route.
- `409`: state conflict such as duplicate draft/version, incomplete version, already published/deprecated, or publisher mismatch.
- `410`: artifact listing, download metadata, or artifact bytes were requested for a withdrawn or blocked version. Version detail remains readable and reports the revoked status.
- `413`: artifact upload exceeds server size limits.
- `429 AUTH_RATE_LIMITED`: repeated failed logins exceeded the configured window.

After a timeout or connection loss on any mutation, query publisher state before retrying to avoid duplicate version or publication operations.
