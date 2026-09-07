---
name: plugin-create
description: Creates and validates Codex plugins for Meta Agent Desktop. Use when a user asks to scaffold, modify, debug, or prepare a plugin.
compatibility: Codex plugin.json and Marketplace JSON.
---

# Create a Codex Plugin

Create the standard Codex layout. Do not add Desktop-specific manifests, executable entry points, capability declarations, or Electron imports.

```text
<plugin>/
├── .codex-plugin/plugin.json
├── skills/
├── scripts/
├── assets/
├── .mcp.json
└── .app.json
```

Only `.codex-plugin/plugin.json` is required. Add companions only when the plugin needs them. Keep all manifest paths relative to the plugin root and reject absolute paths or `..` traversal.

## Workflow

1. Define the user-visible behavior and required companions.
2. Inspect the installed Codex plugin examples and use their manifest fields exactly.
3. Write `plugin.json` with `name`, semver `version`, `description`, `author`, and optional interface metadata.
4. Put reusable instructions in `skills/<name>/SKILL.md`.
5. Put explicit JavaScript or Python utilities in `scripts/`. Desktop invokes scripts without shell expansion.
6. Put MCP servers in `.mcp.json`; use stdio or Streamable HTTP configuration accepted by Codex.
7. Validate the manifest, paths, companion files, and deterministic behavior.
8. Add the plugin to a Codex Marketplace JSON entry for discovery and install it through Desktop.

Desktop currently reports `.app.json` and hooks as unsupported. Do not claim those companions work until the host exposes the matching API.

## Verification

- The plugin loads without `market-manifest.json`, `pi.entry`, Host Profile fields, or Desktop capabilities.
- No plugin file imports Desktop main, preload, renderer, or private sidecar code.
- Scripts bound input, output, and runtime; MCP configuration contains no committed credentials.
- Focused tests cover each supported companion and cleanup path.
