import { ipcMain } from "electron";
import { CHANNELS } from "../../shared/channels.ts";
import type {
  HostResponse,
  OpenPluginCallArtifactInput,
  SessionAttachInput,
  SessionBranchInput,
  SessionBranchResult,
  SessionControlState,
  SessionCreateInput,
  SessionCreateIpcResult,
  SessionEditInput,
  SessionPromptInput,
  SessionReloadInput,
  SessionRemovePolicy,
  SessionResourceReloadInput,
} from "../../shared/contracts.ts";
import type {
  SessionCheckpointDiffInput,
  SessionCheckpointDiffResult,
  SessionCheckpointRestoreInput,
  SessionCheckpointRestoreResult,
} from "../../shared/pi-rewind-contracts.ts";
import type { SessionSupervisor } from "../pi/session-supervisor.ts";
import type { TerminalSupervisor } from "../terminal/terminal-supervisor.ts";
import { openPath } from "./ipc-shared.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** session IPC 所需的 supervisor 和 terminal 清理依赖。 */
export interface SessionIpcDependencies {
  readonly sessions: SessionSupervisor;
  readonly terminals: TerminalSupervisor;
}

/** session registrar 可能注册的 channel 清单。 */
export const SESSION_IPC_CHANNELS = [
  CHANNELS.sessionsList,
  CHANNELS.sessionsListWithPaths,
  CHANNELS.sessionsDraftConfig,
  CHANNELS.sessionsCreate,
  CHANNELS.sessionsAttach,
  CHANNELS.sessionsPrewarm,
  CHANNELS.sessionsDetach,
  CHANNELS.sessionsClose,
  CHANNELS.sessionsAck,
  CHANNELS.sessionsRename,
  CHANNELS.sessionsArchive,
  CHANNELS.sessionsRemove,
  CHANNELS.sessionsPromote,
  CHANNELS.sessionsPrompt,
  CHANNELS.sessionsEdit,
  CHANNELS.sessionsReload,
  CHANNELS.sessionsReloadResources,
  CHANNELS.sessionsOpenPluginCallArtifact,
  CHANNELS.sessionsGetCheckpointDiff,
  CHANNELS.sessionsRestoreCheckpoint,
  CHANNELS.sessionsBranch,
  CHANNELS.sessionsCancel,
  CHANNELS.sessionsClearQueue,
  CHANNELS.sessionsCompact,
  CHANNELS.sessionsRefreshModels,
  CHANNELS.sessionsSetModel,
  CHANNELS.sessionsSetThinking,
  CHANNELS.sessionsRespond,
  CHANNELS.sessionsReadImageResource,
] as const;

