# Desktop Codex Plugin System Migration Plan

> Status: Blocked — do not merge into v39
> Owner: Desktop
> Scope: `packages/desktop`
> Authority: `C:\Users\Administrator\.codex\skills\.system\plugin-creator\SKILL.md`
> Last updated: 2026-09-08

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

### Release blocker: package compatibility is not runtime compatibility

This branch must not be merged into v39. The current implementation validates, installs, and maps only a portable subset of the Codex plugin package contract. It does not provide the complete Codex plugin host runtime.

A concrete counterexample is the bundled plugin at `%USERPROFILE%\\.codex\\plugins\\cache\\openai-bundled\\computer-use\\26.901.51231`. Its package has a valid `.codex-plugin/plugin.json` and skill, but its behavior depends on Codex-hosted facilities that Desktop does not currently provide:

- manifest hooks, including `Stop` hooks with `type: "mcp_tool"`;
- the host-provided `node_repl` MCP server and its lifecycle;
- the bundled `@oai/sky` runtime and associated native Computer Use host components;
- Codex plugin appserver registration, tool routing, confirmation semantics, and hook dispatch.

Desktop currently accepts the package metadata and can expose its skill text, but cannot execute the plugin's core Computer Use behavior. Reporting such a plugin as installed and usable would therefore be misleading.

The architecture must choose and complete one of these paths before merge:

1. **Codex runtime bridge (preferred):** delegate installed/cache plugin activation, hooks, host tools, and bundled runtime dependencies to the authoritative Codex plugin appserver; Desktop remains responsible for UI, approval, session selection, and lifecycle coordination.
2. **Explicit portable subset:** define a Desktop capability-compatibility contract, reject or mark unavailable every plugin requiring unsupported hooks or host tools, and ensure the UI distinguishes package installation from runtime availability.

The current `skills`/scripts/narrow-MCP adapters may remain useful, but they do not satisfy the broad claim that a valid Codex plugin can be used directly. Phase and exit-criteria labels below describe completed subset work only and do not override this release blocker.

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

Status: done

- [x] Add this migration plan.
- [x] Inventory every old manifest, registry field, installer input, IPC DTO, UI label, and test.
- [x] Record current dirty files and avoid overwriting unrelated user changes.
- [x] Add characterization tests for current built-ins and plugin loading.
- [x] Define and execute the removal list for old `market-manifest.json` and Host Profile requirements.

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

Exit criteria check: installing copies the verified local source into a content-addressed `.versions` payload under `plugins/codex-extensions/<name>/` (Desktop-owned files excluded; symlinks are dereferenced only when their canonical targets remain inside the source root) and commits `installedRootPath`/`installedHash` plus the record version through `CodexPluginRegistry.commitInstalled`. Updates re-verify the source, derive a cachebuster version (`0.1.0+codex.<UTC timestamp>` when the manifest base is unchanged, the source version verbatim on a manifest bump), land a new payload, retain the previous one while live workers can reference it, and return `reloadRequired: true` so the worker generation rebuilds (`fingerprint` includes the record version). Uninstalls clear the installed state immediately; retained managed payloads are collected by startup reconciliation after workers are gone. Crash windows (payload landed but not committed, installed payload gone, registry committed but copy removal interrupted) are repaired by `CodexPluginReconciler`. The installer never writes the plugin source, `plugin.json`, or Marketplace JSON; no Desktop artifact manifest is produced. Install state is discovery-bound: when a Marketplace entry disappears at startup, the discovery record is dropped and the reconciler removes the managed copy; the managed copy is authoritative within a run, not a persistent install that survives source removal.

### Phase 4: Companion loading

Status: done (supported subset below)

- [x] Load `skills/` using Desktop's skill discovery path.
- [x] Define and implement supported `scripts/` execution semantics.
- [x] Load `.mcp.json` through a narrow sidecar adapter.
- [x] Load `.app.json` only where Desktop has a corresponding host API (none currently; explicit unsupported diagnostic).
- [x] Define supported Codex hooks and reject unsupported forms clearly (no hook execution in this phase; see deviation below).
- [x] Keep plugin code out of Electron main, preload, and renderer.

