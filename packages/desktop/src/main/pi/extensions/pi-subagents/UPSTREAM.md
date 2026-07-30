# Vendored Upstream

- Project: pi-subagents
- Repository: https://github.com/nicobailon/pi-subagents
- Version: 0.37.2
- Commit: 8063333661476ca48afbca826dc4aab8707c72d3
- Declared license: MIT
- Vendored: 2026-07-30

The upstream commit declares MIT in `package.json` and includes the standard MIT `LICENSE` file.

This source is maintained in-tree as a Meta Agent Desktop built-in extension. Desktop-specific changes include:

- child Pi execution is provided by Desktop's typed programmatic runtime and Main-owned Electron embedded Node sidecar workers; no external Pi or Node executable is resolved;
- `PI_SUBAGENT_PI_BINARY`, PATH `pi`, PATH `node`, package-ancestry CLI fallbacks, and detached CLI runners remain disabled;
- child capabilities are loaded through controlled inline provider/runtime/fanout extension factories rather than arbitrary child extension paths;
- TUI-only custom components, terminal input, widgets, and tools-expanded state are disabled or downgraded in Desktop RPC mode;
- bundled agents, prompts, and skills are copied into the sidecar output;
- source follows this monorepo's erasable TypeScript and formatting rules.

When updating, review the upstream diff, retain the Desktop runtime boundary adaptations, update this commit, rebuild sidecar assets, run focused Desktop tests and sidecar smoke, then run `npm run check`.
