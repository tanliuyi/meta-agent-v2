# Vendored Upstream

- Project: pi-hermes-memory
- Repository: https://github.com/chandra447/pi-hermes-memory
- Version: 0.8.2
- Commit: 4ae04830daa59d90e6b1b99af2cb989090824f47
- License: MIT, see `LICENSE`
- Vendored: 2026-07-24

The source is maintained in-tree as a Meta Agent Desktop built-in extension. Desktop-specific changes include:

- declarative Desktop command UI instead of Pi TUI custom components;
- compiled sidecar paths for child extension and watchdog processes;
- Node's built-in `node:sqlite` instead of `better-sqlite3` and runtime rebuilds;
- erasable TypeScript syntax required by the monorepo;
- ESM-compatible filesystem access.

When updating, review the upstream diff, retain the Desktop adaptations, update this commit, and run the focused Desktop extension tests plus `npm run check`.