Exit criteria: each supported Codex companion has an integration test and each unsupported form has a stable diagnostic.

Implemented support boundary:

| Companion | Behavior |
| --- | --- |
| `skills/**/SKILL.md` | Default discovery even without `manifest.skills`; approved files enter the existing Pi skill loader without `pi.entry` or `plugin-methods.provide`. |
| `scripts/` | Explicit sidecar tool calls only. `.js`, `.mjs`, `.cjs` use the sidecar Node executable; `.py` uses `python3` from PATH on POSIX and `python` on Windows. Arguments are passed without shell expansion, cwd is the plugin root, timeout is 30 seconds, output limit is 1 MiB, cancellation and shutdown terminate the complete process group. Other interpreter entry types (`.sh`, `.ps1`, `.bat`, `.cmd`, `.ts`) report unsupported and may still be used explicitly from skill instructions through existing host tools. |
| `.mcp.json` and inline `mcpServers` | `mcpServers` file envelope plus inline entries, rejecting duplicate names. Supports stdio (`command`, `args`, `env`, `cwd`) and Streamable HTTP (`type: "http"`, `url`, `headers`). The narrow tool bridge exposes `tools/list` (including pagination) and `tools/call`, with JSON results. SDK `1.30.0` handles protocol negotiation and transports. |
| MCP lifecycle | No startup connections. Each invocation opens and closes its own connection, including error/cancellation paths; timeout is 30 seconds. This does not preserve server-side state between calls. OAuth, legacy SSE, host-specific filtering/configuration, MCP resources/prompts and background sessions are not implemented. Unknown configuration fields are rejected rather than ignored. Only the literal `${CODEX_PLUGIN_ROOT}` placeholder is expanded. |
| `.app.json` | Parsed as data; valid declarations report `CODEX_COMPANION_UNSUPPORTED` because Desktop has no Codex connector authorization API. |
| Hooks | All manifest hook declarations and default `hooks.json`/`hooks/` forms report `CODEX_COMPANION_UNSUPPORTED`; none execute. The installed creator skill and reference disagree about hook acceptance and do not specify a usable runtime contract. Implementing an event mapping without that contract would claim unsupported compatibility, so hook execution is explicitly deferred. |

Only enabled, installed managed copies enter the loadable set. Marketplace discovery alone cannot bypass the installer's full-trust confirmation, and uninstall removes resources from subsequent resolutions. Main performs data-only discovery; sidecar registers host-owned adapters. Neither a wrapper file nor an executable plugin entry is generated. Companion content contributes to the generation fingerprint and the worker revalidates its snapshot. Paths are checked using realpath; escaping symlinks and directory cycles are rejected. Script paths are checked again immediately before invocation.

`CODEX_COMPANION_INVALID` and `CODEX_COMPANION_UNSUPPORTED` diagnostics retain valid sibling companions and are non-blocking. Invalid manifests still exclude the whole plugin with `CODEX_EXTENSION_ENTRY_UNAVAILABLE`, which is also non-blocking. Diagnostics do not include raw MCP environment/header values. Live/draft worker replacement and rollback are covered by Phase 5; GUI install flows are covered by Phase 6.

### Phase 5: Runtime and session integration

Status: done

- [x] Map Codex plugin resources into live and draft workers consistently, including namespaced skills and identical diagnostics.
- [x] Preserve single-writer worker replacement for plugin-set changes, with stale-generation checks and rollback.
- [x] Keep Codex runtime loading independent of `pi.entry` and `plugin-methods.provide`; those remain only for internal legacy adapters.
- [x] Keep existing Pi extensions only as internal built-in adapters during migration.
- [x] Add crash recovery, stale-generation, retained-payload and worker-replacement tests.

