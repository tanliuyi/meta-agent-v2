# Desktop Plugin Marketplace Product Spec

> Status: Superseded
> Superseded by: [`codex-plugin-system-migration-plan.md`](./codex-plugin-system-migration-plan.md)
> Last updated: 2026-09-08

The Desktop-specific Marketplace artifact protocol has been removed. This document remains only as a stable link for older design references.

Current third-party plugins use the Codex contracts:

- `.codex-plugin/plugin.json` defines plugin metadata.
- Codex Marketplace JSON defines discovery, ordering, local source paths, policy, and interface metadata.
- Desktop installs verified local Marketplace sources into its managed, content-addressed plugin directory.
- Desktop does not accept `market-manifest.json`, Desktop artifact archives, Host Profile fields, capability declarations, or remote artifact endpoints as third-party contracts.
- Codex companions are loaded through the supported `skills/`, `scripts/`, `.mcp.json`, `.app.json`, and hooks boundary documented in the migration plan.

Desktop built-in, curated, and Developer Mode Pi extensions remain internal adapters. Their Host Profile and `plugin-methods.provide` metadata are implementation details and are not valid Codex plugin fields.

The current implementation and verification record are maintained in the migration plan.
