# Upstream

- Project: `pi-rewind`
- Repository: https://github.com/arpagon/pi-rewind
- Imported commit: `91611ad` (`v0.5.0: adapt to pi session event changes, headless checkpoint support`)
- License: MIT; see `LICENSE`

## Desktop adaptations

- Replaced `@mariozechner/pi-coding-agent` with the repository's `@earendil-works/pi-coding-agent` host API.
- Removed `/rewind`, `Esc+Esc`, TUI theme/footer rendering, and conversation-tree navigation.
- Added structured per-turn checkpoint messages consumed by the Desktop React renderer.
- Added a typed Desktop session action for checkpoint restore.
- Changed restore semantics so Git `HEAD` is never moved.
- Replaced shell-like Git command parsing with structured `spawn` arguments.
- Added bounded per-file unified diffs and Desktop-focused tests.

The original README and package manifest are retained as `README.upstream.md` and `package.upstream.json`. Upstream benchmark, website, planning logs, and provider-backed E2E scripts were not vendored because they are not runtime inputs and do not match the Desktop test harness.