Exit criteria: a Codex plugin works in a new session and draft metadata flow without requiring Pi-specific plugin metadata.

Exit criteria check: live `ThreadWorkerService` and draft `MetadataWorkerService` consume the same resolved Codex extension set. Codex skills are discovered with the shared loader's root-stop and ignore semantics, then namespaced as `<plugin-id>:<skill-name>` so equal skill names coexist. Invalid skill warnings become stable non-blocking `CODEX_SKILL_INVALID` diagnostics in both flows. Session-level plugin selection uses serialized replacement workers; stale draft generations are rejected before spawn, replacements are single-writer, startup failures restore the previous worker and selection, and a generation change during startup is rolled back. Codex managed payloads are retained while workers may reference them and are collected by startup reconciliation after uninstall or update. Worker crash recovery reopens the latest generation and preserves the session selection.

### Phase 6: UI, IPC, and Codex workflow

Status: done

- [x] Display Codex manifest metadata and Marketplace policy fields.
- [x] Remove Host Profile/capability terminology from third-party plugin UI.
- [x] Support personal Marketplace ordering and local source semantics.
- [x] Mark View/Share deeplinks as not applicable: Desktop has no Marketplace write workflow and Codex defines no plugin URL contract.
- [x] Validate extension replacement and session plugin selection IPC inputs in the main process; renderer-supplied executable paths and raw manifests are not accepted.
- [x] Update plugin detail and settings views without overwriting current user changes.

Exit criteria: UI behavior matches Codex plugin creation, Marketplace, install, update, and handoff semantics.

### Phase 7: Delete the old protocol

Status: done

- [x] Remove old artifact manifest parser and obsolete contracts.
- [x] Remove mandatory Host Profile and Desktop capability fields from external plugin validation.
- [x] Remove `plugin-methods.provide` as an external plugin requirement.
- [x] Remove old Marketplace artifact endpoint assumptions.
- [x] Remove migration-only compatibility code and update all docs.
- [x] Rename remaining implementation symbols that incorrectly imply the old protocol.

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

### 2026-09-08 (Runtime compatibility audit and merge hold)

- Re-audited the implementation against a real OpenAI bundled plugin, `computer-use` version `26.901.51231`.
- Confirmed that package discovery and manifest compatibility do not provide the Codex runtime facilities required by that plugin: hooks, `node_repl`, `@oai/sky`, native host components, and plugin appserver routing.
- Marked the migration blocked and explicitly held this branch out of v39 until either an authoritative Codex runtime bridge is implemented or unsupported runtime requirements are detected and surfaced as unavailable before installation.
- Fixed the independently identified installer and registry defects: managed-root containment, source symlink escape, hash framing and payload revalidation, Marketplace policy enforcement, source/installed version separation, diagnostics projection, installed-copy metadata, full-trust/removal confirmations, Windows paths, and Python invocation.
- Verification: 158 focused Codex tests pass and root `npm run check` passes. Electron GUI smoke and packaged build were not run. These checks validate the supported subset, not full bundled-plugin runtime compatibility.

### 2026-09-07 (Phase 4)

- Added data-only companion discovery, internal resource snapshots, generation fingerprints and sidecar snapshot validation.
- Added explicit JavaScript/Python script execution and a lazy stdio/Streamable HTTP MCP tool bridge using pinned `@modelcontextprotocol/sdk@1.30.0`; installed dependencies with lifecycle scripts disabled. No changes to plugin sources or manifests.
- Apps and hooks have explicit unsupported diagnostics, with the support boundary and hook deviation documented above.
- Added real local script and MCP integration tests covering discovery-to-resource loading, cancellation, child cleanup, invalid/unsupported companions, symlink escapes, stale snapshots and uninstall exclusion. Updated the installed-copy source-policy expectation.
- Fixed the pre-existing manifest interface key inference error exposed by Desktop-specific type checking (the root `npm run check` excludes Desktop).
- Fixed two Phase 3 integration defects exposed by the broader regression run: copy children into the already-created private staging directory with `errorOnExist` preserved and symlinks dereferenced; resolve installed companions from `<installedRootPath>/.versions/<installedHash>` instead of the container directory. Added an actual installer-to-loader install/update/uninstall test.
- Verification: 167 tests across nine focused files pass; Desktop main and sidecar TypeScript checks pass; `npm run check` passes (existing npm `min-release-age` configuration warnings remain). No build or full test suite was run.

