import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../shared/channels.ts";
import type { SessionAttachment, SessionPush, SessionPushPayload, TerminalEvent } from "../shared/contracts.ts";
import type { DesktopApi, DesktopPlatform, NodeRuntimeProgress } from "../shared/desktop-api.ts";

interface ActiveSessionAttachment {
  attachmentId: string;
  listener(update: SessionPushPayload): void;
  buffered: SessionPush[];
  bufferedBytes: number;
  ready: boolean;
}

interface PendingSessionAttachment {
  listener(update: SessionPushPayload): void;
  buffered: SessionPush[];
  bufferedBytes: number;
}

const MAX_BUFFERED_SESSION_PUSHES = 128;
const MAX_BUFFERED_SESSION_BYTES = 16 * 1024 * 1024;

let sessionGeneration = 0;
const overflowRecoveryTargets = new Set<string>();
let activeSessionAttachment: ActiveSessionAttachment | undefined;
let pendingSessionAttachment: PendingSessionAttachment | undefined;
ipcRenderer.on(CHANNELS.sessionsPush, (_event, update: SessionPush) => {
  if (activeSessionAttachment?.attachmentId === update.attachmentId) {
    if (!activeSessionAttachment.ready) {
      bufferSessionUpdate(activeSessionAttachment, update);
      return;
    }
    deliverSessionUpdate(activeSessionAttachment, update);
    return;
  }
  if (pendingSessionAttachment) bufferSessionUpdate(pendingSessionAttachment, update);
});

function bufferSessionUpdate(
  attachment: ActiveSessionAttachment | PendingSessionAttachment,
  update: SessionPush,
): void {
  const bytes = JSON.stringify(update).length * 2;
  if (
    attachment.buffered.length >= MAX_BUFFERED_SESSION_PUSHES ||
    attachment.bufferedBytes + bytes > MAX_BUFFERED_SESSION_BYTES
  ) {
    attachment.buffered = [];
    attachment.bufferedBytes = 0;
    overflowRecoveryTargets.add(sessionTargetKey(update.projectId, update.threadId));
    ipcRenderer.send(CHANNELS.sessionsDetach, update.attachmentId);
    return;
  }
  attachment.buffered.push(update);
  attachment.bufferedBytes += bytes;
}

function deliverSessionUpdate(attachment: ActiveSessionAttachment, update: SessionPush): void {
  const { attachmentId: _attachmentId, ...payload } = update;
  try {
    attachment.listener(payload);
  } finally {
    ipcRenderer.send(CHANNELS.sessionsAck, attachment.attachmentId, update.workerInstanceId, update.sidecarSequence);
  }
}

const platform: DesktopPlatform =
  process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";

