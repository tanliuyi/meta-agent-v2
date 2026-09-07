# Desktop Codex Plugin System Migration Plan

> Status: In progress
> Owner: Desktop
> Scope: `packages/desktop`
> Authority: `C:\Users\Administrator\.codex\skills\.system\plugin-creator\SKILL.md`
> Last updated: 2026-09-07

## 1. Objective

Replace the current Desktop-specific Pi extension and marketplace protocol with the Codex plugin protocol so that a valid Codex plugin can be copied into the supported plugin location, discovered by Desktop, and used without adding Desktop-only manifest fields or wrapper files.

The target protocol is:

```text
<plugin>/
├── .codex-plugin/plugin.json
├── skills/                 # optional
├── scripts/                # optional
├── assets/                 # optional
├── .mcp.json               # optional
└── .app.json               # optional
```

The Codex manifest and Marketplace JSON are the only third-party plugin contracts. Desktop-specific runtime details remain internal implementation details and must not be required in a plugin package.

## 2. Non-negotiable outcomes

- Desktop accepts `.codex-plugin/plugin.json` as the plugin manifest.
- Desktop accepts Codex Marketplace JSON, including the default personal Marketplace at `%USERPROFILE%\\.agents\\plugins\\marketplace.json`.
- A Codex plugin does not need `market-manifest.json`, `pi.entry`, `desktop.hostProfileVersion`, or Desktop capability declarations.
- Desktop does not mutate a plugin's manifest or add a Desktop wrapper entry.
- Invalid Codex manifests fail with stable, user-facing diagnostics.
- Skills, scripts, MCP configuration, apps, and supported hooks are discovered from Codex companion files.
- Existing Desktop Pi extensions are migrated to built-in adapters or explicitly retired; they are not silently treated as Codex plugins.
- Renderer changes never receive executable plugin code or arbitrary artifact URLs/paths.
- The current user changes in `packages/desktop/src/main/subagents/subagent-settings-config-service.ts`, `packages/desktop/src/renderer/src/components/panel/project-panel.tsx`, and `packages/desktop/src/renderer/src/features/plugins/plugin-detail-dialog.tsx` must be preserved.

## 3. Compatibility policy

This is an intentional breaking migration. There is no long-term dual manifest protocol.

During the migration window:

- old Desktop marketplace installations may be read for migration only;
- old `market-manifest.json` plugins are not accepted as new Codex plugins;
- migration diagnostics identify the old format and point to the Codex layout;
- compatibility code is tagged for removal in Phase 7;
- no new feature may depend on the old manifest or artifact contract.

Codex's public plugin creator skill is a package and workflow specification, not a promise that arbitrary Node code has an identical runtime in every host. Desktop will map supported Codex companions to its existing sidecar boundaries, and will report unsupported companions explicitly rather than claiming silent compatibility.

## 4. Target architecture

```text
Codex Marketplace JSON / local plugin root
                |
                v
Codex manifest + companion validator
                |
                v
Codex plugin registry and installation state
                |
                v
Desktop source resolver
                |
                v
Resolved Codex plugin set per worker generation
                |
                v
Sidecar adapters: skills | scripts | MCP | apps | hooks
```

The existing Pi session/agent loop may remain an internal execution dependency while it is being replaced, but it must not define the external plugin format.

## 5. Work phases

### Phase 0: Freeze and inventory

Status: in progress

- [x] Add this migration plan.
- [ ] Inventory every old manifest, registry field, installer input, IPC DTO, UI label, and test.
- [ ] Record current dirty files and avoid overwriting unrelated user changes.
- [ ] Add characterization tests for current built-ins and plugin loading.
- [ ] Define removal list for old `market-manifest.json` and Host Profile requirements.

Exit criteria: the old protocol has an explicit dependency map and no unknown production consumer remains.

### Phase 1: Codex contract layer

Status: done

