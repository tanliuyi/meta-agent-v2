import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { SaveAuthConfigInput } from "../shared/auth-config-contracts.ts";
import { CHANNELS } from "../shared/channels.ts";
import type {
  HostResponse,
  SessionControlState,
  SessionCreateInput,
  SessionEditInput,
  SessionPromptInput,
  SessionReloadInput,
  TerminalEvent,
  WorkbenchState,
} from "../shared/contracts.ts";
import type { NodeRuntimeProgress, NodeRuntimeStatus } from "../shared/desktop-api.ts";
import type { SaveModelsConfigInput } from "../shared/models-config-contracts.ts";
import type { AuthConfigService } from "./auth/auth-config-service.ts";
import type { FileService } from "./files/file-service.ts";
import type { ModelsConfigService } from "./models/models-config-service.ts";
import type { SessionSupervisor } from "./pi/session-supervisor.ts";
import type { ProjectStore } from "./store/project-store.ts";
import type { TerminalSupervisor } from "./terminal/terminal-supervisor.ts";
import type { WindowDirtyGuard } from "./window-dirty-guard.ts";

/** 注册 Desktop 的 Project、Pi session、文件和 Workbench IPC。 */
const authEditorWebContents = new Set<number>();

export function registerIpc(
  projects: ProjectStore,
  sessions: SessionSupervisor,
  files: FileService,
  terminals: TerminalSupervisor,
  models: ModelsConfigService,
  auth: AuthConfigService,
  dirtyGuard: WindowDirtyGuard,
  nodeRuntime: {
    getStatus(): NodeRuntimeStatus;
    install(): Promise<NodeRuntimeStatus>;
    onProgress(listener: (progress: NodeRuntimeProgress) => void): () => void;
  },
): void {
  const subscribedWebContents = new Set<number>();
  const modelEditorWebContents = new Set<number>();
  ipcMain.on(CHANNELS.windowMinimize, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.on(CHANNELS.windowToggleMaximize, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return;
    if (owner.isMaximized()) owner.unmaximize();
    else owner.maximize();
  });
  ipcMain.on(CHANNELS.windowClose, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) void dirtyGuard.requestClose(owner);
  });
  ipcMain.handle(CHANNELS.linksOpen, (_event, target: string) => openLink(target, projects));
  ipcMain.handle(CHANNELS.modelsGetConfig, () => models.getConfig());
  ipcMain.handle(CHANNELS.modelsGetConfigRevision, () => models.getConfigRevision());
  ipcMain.handle(CHANNELS.modelsSaveConfig, (_event, input: SaveModelsConfigInput) => models.saveConfig(input));
  ipcMain.handle(CHANNELS.modelsOpenConfigExternally, async () => openPath(await models.getExternalOpenTarget()));
  ipcMain.handle(CHANNELS.authGetConfig, () => auth.getConfig());
  ipcMain.handle(CHANNELS.authGetConfigRevision, () => auth.getConfigRevision());
  ipcMain.handle(CHANNELS.authSaveConfig, (_event, input: SaveAuthConfigInput) => auth.saveConfig(input));
  ipcMain.handle(CHANNELS.authOpenConfigExternally, async () => openPath(await auth.getExternalOpenTarget()));
  ipcMain.on(CHANNELS.authSetEditorDirty, (event, dirty: unknown) => {
    if (typeof dirty !== "boolean") {
      event.returnValue = false;
      return;
    }
    const ownerId = event.sender.id;
    dirtyGuard.setDirty(ownerId, dirty);
    if (!authEditorWebContents.has(ownerId)) {
      authEditorWebContents.add(ownerId);
      event.sender.once("destroyed", () => {
        authEditorWebContents.delete(ownerId);
        dirtyGuard.remove(ownerId);
      });
    }
    event.returnValue = true;
  });

  ipcMain.on(CHANNELS.modelsSetEditorDirty, (event, dirty: unknown) => {
    if (typeof dirty !== "boolean") {
      event.returnValue = false;
      return;
    }
    const ownerId = event.sender.id;
    dirtyGuard.setDirty(ownerId, dirty);
    if (!modelEditorWebContents.has(ownerId)) {
      modelEditorWebContents.add(ownerId);
      event.sender.once("destroyed", () => {
        modelEditorWebContents.delete(ownerId);
        dirtyGuard.remove(ownerId);
      });
    }
    event.returnValue = true;
  });
  ipcMain.handle(CHANNELS.projectsList, () => projects.list());
  ipcMain.handle(CHANNELS.projectsActive, () => projects.getActive());
  ipcMain.handle(CHANNELS.projectsChoose, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled || !result.filePaths[0] ? null : projects.add(result.filePaths[0]);
  });
  ipcMain.handle(CHANNELS.projectsOpen, (_event, projectId: string) => projects.open(projectId));
  ipcMain.handle(CHANNELS.projectsRemove, async (_event, projectId: string) => {
    await sessions.removeProject(projectId);
    terminals.disposeProject(projectId);
    await projects.remove(projectId);
  });

  ipcMain.handle(CHANNELS.sessionsList, (_event, projectId: string, includeArchived?: boolean) =>
    sessions.list(projectId, includeArchived),
  );
  ipcMain.handle(CHANNELS.sessionsDraftConfig, (_event, projectId: string) => sessions.getDraftConfig(projectId));
  ipcMain.handle(CHANNELS.sessionsCreate, (_event, input: SessionCreateInput) => sessions.create(input));
  ipcMain.handle(CHANNELS.sessionsAttach, (event, projectId: string, threadId: string) => {
    const ownerId = event.sender.id;
    if (!subscribedWebContents.has(ownerId)) {
      subscribedWebContents.add(ownerId);
      event.sender.once("destroyed", () => {
        subscribedWebContents.delete(ownerId);
        sessions.detach(ownerId);
      });
    }
    return sessions.attach(ownerId, projectId, threadId, (update) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.sessionsPush, update);
    });
  });
  ipcMain.on(CHANNELS.sessionsDetach, (event, attachmentId?: string) => sessions.detach(event.sender.id, attachmentId));
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
  ipcMain.handle(CHANNELS.sessionsRemove, async (_event, projectId: string, threadId: string) => {
    await sessions.remove(projectId, threadId);
    terminals.disposeSession(projectId, threadId);
  });
  ipcMain.handle(CHANNELS.sessionsPrompt, (_event, input: SessionPromptInput) => sessions.prompt(input));
  ipcMain.handle(CHANNELS.sessionsEdit, (_event, input: SessionEditInput) => sessions.edit(input));
  ipcMain.handle(CHANNELS.sessionsReload, (_event, input: SessionReloadInput) => sessions.reload(input));
  ipcMain.handle(CHANNELS.sessionsCancel, (_event, projectId: string, threadId: string) =>
    sessions.cancel(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.sessionsClearQueue, (_event, projectId: string, threadId: string) =>
    sessions.clearQueue(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.sessionsCompact, (_event, projectId: string, threadId: string) =>
    sessions.compact(projectId, threadId),
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
  ipcMain.handle(CHANNELS.sessionsSetEditorText, (_event, projectId: string, threadId: string, text: string) =>
    sessions.setEditorText(projectId, threadId, text),
  );
  ipcMain.handle(CHANNELS.sessionsRespond, (_event, projectId: string, threadId: string, response: HostResponse) =>
    sessions.respond(projectId, threadId, response),
  );
  ipcMain.handle(CHANNELS.filesList, (_event, projectId: string, path?: string, query?: string) =>
    files.list(projectId, path, query),
  );
  ipcMain.handle(CHANNELS.filesRead, (_event, projectId: string, path: string) => files.read(projectId, path));
  ipcMain.handle(CHANNELS.filesResolvePath, (_event, path: string) => resolveFilePath(path, projects));
  ipcMain.handle(CHANNELS.filesOpen, async (_event, path: string) => {
    await openPath(await resolveFilePath(path, projects));
  });
  ipcMain.handle(
    CHANNELS.terminalsOpen,
    (_event, projectId: string, threadId: string, terminalId: string, cols: number, rows: number) =>
      terminals.open(projectId, threadId, terminalId, cols, rows),
  );
  ipcMain.handle(
    CHANNELS.terminalsWrite,
    (_event, projectId: string, threadId: string, terminalId: string, data: string) =>
      terminals.write(projectId, threadId, terminalId, data),
  );
  ipcMain.handle(
    CHANNELS.terminalsResize,
    (_event, projectId: string, threadId: string, terminalId: string, cols: number, rows: number) =>
      terminals.resize(projectId, threadId, terminalId, cols, rows),
  );
  ipcMain.handle(
    CHANNELS.terminalsRestart,
    (_event, projectId: string, threadId: string, terminalId: string, cols: number, rows: number) =>
      terminals.restart(projectId, threadId, terminalId, cols, rows),
  );
  ipcMain.handle(CHANNELS.workbenchGet, (_event, projectId: string, threadId: string) =>
    projects.getWorkbench(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.workbenchUpdate, (_event, state: WorkbenchState) => projects.setWorkbench(state));
  ipcMain.handle(CHANNELS.nodeRuntimeStatus, () => nodeRuntime.getStatus());
  ipcMain.handle(CHANNELS.nodeRuntimeInstall, () => nodeRuntime.install());
  nodeRuntime.onProgress((progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.nodeRuntimeProgress, progress);
    }
  });
}

async function openLink(target: string, projects: ProjectStore): Promise<void> {
  const value = target.trim();
  if (!value) throw new Error("Cannot open an empty link");

  const localTarget = value.split(/[?#]/, 1)[0];
  if (!localTarget) throw new Error("Cannot open a link without a file path");
  if (isAbsolute(localTarget)) {
    await openPath(decodeURIComponent(localTarget));
    return;
  }

  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    const project = await projects.getActive();
    if (!project?.available) throw new Error(project?.issue ?? "No active project is available");
    await openPath(resolve(project.cwd, decodeURIComponent(localTarget)));
    return;
  }

  if (url.protocol === "file:") {
    await openPath(fileURLToPath(url));
    return;
  }

  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:") {
    await shell.openExternal(url.href);
    return;
  }

  throw new Error(`Unsupported link protocol: ${url.protocol}`);
}

async function resolveFilePath(path: string, projects: ProjectStore): Promise<string> {
  const value = path.trim();
  if (!value) throw new Error("Cannot resolve an empty file path");
  if (isAbsolute(value)) return value;

  const project = await projects.getActive();
  if (!project?.available) throw new Error(project?.issue ?? "No active project is available");
  return resolve(project.cwd, value);
}

async function openPath(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

/** 向所有 renderer 广播 PTY 增量事件。 */
export function broadcastTerminalEvent(event: TerminalEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.terminalsEvent, event);
  }
}
