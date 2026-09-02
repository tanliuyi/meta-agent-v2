# Loading and Packaging

## Developer Mode

Desktop does not automatically discover arbitrary global or project extensions. Use Settings > Extensions > Developer Mode > Add local extension.

A selected path may be:

- A regular `.ts`, `.js`, `.mjs`, or `.cjs` entry file.
- A directory with `market-manifest.json` and the manifest's relative `pi.entry` file.
- A directory without a manifest that contains a conventional `index.ts`, `index.js`, `index.mjs`, or `index.cjs` entry.

Manifest-backed development entries are required for programmatic plugin methods because method admission needs a canonical `plugin.id`, approved skill paths, a primary skill name, and an exact catalog digest. Loose single-file entries may still register ordinary Pi tools but cannot export admitted `desktopPlugin` methods. The entry and every declared skill/catalog path must remain inside the selected directory; symlink resources are rejected.

After approval, Desktop stores the development entry in its extension settings. The main process resolves an approved extension set for each project and passes only that set to the sidecar worker. A plugin with the same declared `plugin.id` as an installed marketplace plugin supersedes the marketplace version while the local entry is enabled.

## Reload Behavior

Configuration and extension-set mutations invalidate the resolved generation. The current session may report `reloadRequired` while a worker is still using the prior generation. Use `/reload` or create a new session after changing extension source, capabilities, manifest configuration, or enabled scope. Rebuild `packages/desktop/out/sidecar` before testing packaged or real Electron behavior; source changes alone do not update an existing sidecar bundle.

## Marketplace Artifact

A marketplace artifact is a signed archive with a `market-manifest.json` and a payload. The manifest must declare:

- A complete plugin identity and semver version.
- `pi.entry`, every `pi.skills` path, and `pi.pluginCall.catalog` under `payload/` and present in the archive.
- `pi.pluginCall.skill` matching the primary `SKILL.md` frontmatter name when `plugin-methods.provide` is declared.
- `desktop.hostProfileVersion: 1`.
- A compatible `target`.
- Every `configuration` field validated by the Desktop parser.
- Every capability used by the plugin.
- `nativeModules` and `executables` only when the payload actually contains them and the runtime target matches.
- `files` metadata for payload modes.
- A sorted `plugin-api.json` generated from the same `desktopPlugin` declaration and a primary skill that references generated `references/api.md`.

The payload must include every non-host runtime dependency. Marketplace installation does not run `npm install`, lifecycle scripts, or on-device compilation. Do not include `market-manifest.json` or `signature.json` inside the payload ZIP when using the marketplace publish scripts; the server supplies the signed artifact metadata.

Exclude tests, caches, source maps containing private paths, `.env` files, local databases, credentials, private keys, package-manager caches, and unrelated development files. Preserve required third-party licenses and notices.

## Built-In Skills

The Desktop sidecar packages the built-in `plugin-create`, `plugin-publish`, and `desktop-plugin-development` skills under `main/pi/skills`. Root sessions receive these skills through the controlled resource loader. Child sessions intentionally do not receive all built-in skills unless the orchestrator explicitly enables them.

The Pi package's `README.md`, `docs/`, and `examples/` are separate packaged resources. Resolve those paths from the system prompt rather than assuming the current working directory contains the Pi source tree.

## Verification Checklist

Before shipping:

- Run the plugin typecheck against the installed Pi host types.
- Run deterministic plugin tests without paid providers or real credentials.
- Parse the manifest with the Desktop development resolver.
- Confirm a method plugin's declaration, catalog, primary skill name/path, and generated API reference agree exactly.
- Build the sidecar and verify the new skill and manifest resources exist in the output.
- For marketplace work, assemble and inspect the final payload, then verify the downloaded artifact hash, size, manifest, signature, and file set.
