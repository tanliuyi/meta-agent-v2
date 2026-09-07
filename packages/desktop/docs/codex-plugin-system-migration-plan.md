# Desktop Codex Plugin System Migration Plan

> Status: In progress
> Owner: Desktop
> Scope: `packages/desktop`
> Authority: `C:\Users\Administrator\.codex\skills\.system\plugin-creator\SKILL.md`
> Last updated: 2026-07-26

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

Status: not started

- [ ] Add typed Codex `plugin.json` model and strict parser.
- [ ] Validate normalized plugin name, supported manifest fields, relative paths, and companion existence.
- [ ] Reject path traversal, absolute paths, unsupported fields, TODO placeholders, and malformed JSON.
- [ ] Add Codex Marketplace JSON model and parser.
- [ ] Resolve default personal Marketplace using the user profile path.
- [ ] Add tests using fixtures copied from valid Codex plugin layouts.

Exit criteria: Desktop can validate a real Codex plugin and Marketplace file without importing old Desktop manifest code.

### Phase 2: Source discovery and registry

Status: not started

- [ ] Replace `DesktopExtensionSourcePolicy` input with Codex plugin sources.
- [ ] Support local plugin roots and Marketplace `source.path`.
- [ ] Add Codex plugin registry records without `hostProfileVersion`, `artifactHash`, or Desktop capability requirements.
- [ ] Preserve immutable worker generations internally, but derive them from Codex plugin identity/version/source state.
- [ ] Keep built-in Desktop providers on a separate internal path.

Exit criteria: the same local plugin root is discovered by Codex and Desktop, and unapproved legacy Pi directories remain excluded.

### Phase 3: Installation, update, and removal

Status: not started

- [ ] Replace artifact-specific installer inputs with Codex Marketplace source resolution.
- [ ] Preserve staging, locking, CAS/revision, crash recovery, and garbage collection where useful.
- [ ] Remove required Desktop artifact metadata and runtime-target selection from the Codex plugin path.
- [ ] Implement Codex cachebuster update flow for local Marketplace development.
- [ ] Ensure Desktop never writes to Codex `plugin.json` or manually edits Marketplace JSON during updates.
- [ ] Keep explicit full-trust confirmation for ordinary Node plugin code as a Desktop UX policy, not a manifest requirement.

Exit criteria: install/update/uninstall works for a Codex Marketplace entry and does not create a Desktop-only plugin format.

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