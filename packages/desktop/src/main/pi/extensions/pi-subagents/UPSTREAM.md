# Vendored Upstream

- Project: pi-subagents
- Repository: https://github.com/nicobailon/pi-subagents
- Version: 0.47.0
- Commit: 5661d72f8bc395c3d0bac6ffdd0bd3e09008b371
- Declared license: MIT
- Vendored: 2026-08-12

The upstream commit declares MIT in `package.json` and includes the standard MIT `LICENSE` file.

The Desktop adaptation must preserve the upstream user-visible execution surface. Desktop's typed programmatic runtime is preferred when it can represent a launch contract; otherwise the complete upstream CLI runner remains the fallback. CLI/jiti, process-terminal tracking, and the upstream package resources are therefore shipped and tested rather than disabled.

Desktop-specific boundaries remain explicit:

- programmatic workers load only host-approved extensions and providers;
- configured extension paths, MCP direct tools, permissions, watchdogs, intercom detach, and unsupported runner profiles use the upstream runner until an equivalent typed sidecar capability exists;
- the embedded Electron Node runtime supplies the process for the fallback; no external Node installation is required;
- bundled agents, prompts, skills, README/docs, and package metadata are copied into the sidecar output.

When updating, review the upstream diff, retain the Desktop runtime boundary adaptations, update this commit, rebuild sidecar assets, run focused Desktop tests and sidecar smoke, then run `npm run check`.
