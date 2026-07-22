import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../shared/channels.ts";
import type {
  SessionAttachInput,
  SessionAttachment,
  SessionFlushResult,
  SessionPush,
  SessionPushPayload,
  TerminalEvent,
} from "../shared/contracts.ts";
import type { DesktopApi, DesktopPlatform, NodeRuntimeProgress } from "../shared/desktop-api.ts";

interface ActiveSessionAttachment {
  attachmentId: string;
  identity: { projectId: string; threadId: string };
  listener(update: SessionPushPayload): void;
  buffered: SessionPush[];
  bufferedBytes: number;
  ready: boolean;
  overflowed: boolean;
}

interface UnclaimedSessionPushes {
  buffered: SessionPush[];
  bufferedBytes: number;
  overflowed: boolean;
  expiry: ReturnType<typeof setTimeout>;
}

const MAX_BUFFERED_SESSION_PUSHES = 128;
const MAX_BUFFERED_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_UNCLAIMED_ATTACHMENTS = 64;
const UNCLAIMED_ATTACHMENT_TTL_MS = 30_000;
const DETACHED_ATTACHMENT_TTL_MS = 30_000;
const attachments = new Map<string, ActiveSessionAttachment>();
const unclaimedPushes = new Map<string, UnclaimedSessionPushes>();
const detachedAttachments = new Map<string, ReturnType<typeof setTimeout>>();

ipcRenderer.on(CHANNELS.sessionsPush, (_event, update: SessionPush) => {
  const attachment = attachments.get(update.attachmentId);
  if (!attachment) {
    if (detachedAttachments.has(update.attachmentId)) {
      acknowledgeSessionUpdate(update);
      return;
    }
    bufferUnclaimedSessionUpdate(update);
    return;
  }
  if (!attachment.ready) {
    bufferSessionUpdate(attachment, update);
    return;
  }
  deliverSessionUpdate(attachment, update);
});

function bufferUnclaimedSessionUpdate(update: SessionPush): void {
  let pending = unclaimedPushes.get(update.attachmentId);
  if (!pending) {
    if (unclaimedPushes.size >= MAX_UNCLAIMED_ATTACHMENTS) {
      acknowledgeSessionUpdate(update);
      return;
    }
    const attachmentId = update.attachmentId;
    pending = {
      buffered: [],
      bufferedBytes: 0,
      overflowed: false,
      expiry: setTimeout(() => unclaimedPushes.delete(attachmentId), UNCLAIMED_ATTACHMENT_TTL_MS),
    };
    unclaimedPushes.set(attachmentId, pending);
  }
  if (pending.overflowed) return;
  const bytes = estimateSessionUpdateBytes(update);
  if (
    pending.buffered.length >= MAX_BUFFERED_SESSION_PUSHES ||
    pending.bufferedBytes + bytes > MAX_BUFFERED_SESSION_BYTES
  ) {
    pending.buffered = [];
    pending.bufferedBytes = 0;
    pending.overflowed = true;
    return;
  }
  pending.buffered.push(update);
  pending.bufferedBytes += bytes;
}

function deleteUnclaimedPushes(attachmentId: string): UnclaimedSessionPushes | undefined {
  const pending = unclaimedPushes.get(attachmentId);
  if (!pending) return undefined;
  clearTimeout(pending.expiry);
  unclaimedPushes.delete(attachmentId);
  return pending;
}

function tombstoneAttachment(attachmentId: string): void {
  attachments.delete(attachmentId);
  deleteUnclaimedPushes(attachmentId);
  const current = detachedAttachments.get(attachmentId);
  if (current) clearTimeout(current);
  const expiry = setTimeout(() => detachedAttachments.delete(attachmentId), DETACHED_ATTACHMENT_TTL_MS);
  detachedAttachments.set(attachmentId, expiry);
}

function bufferSessionUpdate(attachment: ActiveSessionAttachment, update: SessionPush): void {
  if (attachment.overflowed) return;
  const bytes = estimateSessionUpdateBytes(update);
  if (
    attachment.buffered.length >= MAX_BUFFERED_SESSION_PUSHES ||
    attachment.bufferedBytes + bytes > MAX_BUFFERED_SESSION_BYTES
  ) {
    attachment.buffered = [];
    attachment.bufferedBytes = 0;
    attachment.overflowed = true;
    return;
  }
  attachment.buffered.push(update);
  attachment.bufferedBytes += bytes;
}