const desktopApi: DesktopApi = {
  platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  links: {
    open: (url) => ipcRenderer.invoke(CHANNELS.linksOpen, url),
  },
  models: {
    getConfig: () => ipcRenderer.invoke(CHANNELS.modelsGetConfig),
    getConfigRevision: () => ipcRenderer.invoke(CHANNELS.modelsGetConfigRevision),
    saveConfig: (input) => ipcRenderer.invoke(CHANNELS.modelsSaveConfig, input),
    openConfigExternally: () => ipcRenderer.invoke(CHANNELS.modelsOpenConfigExternally),
    setEditorDirty: (dirty) => ipcRenderer.sendSync(CHANNELS.modelsSetEditorDirty, dirty) === true,
  },
  auth: {
    getConfig: () => ipcRenderer.invoke(CHANNELS.authGetConfig),
    getConfigRevision: () => ipcRenderer.invoke(CHANNELS.authGetConfigRevision),
    saveConfig: (input) => ipcRenderer.invoke(CHANNELS.authSaveConfig, input),
    openConfigExternally: () => ipcRenderer.invoke(CHANNELS.authOpenConfigExternally),
    setEditorDirty: (dirty) => ipcRenderer.sendSync(CHANNELS.authSetEditorDirty, dirty) === true,
  },
  nodeRuntime: {
    getStatus: () => ipcRenderer.invoke(CHANNELS.nodeRuntimeStatus),
    install: () => ipcRenderer.invoke(CHANNELS.nodeRuntimeInstall),
    onProgress(listener) {
      const handler = (_event: Electron.IpcRendererEvent, progress: NodeRuntimeProgress) => listener(progress);
      ipcRenderer.on(CHANNELS.nodeRuntimeProgress, handler);
      return () => ipcRenderer.removeListener(CHANNELS.nodeRuntimeProgress, handler);
    },
  },
  windowControls: {
    minimize: () => ipcRenderer.send(CHANNELS.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(CHANNELS.windowToggleMaximize),
    close: () => ipcRenderer.send(CHANNELS.windowClose),
    onMaximizedChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized);
      ipcRenderer.on(CHANNELS.windowMaximizedChanged, handler);
      return () => ipcRenderer.removeListener(CHANNELS.windowMaximizedChanged, handler);
    },
  },
  projects: {
    list: () => ipcRenderer.invoke(CHANNELS.projectsList),
    choose: () => ipcRenderer.invoke(CHANNELS.projectsChoose),
    open: (projectId) => ipcRenderer.invoke(CHANNELS.projectsOpen, projectId),
    remove: (projectId) => ipcRenderer.invoke(CHANNELS.projectsRemove, projectId),
    getActive: () => ipcRenderer.invoke(CHANNELS.projectsActive),
  },
  sessions: {
    list: (projectId, includeArchived) => ipcRenderer.invoke(CHANNELS.sessionsList, projectId, includeArchived),
    getDraftConfig: (projectId) => ipcRenderer.invoke(CHANNELS.sessionsDraftConfig, projectId),
    create: (input) => ipcRenderer.invoke(CHANNELS.sessionsCreate, input),
    async attach(projectId, threadId, listener) {
      const generation = ++sessionGeneration;
      const previous = activeSessionAttachment;
      const pending: PendingSessionAttachment = { listener, buffered: [], bufferedBytes: 0 };
      pendingSessionAttachment = pending;
      try {
        const attachment: SessionAttachment = await ipcRenderer.invoke(CHANNELS.sessionsAttach, projectId, threadId);
        if (generation !== sessionGeneration || pendingSessionAttachment !== pending) {
          ipcRenderer.send(CHANNELS.sessionsDetach, attachment.attachmentId);
          throw new DOMException("Session attach superseded", "AbortError");
        }
        pendingSessionAttachment = undefined;
        const targetKey = sessionTargetKey(projectId, threadId);
        if (overflowRecoveryTargets.delete(targetKey)) {
          ipcRenderer.send(CHANNELS.sessionsDetach, attachment.attachmentId);
          activeSessionAttachment = undefined;
          return desktopApi.sessions.attach(projectId, threadId, listener);
        }
        const buffered = pending.buffered.filter((update) => update.attachmentId === attachment.attachmentId);
        activeSessionAttachment = {
          attachmentId: attachment.attachmentId,
          listener,
          buffered,
          bufferedBytes: buffered.reduce((total, update) => total + JSON.stringify(update).length * 2, 0),
          ready: false,
        };
        return attachment.bootstrap;
      } catch (error) {
        if (generation === sessionGeneration && pendingSessionAttachment === pending) {
          pendingSessionAttachment = undefined;
          activeSessionAttachment = previous;
        }
        throw error;
      }
    },
    flush() {
      const current = activeSessionAttachment;
      if (!current || current.ready) return;
      current.ready = true;
      const buffered = current.buffered;
      current.buffered = [];
      current.bufferedBytes = 0;
      for (const update of buffered) deliverSessionUpdate(current, update);
    },
    detach() {
      sessionGeneration += 1;
      pendingSessionAttachment = undefined;
      const current = activeSessionAttachment;
      activeSessionAttachment = undefined;
      ipcRenderer.send(CHANNELS.sessionsDetach, current?.attachmentId);
    },
    rename: (projectId, threadId, title) => ipcRenderer.invoke(CHANNELS.sessionsRename, projectId, threadId, title),
    archive: (projectId, threadId, archived) =>
      ipcRenderer.invoke(CHANNELS.sessionsArchive, projectId, threadId, archived),
    remove: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsRemove, projectId, threadId),
    prompt: (input) => ipcRenderer.invoke(CHANNELS.sessionsPrompt, input),
    edit: (input) => ipcRenderer.invoke(CHANNELS.sessionsEdit, input),
    reload: (input) => ipcRenderer.invoke(CHANNELS.sessionsReload, input),
    cancel: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsCancel, projectId, threadId),
    clearQueue: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsClearQueue, projectId, threadId),
    compact: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsCompact, projectId, threadId),
    setModel: (projectId, threadId, provider, modelId) =>
      ipcRenderer.invoke(CHANNELS.sessionsSetModel, projectId, threadId, provider, modelId),
    setThinking: (projectId, threadId, level) =>
      ipcRenderer.invoke(CHANNELS.sessionsSetThinking, projectId, threadId, level),
    setEditorText: (projectId, threadId, text) =>
      ipcRenderer.invoke(CHANNELS.sessionsSetEditorText, projectId, threadId, text),
    respond: (projectId, threadId, response) =>
      ipcRenderer.invoke(CHANNELS.sessionsRespond, projectId, threadId, response),
  },
  files: {
    list: (projectId, path, query) => ipcRenderer.invoke(CHANNELS.filesList, projectId, path, query),
    read: (projectId, path) => ipcRenderer.invoke(CHANNELS.filesRead, projectId, path),
    resolvePath: (path) => ipcRenderer.invoke(CHANNELS.filesResolvePath, path),
    open: (path) => ipcRenderer.invoke(CHANNELS.filesOpen, path),
  },
  terminals: {
    open: (projectId, threadId, terminalId, cols, rows) =>
      ipcRenderer.invoke(CHANNELS.terminalsOpen, projectId, threadId, terminalId, cols, rows),
    write: (projectId, threadId, terminalId, data) =>
      ipcRenderer.invoke(CHANNELS.terminalsWrite, projectId, threadId, terminalId, data),
    resize: (projectId, threadId, terminalId, cols, rows) =>
      ipcRenderer.invoke(CHANNELS.terminalsResize, projectId, threadId, terminalId, cols, rows),
    restart: (projectId, threadId, terminalId, cols, rows) =>
      ipcRenderer.invoke(CHANNELS.terminalsRestart, projectId, threadId, terminalId, cols, rows),
    onEvent(listener) {
      const handler = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalEvent) => listener(terminalEvent);
      ipcRenderer.on(CHANNELS.terminalsEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.terminalsEvent, handler);
    },
  },
  workbench: {
    get: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.workbenchGet, projectId, threadId),
    update: (state) => ipcRenderer.invoke(CHANNELS.workbenchUpdate, state),
  },
};

contextBridge.exposeInMainWorld("desktop", desktopApi);

function sessionTargetKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`;
}
