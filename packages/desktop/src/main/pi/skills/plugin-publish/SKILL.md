---
name: plugin-publish
description: Packages, authenticates, and publishes standard Pi Extension plugins to a Meta Agent Desktop marketplace. Use for marketplace account registration or login, publisher membership setup, artifact assembly, draft creation, upload, publication, verification, deprecation, or draft deletion.
compatibility: Meta Agent Desktop Marketplace Protocol v1 and Desktop Host Profile v1.
---

# Publish a Desktop Plugin

Use this skill after the plugin itself is implemented and validated. Plugin implementation and Desktop compatibility belong to `plugin-create`; this skill owns marketplace accounts, publisher authorization, distributable artifacts, and release lifecycle.

Read [references/API.md](references/API.md) before sending marketplace requests. Use only endpoints confirmed by marketplace discovery or that reference. Do not invent a CLI, upload route, manifest field, or signing flow.

## Trust and Secrets

Marketplace operations cross explicit trust boundaries:

- Registration and login handle user passwords and bearer session tokens.
- Publisher administration requires the server's static admin token; a user named `admin` is not automatically a server administrator.
- Artifact upload and version publication change public marketplace state. Publication is irreversible through the draft-delete API.
- Plugins are full-trust Node code, not sandboxed. Capability declarations are review metadata, not enforcement.

Never place passwords, session tokens, admin tokens, signing private keys, or SSH passwords in source, committed files, command-line arguments, logs, final responses, or persistent memory. Prefer an existing authenticated session. When temporary credential files are unavoidable, create them outside the plugin payload with owner-only permissions, use them for one operation, and remove them in a `finally`/trap path. Never upload `.env`, auth files, private keys, test fixtures containing credentials, or local configuration such as `~/.pi/web-search.json`.

## Workflow

1. Establish the marketplace URL and fetch `/.well-known/meta-agent-marketplace.json`. Parse the signed `{ data, signature }` envelope; protocol version, API root, marketplace ID, artifact origins, and Ed25519 signing identity are under `data`. Require explicit trust for a first-seen fingerprint, verify the envelope with the trusted Ed25519 public key, and never silently accept a changed fingerprint. `data.apiRoot` already includes `/v1`; do not append another `/v1`.
2. Establish account state:
   - Register only when the user asks to create an account and registration is enabled.
   - Login through `{apiRoot}/auth/login`; treat the returned bearer token as a secret.
   - Call `{apiRoot}/auth/me` and confirm the required `publisherId` appears in `publisherIds`.
   - If membership is absent, ask a marketplace administrator to create the publisher and add the username. Use the static admin token only when the user explicitly authorizes administrator operations.
3. Inspect the plugin entry, dependencies, license obligations, Host Profile compatibility, and all runtime behavior before packaging. Re-run focused typechecks and deterministic tests without paid provider calls.
4. Assemble a payload ZIP containing the entry and every non-host runtime dependency. The payload ZIP must not contain `market-manifest.json` or `signature.json`; the marketplace generates and signs those files.
5. Declare metadata, Desktop compatibility, capabilities, and one or more artifacts as a draft. Use a lowercase dotted plugin ID and a valid semver version.
6. Upload every declared artifact. Stop if the returned hash/size is missing or the server reports an incomplete version.
7. Before the final publish request, confirm the user has already asked to publish this plugin/version. Creating or replacing a draft is reversible; publishing makes it visible to clients and draft deletion no longer applies.
8. Publish the version, then verify the public plugin detail, version detail, artifact metadata, downloadable bytes, SHA-256, signed manifest, entry path, target, and capabilities.
9. Report plugin ID, version, status, target, size, SHA-256, compatibility, and residual platform or credential requirements. Do not report secrets.

## Artifact Rules

- The entry must be a regular `.ts`, `.js`, `.mjs`, or `.cjs` file with a default Pi Extension factory export.
- Keep Pi host packages external: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.
- Include all other runtime dependencies in the payload. Marketplace installation does not run `npm install`, lifecycle scripts, or on-device compilation.
- Bundle dependencies when an expanded dependency tree would exceed marketplace file-count or path limits. Test the bundled entry itself, not only the source entry.
- The current Marketplace Server artifact builder supports pure JS/TS payloads only: it emits empty `nativeModules` and `executables` arrays and mode `0644` for every file. Do not publish `.node` addons, platform executables, or files that require execute permission, even if `containsNativeCode` or a platform-specific target can be declared; those metadata fields do not make the signed manifest executable/native-aware.
- Do not label platform-dependent pure JS code as universal. Declare one target per compatible platform/architecture as needed.
- Preserve required licenses and notices for bundled third-party code. Exclude tests, caches, source maps containing private paths, package-manager caches, local databases, credentials, and unrelated development files.
- Validate archive paths as payload-relative POSIX paths with no absolute paths, backslashes, empty segments, `.`/`..`, control characters, or case-normalized duplicates.
- Stay within operator-provided limits and server error responses. Protocol-v1 discovery does not advertise limits. The current reference server defaults to 32 MiB upload size, 1,024 files, and 256 characters per payload path.

## Capability Declaration

Declare capabilities from actual plugin behavior. Common mappings are:

- `pi.on(...)` -> `events.subscribe`
- `pi.registerTool(...)` -> `tools.register`
- `pi.registerCommand(...)` -> `commands.register`
- Provider registration -> `providers.register`
- `pi.sendMessage(...)` / queued model-visible messages -> `messages.enqueue` and, when custom messages are used, `messages.custom`
- Session entry reads or reconstruction -> `session.read`
- Abort or compaction requests -> `session.abort` / `session.compact`
- Supported Desktop UI calls -> the matching `ui.*` capabilities

Do not declare unsupported TUI capabilities to make a plugin appear compatible. Remove or adapt unsupported calls through `plugin-create` before publication.

## Release Failure Handling

- Metadata or draft declaration failure: correct the request; do not upload.
- Partial artifact upload: inspect publisher state and resume only missing artifacts for the same draft.
- Validation failure before publish: delete the draft when the user wants rollback.
- Published release mistake: do not try draft deletion. Publish a corrected version, deprecate the bad version, or request an administrator revocation for security incidents.
- Network timeout after a mutation: query publisher state before retrying. Never assume failure means the server did not commit.
- Signing fingerprint change: stop and require explicit trust confirmation.

## Verification

Before declaring publication complete:

1. The source and final packaged entry both load against the installed Pi host.
2. Every registered tool, command, and event path has deterministic focused coverage.
3. The payload contains all non-host runtime dependencies and required notices, with no secret or local-only files.
4. The server reports every draft artifact uploaded before publication.
5. The public catalog reports the intended version as `available`.
6. Downloaded artifact bytes match the advertised SHA-256 and size.
7. The signed manifest names the expected plugin, version, entry, target, Host Profile, capabilities, and complete payload file set.
8. Temporary tokens, passwords, ZIPs, scripts, and credential files are removed unless the user explicitly asked to retain a non-secret artifact.
