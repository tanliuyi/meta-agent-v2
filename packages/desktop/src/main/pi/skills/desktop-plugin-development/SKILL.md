---
name: desktop-plugin-development
description: Reference for Codex plugin compatibility and internal Developer Mode adapters in Meta Agent Desktop.
compatibility: Codex plugin.json and Marketplace JSON.
---

# Desktop Plugin Development Reference

Third-party plugins use the Codex plugin contract. Read `plugin-create` for the layout and `plugin-publish` for Marketplace registration.

Desktop maps supported companions into sidecar-owned adapters:

- `skills/**/SKILL.md` enters standard skill discovery.
- JavaScript and Python files under `scripts/` run only through explicit host tool calls.
- `.mcp.json` supports stdio and Streamable HTTP tools.
- `.app.json` and hooks return explicit unsupported diagnostics.

Plugin code and raw manifests never enter Electron main, preload, or renderer APIs. Installed plugins are full-trust local content; make file, network, subprocess, credential, and destructive effects clear.

Developer Mode is an internal adapter path for Desktop development. It accepts a `.js`, `.mjs`, `.cjs`, or `.ts` entry file, or a directory containing a conventional `index.*` entry. It does not parse third-party manifests, configuration schemas, capabilities, skills, or run_code catalogs. Use a Codex plugin for distributable functionality.

Before completion, validate the Codex manifest, verify every companion path remains inside the plugin root, run focused integration tests, and state any unsupported companion or live GUI step.