- [x] Add typed Codex `plugin.json` model and strict parser.
- [x] Validate normalized plugin name, supported manifest fields, relative paths, and companion existence.
- [x] Reject path traversal, absolute paths, unsupported fields, TODO placeholders, and malformed JSON. (Deviation: unknown top-level fields are tolerated per the observed host contract, e.g. `hooks`, `bundledContentVariant`.)
- [x] Add Codex Marketplace JSON model and parser.
- [x] Resolve default personal Marketplace using the user profile path.
- [x] Add tests using fixtures copied from valid Codex plugin layouts.

Exit criteria: Desktop can validate a real Codex plugin and Marketplace file without importing old Desktop manifest code.

### Phase 2: Source discovery and registry

Status: done

- [x] Replace `DesktopExtensionSourcePolicy` input with Codex plugin sources (`getCodexExtensions` snapshot from the Codex registry).
- [x] Support local plugin roots and Marketplace `source.path` (marketplace root resolves three directories above the marketplace file, per the Codex layout; only the implicit personal Marketplace is scanned in this phase).
- [x] Add Codex plugin registry records without `hostProfileVersion`, `artifactHash`, or Desktop capability requirements (`codex-plugins.json`, reconciled at startup; records keep only identity/version/source state plus an `enabled` flag).
- [x] Preserve immutable worker generations internally, but derive them from Codex plugin identity/version/source state (registry revision plus `id:version:rootPath:enabled` enter the resolution fingerprint).
- [x] Keep built-in Desktop providers on a separate internal path (builtin resolution is untouched).

Exit criteria: the same local plugin root is discovered by Codex and Desktop, and unapproved legacy Pi directories remain excluded.

Exit criteria check: a Codex plugin declared by the personal Marketplace is discovered, validated, and enters the registry and the resolution fingerprint; it stays out of the loadable extension set until Phase 4 provides companion content (the worker-side `validateResolvedExtensionSet` requires an absolute entry path for non-builtin entries, and Codex plugins have no loadable content yet), with discovery state visible through diagnostics and worker generations. Plugin roots containing `market-manifest.json` are excluded with the `plugin.legacy-layout` diagnostic. `source.unsafe` remains as defense-in-depth for entries stripped of their path at parse time.

### Phase 3: Installation, update, and removal

Status: done

- [x] Replace artifact-specific installer inputs with Codex Marketplace source resolution (the installer resolves the discovered record and copies the local plugin source; no artifact API, runtime-target selection, or Desktop manifest involvement).
- [x] Preserve staging, locking, CAS/revision, crash recovery, and garbage collection where useful (per-plugin locks, `.meta-agent-codex-staging`, content-addressed `.versions` payloads under `plugins/codex-extensions`, registry revision CAS, startup reconciler).
- [x] Remove required Desktop artifact metadata and runtime-target selection from the Codex plugin path (records carry only `installedRootPath`/`installedHash`; no `artifactHash`/capabilities/entry path).
- [x] Implement Codex cachebuster update flow for local Marketplace development (updates derive `base+codex.<UTC timestamp>` versions, mirroring `update_plugin_cachebuster`; version bumps keep the source version verbatim).
- [x] Ensure Desktop never writes to Codex `plugin.json` or manually edits Marketplace JSON during updates (the installer only reads the source and manages its own copy under `plugins/codex-extensions`).
- [x] Keep explicit full-trust confirmation for ordinary Node plugin code as a Desktop UX policy, not a manifest requirement (`confirmFullTrust`/`confirmRemoval` stay caller-side requirements).

Exit criteria: install/update/uninstall works for a Codex Marketplace entry and does not create a Desktop-only plugin format.

Exit criteria check: installing copies the verified local source into a content-addressed `.versions` payload under `plugins/codex-extensions/<name>/` (Desktop-owned files excluded, symlinks followed so the copy is self-contained) and commits `installedRootPath`/`installedHash` plus the record version through `CodexPluginRegistry.commitInstalled`. Updates re-verify the source, derive a cachebuster version (`0.1.0+codex.<UTC timestamp>` when the manifest base is unchanged, the source version verbatim on a manifest bump), land a new payload, remove the previous one, and return `reloadRequired: true` so the worker generation rebuilds (`fingerprint` includes the record version). Uninstalls clear the installed state and remove the managed copy. Crash windows (payload landed but not committed, installed payload gone, registry committed but copy removal interrupted) are repaired by `CodexPluginReconciler`. The installer never writes the plugin source, `plugin.json`, or Marketplace JSON; no Desktop artifact manifest is produced. Install state is discovery-bound: when a Marketplace entry disappears at startup, the discovery record is dropped and the reconciler removes the managed copy; the managed copy is authoritative within a run, not a persistent install that survives source removal.