/** 注册 session 生命周期、控制、附件和 checkpoint IPC。 */
export function registerSessionIpc({ sessions, terminals }: SessionIpcDependencies): readonly string[] {
  const subscribedWebContents = new Set<number>();
  ipcMain.handle(CHANNELS.sessionsList, (_event, projectId: string, includeArchived?: boolean) =>
    sessions.list(projectId, includeArchived),
  );
  ipcMain.handle(CHANNELS.sessionsListWithPaths, (_event, projectId: string) => sessions.listWithPaths(projectId));
  ipcMain.handle(CHANNELS.sessionsDraftConfig, (_event, projectId: string, worktreePath?: string) =>
    sessions.getDraftConfig(projectId, worktreePath),
  );
  ipcMain.handle(
    CHANNELS.sessionsCreate,
    async (_event, input: SessionCreateInput): Promise<SessionCreateIpcResult> => {
      try {
        return { ok: true, bootstrap: await sessions.create(input) };
      } catch (error) {
        if (isStaleDraftExtensionSetError(error)) {
          return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
        }
        throw error;
      }
    },
  );
  ipcMain.handle(CHANNELS.sessionsAttach, (event, input: SessionAttachInput) => {
    const ownerId = event.sender.id;
    if (!subscribedWebContents.has(ownerId)) {
      subscribedWebContents.add(ownerId);
      event.sender.once("destroyed", () => {
        subscribedWebContents.delete(ownerId);
        sessions.detachAll(ownerId);
      });
    }
    return sessions.attach(ownerId, input, (update) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.sessionsPush, update);
    });
  });
  ipcMain.handle(CHANNELS.sessionsPrewarm, (_event, projectId: string, threadId: string) =>
    sessions.prewarm(projectId, threadId),
  );
  ipcMain.on(CHANNELS.sessionsDetach, (event, attachmentId: string) => sessions.detach(event.sender.id, attachmentId));
  ipcMain.handle(CHANNELS.sessionsClose, (event, projectId: string, threadId: string) =>
    sessions.close(event.sender.id, projectId, threadId),
  );
  ipcMain.on(CHANNELS.sessionsAck, (event, attachmentId: string, workerInstanceId: string, sidecarSequence: number) => {
    if (!Number.isSafeInteger(sidecarSequence) || sidecarSequence < 1) return;
    sessions.acknowledge(event.sender.id, attachmentId, workerInstanceId, sidecarSequence);
  });
  ipcMain.handle(CHANNELS.sessionsRename, (_event, projectId: string, threadId: string, title: string) =>
    sessions.rename(projectId, threadId, title),
  );
  ipcMain.handle(CHANNELS.sessionsArchive, (_event, projectId: string, threadId: string, archived: boolean) =>
    sessions.archive(projectId, threadId, archived),
  );
  ipcMain.handle(
    CHANNELS.sessionsRemove,
    async (_event, projectId: string, threadId: string, policy: SessionRemovePolicy) => {
      if (policy !== "subtree" && policy !== "reparent") throw new Error(`Invalid session removal policy: ${policy}`);
      const result = await sessions.remove(projectId, threadId, policy);
      for (const removedThreadId of result.removedThreadIds) terminals.disposeSession(projectId, removedThreadId);
      return result;
    },
  );
  ipcMain.handle(CHANNELS.sessionsPromote, (_event, projectId: string, threadId: string) =>
    sessions.promote(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.sessionsPrompt, (_event, input: SessionPromptInput) => sessions.prompt(input));
  ipcMain.handle(CHANNELS.sessionsEdit, (_event, input: SessionEditInput) => sessions.edit(input));
  ipcMain.handle(CHANNELS.sessionsReload, (_event, input: SessionReloadInput) => sessions.reload(input));
  ipcMain.handle(CHANNELS.sessionsReloadResources, (_event, input: SessionResourceReloadInput) =>
    sessions.reloadResources(input),
  );
  ipcMain.handle(CHANNELS.sessionsOpenPluginCallArtifact, async (event, input: OpenPluginCallArtifactInput) => {
    await openPath(await sessions.resolvePluginCallArtifact(event.sender.id, input));
  });
  ipcMain.handle(
    CHANNELS.sessionsGetCheckpointDiff,
    (_event, input: SessionCheckpointDiffInput): Promise<SessionCheckpointDiffResult> =>
      sessions.getCheckpointDiff(input),
  );
  ipcMain.handle(
    CHANNELS.sessionsRestoreCheckpoint,
    (_event, input: SessionCheckpointRestoreInput): Promise<SessionCheckpointRestoreResult> =>
      sessions.restoreCheckpoint(input),
  );
  ipcMain.handle(
    CHANNELS.sessionsBranch,
    (_event, input: SessionBranchInput): Promise<SessionBranchResult> => sessions.branch(input),
  );
  ipcMain.handle(CHANNELS.sessionsCancel, (_event, projectId: string, threadId: string) =>
    sessions.cancel(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.sessionsClearQueue, (_event, projectId: string, threadId: string) =>
    sessions.clearQueue(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.sessionsCompact, (_event, projectId: string, threadId: string) =>
    sessions.compact(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.sessionsRefreshModels, (_event, projectId: string, threadId: string) =>
    sessions.refreshModels(projectId, threadId),
  );
  ipcMain.handle(
    CHANNELS.sessionsSetModel,
    (_event, projectId: string, threadId: string, provider: string, modelId: string) =>
      sessions.setModel(projectId, threadId, provider, modelId),
  );
  ipcMain.handle(
    CHANNELS.sessionsSetThinking,
    (_event, projectId: string, threadId: string, level: SessionControlState["thinkingLevel"]) =>
      sessions.setThinking(projectId, threadId, level),
  );
  ipcMain.handle(CHANNELS.sessionsRespond, (_event, projectId: string, threadId: string, response: HostResponse) =>
    sessions.respond(projectId, threadId, response),
  );
  ipcMain.handle(CHANNELS.sessionsReadImageResource, (event, attachmentId: string, resourceId: string) => {
    if (typeof attachmentId !== "string" || typeof resourceId !== "string" || !UUID_PATTERN.test(resourceId)) {
      throw new Error("Invalid image resource request");
    }
    return sessions.readImageResource(event.sender.id, attachmentId, resourceId);
  });
  return SESSION_IPC_CHANNELS;
}

function isStaleDraftExtensionSetError(error: unknown): error is Error & {
  code: "STALE_DRAFT_EXTENSION_SET";
  details: { code: "STALE_DRAFT_EXTENSION_SET"; requestedGeneration: string; currentGeneration: string };
} {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "STALE_DRAFT_EXTENSION_SET" &&
    "details" in error &&
    typeof error.details === "object" &&
    error.details !== null
  );
}
