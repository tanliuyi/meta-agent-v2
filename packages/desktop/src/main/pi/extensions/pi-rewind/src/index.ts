import {
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { PiCheckpointNoticeDetails } from "../../../../../shared/pi-rewind-contracts.ts";
import {
  buildCheckpointSummary,
  createCheckpoint,
  DEFAULT_MAX_CHECKPOINTS,
  deleteCheckpoint,
  getRepoRoot,
  isGitRepo,
  loadAllCheckpoints,
  MUTATING_TOOLS,
} from "./core.ts";
import { registerRewindController } from "./service.ts";
import { createInitialState, resetState } from "./state.ts";

const CHECKPOINT_CUSTOM_TYPE = "pi-rewind.checkpoint";
const CHECKPOINT_ERROR_TYPE = "pi-rewind.error";
const INITIALIZATION_TIMEOUT_MS = 12_000;
const LIFECYCLE_CANCELLED = Symbol("pi-rewind lifecycle cancelled");

export default function piRewindDesktop(pi: ExtensionAPI): void {
  const state = createInitialState();
  let unregisterController: (() => void) | undefined;
  let initialization = Promise.resolve();
  let initializationTail = Promise.resolve();
  let initializationController: AbortController | undefined;

  const initialize = async (ctx: ExtensionContext, signal: AbortSignal): Promise<void> => {
    resetState(state);
    state.sessionId = ctx.sessionManager.getSessionId();
    state.gitAvailable = await isGitRepo(ctx.cwd, signal);
    if (!state.gitAvailable) return;

    state.repoRoot = await getRepoRoot(ctx.cwd, signal);
    const existing = await loadAllCheckpoints(state.repoRoot, state.sessionId, signal);
    const interruptedRestorePoints = existing
      .filter((checkpoint) => checkpoint.trigger === "before-restore")
      .toSorted((left, right) => right.timestamp - left.timestamp);
    const recoveryPoint = interruptedRestorePoints[0];
    await Promise.all(
      interruptedRestorePoints.slice(1).map((checkpoint) => deleteCheckpoint(state.repoRoot!, checkpoint.id, signal)),
    );
    for (const checkpoint of existing) {
      if (checkpoint.trigger !== "before-restore" || checkpoint.id === recoveryPoint?.id) {
        state.checkpoints.set(checkpoint.id, checkpoint);
      }
    }

    const resumeCheckpoint = await createCheckpoint({
      root: state.repoRoot,
      id: `resume-${state.sessionId}-${Date.now()}`,
      sessionId: state.sessionId,
      trigger: "resume",
      turnIndex: 0,
      description: "Session start",
      signal,
    });
    state.checkpoints.set(resumeCheckpoint.id, resumeCheckpoint);
    state.lastCheckpoint = resumeCheckpoint;
    await pruneCurrentSession(signal);

    if (recoveryPoint) {
      const summary = await buildCheckpointSummary(
        state.repoRoot,
        recoveryPoint.worktreeTreeSha,
        resumeCheckpoint.worktreeTreeSha,
        signal,
      );
      sendCheckpointNotice({
        checkpointId: resumeCheckpoint.id,
        restoreCheckpointId: recoveryPoint.id,
        reason: "recovery",
        description: "Recover workspace state from before an interrupted restore",
        ...summary,
      });
    }
  };

  const initializeSafely = async (ctx: ExtensionContext, controller: AbortController): Promise<void> => {
    const timeout = setTimeout(
      () => controller.abort(new Error(`Checkpoint initialization timed out after ${INITIALIZATION_TIMEOUT_MS}ms`)),
      INITIALIZATION_TIMEOUT_MS,
    );
    try {
      await initialize(ctx, controller.signal);
    } catch (error) {
      resetState(state);
      if (controller.signal.aborted && controller.signal.reason === LIFECYCLE_CANCELLED) return;
      const message = `Checkpoint history is disabled for this session: ${errorMessage(error)}`;
      console.warn(`[pi-rewind] ${message}`);
      ctx.ui.notify(message, "warning", {
        customType: CHECKPOINT_ERROR_TYPE,
        details: { message: errorMessage(error) },
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    initializationController?.abort(LIFECYCLE_CANCELLED);
    unregisterController?.();
    const controller = new AbortController();
    initializationController = controller;
    const previous = initializationTail;
    initialization = previous.then(() => initializeSafely(ctx, controller));
    initializationTail = initialization;
    unregisterController = registerRewindController(
      ctx.cwd,
      ctx.sessionManager.getSessionId(),
      state,
      () => initialization,
    );
  });

  pi.on("before_agent_start", async (event) => {
    await initialization;
    if (state.runActive) return;
    state.runActive = true;
    state.currentPrompt = truncate(collapseWhitespace(event.prompt), 60);
    resetRunState();
  });

  pi.on("turn_start", (event) => {
    state.currentTurnIndex = event.turnIndex;
  });

  pi.on("tool_call", (event) => {
    if (!MUTATING_TOOLS.has(event.toolName)) return;
    state.pendingToolInfo.set(event.toolCallId, describeToolCall(event));
  });

  pi.on("tool_execution_end", (event) => {
    if (!MUTATING_TOOLS.has(event.toolName)) return;
    const description = state.pendingToolInfo.get(event.toolCallId) ?? event.toolName;
    state.pendingToolInfo.delete(event.toolCallId);
    state.runHadMutations = true;
    state.runToolDescriptions.push(description);
  });

  pi.on("agent_settled", async () => {
    await initialization;
    if (!state.gitAvailable || !state.repoRoot || !state.sessionId || !state.runHadMutations) {
      finishRun();
      return;
    }
    const previous = state.lastCheckpoint;
    if (!previous) {
      finishRun();
      return;
    }

    state.pending = (async () => {
      const description = checkpointDescription(state.currentPrompt, state.runToolDescriptions, state.currentTurnIndex);
      const checkpoint = await createCheckpoint({
        root: state.repoRoot!,
        id: `run-${state.sessionId}-${state.currentTurnIndex}-${Date.now()}`,
        sessionId: state.sessionId!,
        trigger: "tool",
        turnIndex: state.currentTurnIndex,
        description,
      });
      if (
        checkpoint.worktreeTreeSha === previous.worktreeTreeSha &&
        checkpoint.indexTreeSha === previous.indexTreeSha
      ) {
        await deleteCheckpoint(state.repoRoot!, checkpoint.id);
        return;
      }

      const summary = await buildCheckpointSummary(
        state.repoRoot!,
        previous.worktreeTreeSha,
        checkpoint.worktreeTreeSha,
      );
      state.checkpoints.set(checkpoint.id, checkpoint);
      state.lastCheckpoint = checkpoint;
      sendCheckpointNotice({
        checkpointId: checkpoint.id,
        restoreCheckpointId: previous.id,
        reason: "run",
        description,
        ...summary,
      });
      await pruneCurrentSession();
    })();

    try {
      await state.pending;
    } catch (error) {
      console.warn(`[pi-rewind] checkpoint creation failed: ${errorMessage(error)}`);
    } finally {
      state.pending = null;
      finishRun();
    }
  });

  pi.on("session_shutdown", async () => {
    initializationController?.abort(LIFECYCLE_CANCELLED);
    unregisterController?.();
    unregisterController = undefined;
    await initialization;
    if (state.pending) await state.pending;
    resetState(state);
  });

  function sendCheckpointNotice(details: PiCheckpointNoticeDetails): void {
    pi.sendMessage<PiCheckpointNoticeDetails>({
      customType: CHECKPOINT_CUSTOM_TYPE,
      content: `Checkpoint recorded for ${details.fileCount} changed file${details.fileCount === 1 ? "" : "s"}.`,
      display: true,
      details,
    });
  }

  async function pruneCurrentSession(signal?: AbortSignal): Promise<void> {
    if (!state.repoRoot) return;
    const checkpoints = [...state.checkpoints.values()]
      .filter((checkpoint) => checkpoint.trigger !== "before-restore")
      .toSorted((left, right) => left.timestamp - right.timestamp);
    const stale = checkpoints.slice(0, Math.max(0, checkpoints.length - DEFAULT_MAX_CHECKPOINTS));
    for (const checkpoint of stale) {
      try {
        await deleteCheckpoint(state.repoRoot, checkpoint.id, signal);
        state.checkpoints.delete(checkpoint.id);
      } catch (error) {
        signal?.throwIfAborted();
        console.warn(`[pi-rewind] checkpoint pruning failed for ${checkpoint.id}: ${errorMessage(error)}`);
      }
    }
  }

  function resetRunState(): void {
    state.runToolDescriptions = [];
    state.runHadMutations = false;
    state.pendingToolInfo.clear();
  }

  function finishRun(): void {
    resetRunState();
    state.runActive = false;
  }
}

function describeToolCall(event: ToolCallEvent): string {
  if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
    return `${event.toolName}: ${event.input.path}`;
  }
  if (isToolCallEventType("bash", event)) {
    return `bash: ${truncate(collapseWhitespace(event.input.command), 50)}`;
  }
  return event.toolName;
}

function checkpointDescription(prompt: string, tools: readonly string[], turnIndex: number): string {
  const promptLabel = prompt ? `"${prompt}"` : "";
  const toolLabel = tools.join(", ");
  if (promptLabel && toolLabel) return `${promptLabel}: ${toolLabel}`;
  return promptLabel || toolLabel || `Turn ${turnIndex}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { getDesktopCheckpointDiff, restoreDesktopCheckpoint } from "./service.ts";