### Phase 4: Companion loading

Status: not started

- [ ] Load `skills/` using Desktop's skill discovery path.
- [ ] Define and implement supported `scripts/` execution semantics.
- [ ] Load `.mcp.json` through the existing MCP integration or add a narrow adapter.
- [ ] Load `.app.json` only where Desktop has a corresponding host API.
- [ ] Implement supported Codex hooks; reject unsupported hook forms clearly.
- [ ] Keep plugin code out of Electron main, preload, and renderer.

Exit criteria: each supported Codex companion has an integration test and each unsupported form has a stable diagnostic.

### Phase 5: Runtime and session integration

Status: not started

- [ ] Map Codex plugin resources into live and draft workers consistently.
- [ ] Preserve single-writer worker replacement for plugin-set changes.
- [ ] Remove external reliance on `pi.entry` and `plugin-methods.provide`.
- [ ] Keep existing Pi extensions only as internal built-in adapters during migration.
- [ ] Add crash recovery and stale-generation tests.

Exit criteria: a Codex plugin works in a new session and draft metadata flow without requiring Pi-specific plugin metadata.

### Phase 6: UI, IPC, and Codex workflow

Status: not started

- [ ] Display Codex manifest metadata and Marketplace policy fields.
- [ ] Remove Host Profile/capability terminology from third-party plugin UI.
- [ ] Support personal Marketplace ordering and local source semantics.
- [ ] Add Codex-compatible View/Share deeplinks where Desktop creates or updates Marketplace entries.
- [ ] Ensure IPC validates all inputs and never accepts renderer-supplied executable paths or raw manifests.
- [ ] Update plugin detail and settings views without overwriting current user changes.

Exit criteria: UI behavior matches Codex plugin creation, Marketplace, install, update, and handoff semantics.

### Phase 7: Delete the old protocol

Status: not started

- [ ] Remove old artifact manifest parser and obsolete contracts.
- [ ] Remove mandatory Host Profile and Desktop capability fields from external plugin validation.
- [ ] Remove `plugin-methods.provide` as an external plugin requirement.
- [ ] Remove old Marketplace artifact endpoint assumptions.
- [ ] Remove migration-only compatibility code and update all docs.
- [ ] Rename remaining implementation symbols that incorrectly imply the old protocol.

Exit criteria: no production path or test requires `market-manifest.json` for a third-party plugin.

## 6. Test and verification gates

After each code phase:

```bash
npm run check
```

For modified Desktop tests, run the focused test file from `packages/desktop` with the repository Vitest binary. Do not run `npm test` or the full Vitest suite unless explicitly requested.

Required final coverage:

- valid and invalid Codex manifests;
- personal and custom Marketplace JSON;
- local source path resolution;
- plugin name/path normalization;
- optional companion discovery;
- unsupported companion diagnostics;
- install/update/uninstall and cachebuster flow;
- no legacy Pi auto-discovery;
- live/draft consistency;
- worker replacement and rollback;
- renderer IPC validation;
- preservation of user-modified unrelated files.

## 7. Live implementation log

### 2026-09-07

- Implemented Phase 1 contract layer on branch `codex/plugin-system-migration`.
- Added `src/main/plugins/codex/codex-plugin-identifiers.ts` (plugin and Marketplace name patterns).
- Added `src/main/plugins/codex/codex-plugin-manifest.ts` (typed manifest model, strict parser, on-disk companion and asset validation).
- Added `src/main/plugins/codex/codex-marketplace.ts` (typed Marketplace model, parser, personal Marketplace path resolution).
- Added fixtures copied from the installed Codex host (`test/fixtures/codex/plugins/dart-flutter`, `browser`, `marketplaces/openai-curated.json`, `openai-api-curated.json`).
- Added `test/codex-plugin-manifest.test.ts` and `test/codex-marketplace.test.ts`; 43 tests pass, `npm run check` clean.
- Parser follows the observed host contract, not the stricter bundled validator: `hooks` and other unknown top-level fields are tolerated, `interface` is optional, and Marketplace entries keep their declared source path verbatim after safety validation.
- Next implementation step: Phase 2, source discovery and registry.

