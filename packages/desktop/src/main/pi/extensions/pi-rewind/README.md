# Pi Rewind Desktop

Desktop-integrated checkpoint support adapted from `pi-rewind`.

The built-in extension records one Git-backed workspace checkpoint after each complete agent run that used `write`, `edit`, or `bash`. Tool-loop turns are aggregated, and the checkpoint card is emitted only after the final assistant response has settled. It emits a structured `pi-rewind.checkpoint` session message containing bounded file statistics. Meta Agent Desktop loads each patch on demand when its file row is expanded and restores the selected pre-turn checkpoint through typed session IPC actions.

## Desktop behavior

- No slash commands, TUI shortcuts, custom TUI renderers, or conversation navigation.
- Checkpoint review and restore are native Desktop controls.
- Restore changes only the working tree and Git index. It does not move `HEAD` or rewrite branch history.
- Restore is limited to the branch on which the checkpoint was created.
- Restore is rejected while another thread or subagent in the project is active.
- Ignored directories, untracked files larger than 10 MiB, and untracked directories with at least 200 files are excluded.
- File metadata and on-demand patch output are bounded. Large patches are identified in the UI.

## Storage

Snapshots are stored under `refs/pi-checkpoints/` in the current repository. Each session retains up to 50 normal checkpoints. Sessions do not prune one another's refs because several Desktop workers can use the same repository concurrently.

## Risk boundary

This is a full-trust built-in extension. It runs Git and mutates the current repository when the user selects Undo. Restore compares both the expected worktree and index snapshots, creates a temporary before-restore checkpoint, and attempts an automatic rollback if restore fails. If Desktop exits during restore, the next session preserves the latest temporary checkpoint and shows a recovery card.

## Verification

From `packages/desktop`:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/pi-rewind-core.test.ts test/pi-rewind-extension.test.ts test/pi-rewind-checkpoint-view.test.tsx
```

Then run the repository check from the repository root:

```bash
npm run check
```
