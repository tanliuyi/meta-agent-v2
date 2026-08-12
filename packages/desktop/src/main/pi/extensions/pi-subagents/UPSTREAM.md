# Vendored Upstream

- Project: pi-subagents
- Repository: https://github.com/nicobailon/pi-subagents
- Version: 0.47.0
- Commit: 5661d72f8bc395c3d0bac6ffdd0bd3e09008b371
- Declared license: MIT
- Vendored: 2026-08-12

The upstream commit declares MIT in `package.json` and includes the standard MIT `LICENSE` file.

This source is maintained in-tree as a Meta Agent Desktop built-in extension. Desktop-specific changes include:

- child Pi execution is provided by Desktop's typed programmatic runtime and Main-owned Electron embedded Node sidecar workers; no external Pi or Node executable is resolved;
- `PI_SUBAGENT_PI_BINARY`, PATH `pi`, PATH `node`, package-ancestry CLI fallbacks, and detached CLI runners remain disabled;
- the foreground/async execution chain (subagent-executor, execution, chain-execution, async-execution, foreground-control, chain-clarify, async-steering-action, extension entry) is kept on the 0.37.2 programmatic runtime; upstream 0.47.0 switched execution to spawning a standalone Pi process (`runner.type="pi"`), which Desktop cannot provide;
- upstream 0.47.0 added `process-terminal` proof tracking and the fleet transcript/widget (fleet-status, fleet-transcript); these are dropped along with their call sites and types;
- the async CLI runner (`subagent-runner.ts`) remains deleted, so `isAsyncAvailable()` still returns false;
- child capabilities are loaded through controlled inline provider/runtime/fanout extension factories rather than arbitrary child extension paths;
- TUI-only custom components, terminal input, widgets, and tools-expanded state are disabled or downgraded in Desktop RPC mode;
- bundled agents, prompts, and skills are copied into the sidecar output;
- source follows this monorepo's erasable TypeScript and formatting rules.

When updating, review the upstream diff, retain the Desktop runtime boundary adaptations, update this commit, rebuild sidecar assets, run focused Desktop tests and sidecar smoke, then run `npm run check`.
