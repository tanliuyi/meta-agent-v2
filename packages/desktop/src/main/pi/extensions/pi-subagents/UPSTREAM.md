# Vendored Upstream

- Project: pi-subagents
- Repository: https://github.com/nicobailon/pi-subagents
- Version: 0.35.1
- Commit: 03d275bedaeb9a7a5ca0ac508adf920f067f50d3
- Declared license: MIT
- Vendored: 2026-07-24

The upstream commit declares MIT in `package.json` but does not contain a LICENSE file. `LICENSE` records the standard MIT terms and upstream author named by the package metadata.

This source is maintained in-tree as a Meta Agent Desktop built-in extension. Desktop-specific changes include:

- child Pi launches are bound to `PI_DESKTOP_NODE_EXEC_PATH` and `PI_DESKTOP_PI_ENTRY` and fail closed;
- `PI_SUBAGENT_PI_BINARY`, PATH `pi`, PATH `node`, and package-ancestry CLI fallbacks are disabled for child execution;
- every child loads the compiled Desktop child extension through `PI_DESKTOP_CHILD_EXTENSION_PATH`;
- detached async runners execute compiled JavaScript directly with the selected Desktop Node instead of jiti;
- TUI-only custom components, terminal input, widgets, and tools-expanded state are disabled or downgraded in Desktop RPC mode;
- bundled agents, prompts, and skills are copied into the sidecar output;
- source follows this monorepo's erasable TypeScript and formatting rules.

When updating, review the upstream diff, retain the Desktop runtime boundary adaptations, update this commit, rebuild sidecar assets, run focused Desktop tests and sidecar smoke, then run `npm run check`.
