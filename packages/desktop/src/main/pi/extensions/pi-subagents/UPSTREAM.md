# Vendored Upstream

- Project: pi-subagents
- Repository: https://github.com/nicobailon/pi-subagents
- Version: 0.65.0
- Commit: 6e4402854bca7ce6bec0fcfe3055dcf38b436e7b
- Declared license: MIT
- Vendored: 2026-09-05

The upstream commit declares MIT in `package.json` and includes the standard MIT `LICENSE` file.

This snapshot includes upstream `0.65.0` plus the post-release fixes through
`6e4402854bca7ce6bec0fcfe3055dcf38b436e7b`; the upstream package version remains
`0.65.0`.

The Desktop adaptation must preserve the upstream user-visible execution surface. Desktop's typed programmatic runtime is preferred when it can represent a launch contract; otherwise the complete upstream CLI runner remains the fallback. CLI/jiti, process-terminal tracking, and the upstream package resources are therefore shipped and tested rather than disabled.

Desktop-specific boundaries remain explicit:

- programmatic workers load only host-approved extensions and providers;
- configured extension paths, MCP direct tools, permissions, watchdogs, and unsupported runner profiles use the upstream runner until an equivalent typed sidecar capability exists;
- child intercom coordination (contact_supervisor/intercom) is supported on the programmatic runtime through the shared supervisor channel; only the CLI parent-detach mechanism for direct foreground runs remains on the upstream runner;
- the embedded Electron Node runtime supplies the process for the fallback; no external Node installation is required;
- bundled agents, prompts, skills, README/docs, and package metadata are copied into the sidecar output.

The snapshot also carries narrowly scoped local hardenings required by the
Desktop environment: ESM worker bootstrapping and syntax diagnostics for
`workflowScript`, proxy-aware HTTP dispatch in detached runners, and selecting
the compiled JavaScript runner from the sidecar (with a TypeScript fallback for
source execution). These do not change the public subagent API.

When updating, review the upstream diff, retain the Desktop runtime boundary adaptations, update this commit, rebuild sidecar assets, run focused Desktop tests and sidecar smoke, then run `npm run check`.