### 2026-09-07 (Phase 5)

- Fixed script cancellation and session shutdown cleanup to terminate the complete child process group, including grandchildren, on POSIX and Windows.
- Fixed Codex skill discovery to preserve shared loader semantics (skill-root stop, ignored directories, hidden directories and `node_modules`) while hashing all companion content; equal names are namespaced per plugin and invalid skill warnings are surfaced in live and draft diagnostics.
- Kept installed `.versions` payloads until startup reconciliation so active workers and replacement rollback retain valid resources; retained payloads are reused by content hash and stale generation snapshots are rejected.
- Added live/draft integration coverage for Codex-only sessions, skill diagnostics, process-tree cleanup, stale drafts, serialized replacement, rollback, crash recovery, retained payloads and session-level selection.
- Verification: 256 tests across 14 focused Desktop files pass, including 2 Phase 5 integration tests; Desktop main, sidecar and web TypeScript checks pass; root `npm run check` passes (npm emits the existing unknown `min-release-age` configuration warning). Electron GUI restart and packaged build were not run.

### 2026-09-07 (Phase 6)

- Added main-process validation for plugin IPC payloads, including extension replacement, session plugin selection, Marketplace mutations, pagination, scopes, project lists and nested session-application targets. Invalid identifiers, revisions, enums, lists and confirmation flags are rejected before reaching services.
- Fixed Windows Codex script cleanup to invoke `taskkill /T /F` asynchronously and only once per invocation, avoiding synchronous main-process blocking during cancellation, timeout, output-limit and shutdown paths.
- Verification: focused `extensions-ipc.test.ts` passes (8 tests); root `npm run check` passes. GUI restart and packaged build were not run.

### 2026-09-08 (Phase 7)

- Removed the Desktop artifact manifest, archive, remote endpoint, registry, installer, reconciler, garbage collector, icon protocol, IPC, preload and renderer configuration surfaces.
- Restricted Developer Mode to direct Pi entry files or directories containing `index.ts`, `index.js`, `index.mjs` or `index.cjs`; it no longer parses third-party manifests or contributes Codex metadata.
- Kept Host Profile, capabilities and `plugin-methods.provide` only for Desktop-owned built-in, curated and Developer Mode adapters. Codex entries are validated as data-only companions and cannot carry executable entry paths or capabilities.
- Replaced old Marketplace documentation and publishing skills with Codex plugin creation, local Marketplace and cachebuster workflows. View/Share links are not applicable because Desktop has no Marketplace write workflow and Codex defines no plugin URL contract.
- Removed the migration-only local-overrides-Marketplace diagnostic and corrected test fixtures that represented internal Pi adapters as Codex entries.
- Verification is recorded after the final focused tests, Desktop typecheck and root check complete. Electron GUI restart and packaged build are outside this phase and were not run.

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

- **Release decision:** this branch is not eligible for v39 while the runtime compatibility blocker in section 1 remains unresolved.
- Decide whether Desktop delegates to the authoritative Codex plugin appserver or intentionally supports a smaller portable subset with capability-based availability checks.
- Hook execution, host-provided tools such as `node_repl`, bundled runtimes such as `@oai/sky`, and Apps authorization remain unsupported; MCP support is limited to the explicit Phase 4 subset above.
- If the portable-subset option is selected, extend the shared contracts and renderer to expose `runtimeAvailable`, required host capabilities, and stable incompatibility diagnostics before allowing installation.
- Whether existing Pi-based built-ins are retained permanently as internal Desktop features or rewritten as Codex companions is a separate migration decision.
