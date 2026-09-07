# Desktop Internal run_code Adapter

> Status: Internal implementation reference
> Third-party packaging sections superseded by: [`codex-plugin-system-migration-plan.md`](./codex-plugin-system-migration-plan.md)
> Last updated: 2026-09-08

## Scope

`run_code` aggregates tools registered by Desktop-owned Pi adapters so the model sees one stable tool schema instead of every adapter method. It is an internal Desktop mechanism for built-in, curated, and Developer Mode extensions.

Codex plugins do not opt into this mechanism. They do not declare `plugin-methods.provide`, a Host Profile, an entry file, a generated API catalog, or Desktop capabilities. Codex skills, scripts, and MCP servers use the companion adapters described in the migration plan.

## Runtime contract

- `PluginMethodRegistry` is bound to one immutable extension generation.
- Internal adapters with `plugin-methods.provide` contribute captured Pi `ToolDefinition` handlers.
- `run_code` executes erasable TypeScript in a worker and exposes methods under `plugin.<pluginId>.<method>`.
- Inputs and outputs must be lossless JSON. Arguments are checked against the captured TypeBox schema.
- Abort, timeout, output, attachment, and process cleanup remain enforced by the sidecar runtime.
- Intermediate calls and logs remain UI and audit details; only the outer result enters the model transcript.
- Renderer-facing attachment records use opaque IDs and never expose canonical filesystem paths or hashes.
- Generation replacement discards old handlers after active references are released.

## Internal metadata

The following fields remain valid only in Desktop-owned extension definitions:

```ts
interface DesktopInternalRunCodeDefinition {
  capabilities: ["plugin-methods.provide"];
  skillPaths: string[];
  runCodeSkill: string;
  runCodeCatalogPath: string;
  runCodeCatalogSha256: string;
}
```

They are not part of `.codex-plugin/plugin.json` or Codex Marketplace JSON.

## Implementation map

- `src/main/pi/run-code/`: registry, dispatcher, worker, protocol, limits, JSON validation, and tool adapter.
- `src/main/pi/desktop-extension-runtime-policy.ts`: internal Pi adapter admission and Codex companion separation.
- `src/main/pi/session-runtime.ts`: generation-bound registry lifecycle.
- `src/main/pi/pi-thread-projector.ts`: safe tool detail and attachment projection.
- `src/shared/desktop-extension-contracts.ts`: internal extension and renderer DTO types.

Historical third-party Marketplace packaging, archive, installer, and migration details were removed with Phase 7. Git history is the source for those retired designs.