### 2026-09-07 (Phase 2)

- Implemented Phase 2, source discovery and registry, on branch `codex/plugin-system-migration` (commit `2ca251f47` covered Phase 1).
- Added `src/main/plugins/codex/codex-plugin-sources.ts` (personal Marketplace discovery, `source.path` resolution, legacy-layout exclusion, manifest re-validation).
- Added `src/main/plugins/codex/codex-plugin-registry.ts` (persisted `codex-plugins.json` records without `hostProfileVersion`/`artifactHash`/capabilities; reconciled at startup and on demand).
- `DesktopExtensionSourcePolicy` gained a `getCodexExtensions` input; discovered Codex plugins contribute `id:version:rootPath:enabled` fingerprints plus the registry revision to the generation, report id-conflict and unavailability diagnostics, and do not enter the loadable extension set (no entry path until Phase 4).
- `DesktopExtensionSource` gained the `codex` value; `plugin-services.ts` wires discovery and the registry; builtin resolution path unchanged.
- Added `test/codex-plugin-sources.test.ts`, `test/codex-plugin-registry.test.ts`, and six Codex cases in `test/desktop-extension-source-policy.test.ts`; 99 tests across the five extension test files pass, `npm run check` clean.
- Marketplace root resolves three directories above the marketplace file (e.g. `~/.agents/plugins/marketplace.json` maps `./plugins/<name>` to `~/plugins/<name>`), per the Codex layout; only the implicit personal Marketplace is scanned in this phase.
- Next implementation step: Phase 3, installation, update, and removal.

### 2026-09-07 (Phase 3)

- Implemented Phase 3, installation, update, and removal. Resolution now verifies `record.installedRootPath` when present, so the managed copy is authoritative over the live source.
- Added `src/main/plugins/codex/codex-plugin-installer.ts`: install/update/uninstall copy verified sources into content-addressed `.versions` payloads under `plugins/codex-extensions`, commit installed state (`installedRootPath`/`installedHash` plus the record version) through the registry with revision CAS and per-plugin locks, derive cachebuster versions (`0.1.0+codex.<UTC timestamp>`) on content-only updates, and never write plugin, Marketplace, or source files. Full-trust/removal confirmation stays a caller-side UX requirement.
- Added `src/main/plugins/codex/codex-plugin-reconciler.ts` repairing the crash windows around the registry commit point (orphan staging, uncommitted payloads, missing installed payloads, interrupted copy removal); `plugin-services.ts` wires both.
- Added `test/codex-plugin-installer.test.ts`, `test/codex-plugin-reconciler.test.ts`, nine registry mutation cases, and two installed-copy cases in the policy test; 137 tests across the seven extension test files pass, `npm run check` clean.
- Next implementation step: Phase 4, companion loading (`skills/`, `scripts/`, `.mcp.json`, `.app.json`).

### 2026-07-26

- Added this plan document.
- Confirmed current Desktop implementation is artifact/`market-manifest.json` based.
- Confirmed Codex requires `.codex-plugin/plugin.json` and Marketplace JSON.
- Confirmed unrelated user modifications exist in three files listed in section 2; they are out of scope and must remain untouched.
- Next implementation step: add the Phase 1 Codex manifest and Marketplace contract layer with focused tests.

## 8. Open decisions

- Exact Codex companion runtime behavior for `hooks`, `.mcp.json`, and `.app.json` must be confirmed against the installed Codex host before implementing adapters.
- Whether existing Pi-based built-ins are retained permanently as internal Desktop features or rewritten as Codex companions is a separate migration decision.
- Whether remote Marketplace artifact download is retained or replaced with Codex local-source semantics must be decided from the Codex CLI installer behavior, not inferred from the creator skill alone.