function deliverSessionUpdate(attachment: ActiveSessionAttachment, update: SessionPush): void {
  if (update.projectId !== attachment.identity.projectId || update.threadId !== attachment.identity.threadId) {
    acknowledgeSessionUpdate(update);
    return;
  }
  const { attachmentId: _attachmentId, ...payload } = update;
  try {
    attachment.listener(payload);
  } finally {
    acknowledgeSessionUpdate(update);
  }
}

function acknowledgeSessionUpdate(update: SessionPush): void {
  ipcRenderer.send(CHANNELS.sessionsAck, update.attachmentId, update.workerInstanceId, update.sidecarSequence);
}

function estimateSessionUpdateBytes(update: SessionPush): number {
  return JSON.stringify(update).length * 2;
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
    open: (projectId, url) => ipcRenderer.invoke(CHANNELS.linksOpen, projectId, url),
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
  settings: {
    getConfig: () => ipcRenderer.invoke(CHANNELS.settingsGetConfig),
    saveConfig: (input) => ipcRenderer.invoke(CHANNELS.settingsSaveConfig, input),
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
    async attach(input: SessionAttachInput, listener): Promise<SessionAttachment> {
      const attachment = (await ipcRenderer.invoke(CHANNELS.sessionsAttach, input)) as SessionAttachment;
      const active: ActiveSessionAttachment = {
        attachmentId: attachment.attachmentId,
        identity: { projectId: input.projectId, threadId: input.threadId },
        listener,
        buffered: [],
        bufferedBytes: 0,
        ready: false,
        overflowed: false,
      };
      if (input.replaceAttachmentId) tombstoneAttachment(input.replaceAttachmentId);
      const detachedExpiry = detachedAttachments.get(attachment.attachmentId);
      if (detachedExpiry) clearTimeout(detachedExpiry);
      detachedAttachments.delete(attachment.attachmentId);
      attachments.set(attachment.attachmentId, active);
      const unclaimed = deleteUnclaimedPushes(attachment.attachmentId);
      active.overflowed = unclaimed?.overflowed ?? false;
      for (const update of unclaimed?.buffered ?? []) bufferSessionUpdate(active, update);
      return attachment;
    },
    flush(attachmentId: string): SessionFlushResult {
      const attachment = attachments.get(attachmentId);
      if (!attachment) return { state: "flushed" };
      if (attachment.overflowed) return { state: "recovering", reason: "preload-buffer-overflow" };
      if (attachment.ready) return { state: "flushed" };
      attachment.ready = true;
      const buffered = attachment.buffered;
      attachment.buffered = [];
      attachment.bufferedBytes = 0;
      for (const update of buffered) deliverSessionUpdate(attachment, update);
      return { state: "flushed" };
    },
    detach(attachmentId: string) {
      tombstoneAttachment(attachmentId);
      ipcRenderer.send(CHANNELS.sessionsDetach, attachmentId);
    },
    prewarm: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsPrewarm, projectId, threadId),
    rename: (projectId, threadId, title) => ipcRenderer.invoke(CHANNELS.sessionsRename, projectId, threadId, title),
    archive: (projectId, threadId, archived) =>
      ipcRenderer.invoke(CHANNELS.sessionsArchive, projectId, threadId, archived),
    remove: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsRemove, projectId, threadId),
    prompt: (input) => ipcRenderer.invoke(CHANNELS.sessionsPrompt, input),
    edit: (input) => ipcRenderer.invoke(CHANNELS.sessionsEdit, input),
    reload: (input) => ipcRenderer.invoke(CHANNELS.sessionsReload, input),
    branch: (input) => ipcRenderer.invoke(CHANNELS.sessionsBranch, input),
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
    resolvePath: (projectId, path) => ipcRenderer.invoke(CHANNELS.filesResolvePath, projectId, path),
    open: (projectId, path) => ipcRenderer.invoke(CHANNELS.filesOpen, projectId, path),
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
