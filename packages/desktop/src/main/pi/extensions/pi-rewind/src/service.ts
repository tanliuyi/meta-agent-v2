import { resolve } from "node:path";
import type {
  SessionCheckpointDiffResult,
  SessionCheckpointRestoreResult,
} from "../../../../../shared/pi-rewind-contracts.ts";
import {
  buildCheckpointFileDiff,
  countChangedFiles,
  createCheckpoint,
  DEFAULT_MAX_CHECKPOINTS,
  deleteCheckpoint,
  replaceCheckpointRefs,
  restoreCheckpoint,
} from "./core.ts";
import type { RewindState } from "./state.ts";

interface RewindController {
  diff(fromCheckpointId: string, toCheckpointId: string, path: string): Promise<SessionCheckpointDiffResult>;
  restore(checkpointId: string, expectedCheckpointId: string): Promise<SessionCheckpointRestoreResult>;
}

const controllers = new Map<string, RewindController>();

export function registerRewindController(
  cwd: string,
  sessionId: string,
  state: RewindState,
  ready: () => Promise<void> = () => Promise.resolve(),
): () => void {
  const key = controllerKey(cwd, sessionId);
  const controller: RewindController = {
    diff: async (fromCheckpointId, toCheckpointId, path) => {
      await ready();
      return diffFromState(state, fromCheckpointId, toCheckpointId, path);
    },
    restore: async (checkpointId, expectedCheckpointId) => {
      await ready();
      return restoreFromState(state, checkpointId, expectedCheckpointId);
    },
  };
  controllers.set(key, controller);
  return () => {
    if (controllers.get(key) === controller) controllers.delete(key);
  };
}

export async function getDesktopCheckpointDiff(
  cwd: string,
  sessionId: string,
  fromCheckpointId: string,
  toCheckpointId: string,
  path: string,
): Promise<SessionCheckpointDiffResult> {
  const controller = controllers.get(controllerKey(cwd, sessionId));
  if (!controller) throw new Error("Checkpoint service is unavailable for this session");
  return controller.diff(fromCheckpointId, toCheckpointId, path);
}

export async function restoreDesktopCheckpoint(
  cwd: string,
  sessionId: string,
  checkpointId: string,
  expectedCheckpointId: string,
): Promise<SessionCheckpointRestoreResult> {
  const controller = controllers.get(controllerKey(cwd, sessionId));
  if (!controller) throw new Error("Checkpoint service is unavailable for this session");
  return controller.restore(checkpointId, expectedCheckpointId);
}

async function diffFromState(
  state: RewindState,
  fromCheckpointId: string,
  toCheckpointId: string,
  path: string,
): Promise<SessionCheckpointDiffResult> {
  if (!state.gitAvailable || !state.repoRoot) throw new Error("Checkpoint diff requires a Git repository");
  const from = state.checkpoints.get(fromCheckpointId);
  const to = state.checkpoints.get(toCheckpointId);
  if (!from || !to) throw new Error("Checkpoint is no longer available");
  return buildCheckpointFileDiff(state.repoRoot, from.worktreeTreeSha, to.worktreeTreeSha, path);
}

async function restoreFromState(
  state: RewindState,
  checkpointId: string,
  expectedCheckpointId: string,
): Promise<SessionCheckpointRestoreResult> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
    throw new Error("Checkpoint restore requires a Git repository");
  }
  if (state.pending) await state.pending;
  const target = state.checkpoints.get(checkpointId);
  const expected = state.checkpoints.get(expectedCheckpointId);
  if (!target || !expected) throw new Error("Checkpoint is no longer available");

  const before = await createCheckpoint({
    root: state.repoRoot,
    id: `before-restore-${state.sessionId}-${Date.now()}`,
    sessionId: state.sessionId,
    trigger: "before-restore",
    turnIndex: state.currentTurnIndex,
    description: `Before restoring ${checkpointId}`,
  });
  if (before.worktreeTreeSha !== expected.worktreeTreeSha || before.indexTreeSha !== expected.indexTreeSha) {
    await deleteCheckpoint(state.repoRoot, before.id);
    throw new Error("Workspace or staging changed after this checkpoint; review the latest changes before undoing");
  }
  const restoredFiles = await countChangedFiles(state.repoRoot, target.worktreeTreeSha, before.worktreeTreeSha);

  try {
    await restoreCheckpoint(state.repoRoot, target, before);
  } catch (restoreError) {
    if (!(restoreError instanceof AggregateError)) await deleteCheckpoint(state.repoRoot, before.id);
    throw restoreError;
  }

  if (target.trigger === "before-restore") {
    const recovered = await createCheckpoint({
      root: state.repoRoot,
      id: `recovered-${state.sessionId}-${Date.now()}`,
      sessionId: state.sessionId,
      trigger: "resume",
      turnIndex: state.currentTurnIndex,
      description: `Recovered interrupted restore ${target.id}`,
      publish: false,
    });
    const retained = [...state.checkpoints.values(), recovered]
      .filter(
        (checkpoint) =>
          checkpoint.trigger !== "before-restore" && checkpoint.id !== target.id && checkpoint.id !== before.id,
      )
      .toSorted((left, right) => right.timestamp - left.timestamp);
    const pruned = retained.slice(DEFAULT_MAX_CHECKPOINTS);
    await replaceCheckpointRefs(state.repoRoot, [recovered], [target, before, ...pruned]);
    state.checkpoints.delete(target.id);
    for (const checkpoint of pruned) state.checkpoints.delete(checkpoint.id);
    state.checkpoints.set(recovered.id, recovered);
    state.lastCheckpoint = recovered;
  } else {
    await deleteCheckpoint(state.repoRoot, before.id);
    state.lastCheckpoint = target;
  }
  return { checkpointId: target.id, restoredFiles };
}

function controllerKey(cwd: string, sessionId: string): string {
  const normalizedCwd = resolve(cwd).replace(/\\/g, "/");
  return `${process.platform === "win32" ? normalizedCwd.toLowerCase() : normalizedCwd}\0${sessionId}`;
}
