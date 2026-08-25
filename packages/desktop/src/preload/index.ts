import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AuthOauthLoginEvent } from "../shared/auth-config-contracts.ts";
import type {
  BrowserAction,
  BrowserCloseTabRequest,
  BrowserCreateTabRequest,
  BrowserStateEvent,
} from "../shared/browser-contracts.ts";
import type { BrowserPasswordOffer } from "../shared/browser-data-contracts.ts";
import { CHANNELS } from "../shared/channels.ts";
import type {
  FileChangeSet,
  SessionAttachInput,
  SessionAttachment,
  SessionCreateIpcResult,
  SessionFlushResult,
  SessionPush,
  SessionPushPayload,
  TerminalEvent,
  Thread,
} from "../shared/contracts.ts";
import type { DesktopApi, DesktopPlatform, ShellRuntimeProgress } from "../shared/desktop-api.ts";
import type { SaveProvidersInput, SaveProvidersResult } from "../shared/providers-config-contracts.ts";
import type { UpdaterState } from "../shared/updater-contracts.ts";

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
    loginOauth: (input) => ipcRenderer.invoke(CHANNELS.authOauthLogin, input),
    respondToOauth: (response) => ipcRenderer.invoke(CHANNELS.authOauthRespond, response),
    cancelOauth: (loginId) => ipcRenderer.invoke(CHANNELS.authOauthCancel, loginId),
    onOauthEvent(listener) {
      const handler = (_event: Electron.IpcRendererEvent, oauthEvent: AuthOauthLoginEvent) => listener(oauthEvent);
      ipcRenderer.on(CHANNELS.authOauthEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.authOauthEvent, handler);
    },
  },
  providers: {
    getConfig: () => ipcRenderer.invoke(CHANNELS.providersGetConfig),
    saveConfig: (input: SaveProvidersInput) =>
      ipcRenderer.invoke(CHANNELS.providersSaveConfig, input) as Promise<SaveProvidersResult>,
    openConfigExternally: () => ipcRenderer.invoke(CHANNELS.providersOpenConfigExternally),
    setEditorDirty: (dirty) => ipcRenderer.sendSync(CHANNELS.providersSetEditorDirty, dirty) === true,
  },
  settings: {
    getConfig: () => ipcRenderer.invoke(CHANNELS.settingsGetConfig),
    saveConfig: (input) => ipcRenderer.invoke(CHANNELS.settingsSaveConfig, input),
    chooseUserAvatar: () => ipcRenderer.invoke(CHANNELS.settingsChooseUserAvatar),
  },
  preferences: {
    getInitial: () => ipcRenderer.sendSync(CHANNELS.preferencesGetInitial),
    save: (input) => ipcRenderer.invoke(CHANNELS.preferencesSave, input),
  },
  memorySettings: {
    getSnapshot: () => ipcRenderer.invoke(CHANNELS.memorySettingsGetSnapshot),
    saveConfig: (input) => ipcRenderer.invoke(CHANNELS.memorySettingsSaveConfig, input),
    mutateEntry: (input) => ipcRenderer.invoke(CHANNELS.memorySettingsMutateEntry, input),
    runMaintenance: (input) => ipcRenderer.invoke(CHANNELS.memorySettingsRunMaintenance, input),
    setEditorDirty: (dirty) => ipcRenderer.sendSync(CHANNELS.memorySettingsSetEditorDirty, dirty) === true,
  },
  autoTitle: {
    getSnapshot: () => ipcRenderer.invoke(CHANNELS.autoTitleGetSnapshot),
    saveConfig: (input) => ipcRenderer.invoke(CHANNELS.autoTitleSaveConfig, input),
    getModelOptions: () => ipcRenderer.invoke(CHANNELS.autoTitleGetModelOptions),
    setEditorDirty: (dirty) => ipcRenderer.sendSync(CHANNELS.autoTitleSetEditorDirty, dirty) === true,
  },
  extensions: {
    getConfig: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.extensionsGetConfig, projectId, threadId),
    saveConfig: (input) => ipcRenderer.invoke(CHANNELS.extensionsSaveConfig, input),
    chooseDevelopmentEntry: (input) => ipcRenderer.invoke(CHANNELS.extensionsChooseDevelopmentEntry, input),
    apply: (input) => ipcRenderer.invoke(CHANNELS.extensionsApply, input),
    getSessionPlugins: (projectId, threadId) =>
      ipcRenderer.invoke(CHANNELS.extensionsGetSessionPlugins, projectId, threadId),
    applySessionPlugins: (input) => ipcRenderer.invoke(CHANNELS.extensionsApplySessionPlugins, input),
    getPluginConfiguration: (pluginId) => ipcRenderer.invoke(CHANNELS.extensionsGetPluginConfiguration, pluginId),
    savePluginConfiguration: (input) => ipcRenderer.invoke(CHANNELS.extensionsSavePluginConfiguration, input),
  },
  marketplace: {
    getEndpointSettings: () => ipcRenderer.invoke(CHANNELS.marketplaceGetEndpointSettings),
    testEndpoint: (input) => ipcRenderer.invoke(CHANNELS.marketplaceTestEndpoint, input),
    saveEndpoint: (input) => ipcRenderer.invoke(CHANNELS.marketplaceSaveEndpoint, input),
    listPlugins: (input = {}) => ipcRenderer.invoke(CHANNELS.marketplaceListPlugins, input),
    getPlugin: (pluginId) => ipcRenderer.invoke(CHANNELS.marketplaceGetPlugin, pluginId),
    getInstalled: () => ipcRenderer.invoke(CHANNELS.marketplaceGetInstalled),
    getPluginConfiguration: (pluginId) => ipcRenderer.invoke(CHANNELS.marketplaceGetPluginConfiguration, pluginId),
    savePluginConfiguration: (input) => ipcRenderer.invoke(CHANNELS.marketplaceSavePluginConfiguration, input),
    installPlugin: (input) => ipcRenderer.invoke(CHANNELS.marketplaceInstallPlugin, input),
    updatePlugin: (input) => ipcRenderer.invoke(CHANNELS.marketplaceUpdatePlugin, input),
    uninstallPlugin: (input) => ipcRenderer.invoke(CHANNELS.marketplaceUninstallPlugin, input),
    setPluginEnabled: (input) => ipcRenderer.invoke(CHANNELS.marketplaceSetPluginEnabled, input),
    setPluginScope: (input) => ipcRenderer.invoke(CHANNELS.marketplaceSetPluginScope, input),
  },
  subagents: {
    getSnapshot: (input) => ipcRenderer.invoke(CHANNELS.subagentsGetSnapshot, input),
    saveConfig: (input) => ipcRenderer.invoke(CHANNELS.subagentsSaveConfig, input),
  },
  updater: {
    getState: () => ipcRenderer.invoke(CHANNELS.updaterGetState),
    check: () => ipcRenderer.invoke(CHANNELS.updaterCheck),
    download: () => ipcRenderer.invoke(CHANNELS.updaterDownload),
    install: () => ipcRenderer.invoke(CHANNELS.updaterInstall),
    onStateChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, state: UpdaterState) => listener(state);
      ipcRenderer.on(CHANNELS.updaterStateChanged, handler);
      return () => ipcRenderer.removeListener(CHANNELS.updaterStateChanged, handler);
    },
  },
  shellRuntime: {
    getStatus: () => ipcRenderer.invoke(CHANNELS.shellRuntimeStatus),
    install: () => ipcRenderer.invoke(CHANNELS.shellRuntimeInstall),
    choose: () => ipcRenderer.invoke(CHANNELS.shellRuntimeChoose),
    onProgress(listener) {
      const handler = (_event: Electron.IpcRendererEvent, progress: ShellRuntimeProgress) => listener(progress);
      ipcRenderer.on(CHANNELS.shellRuntimeProgress, handler);
      return () => ipcRenderer.removeListener(CHANNELS.shellRuntimeProgress, handler);
    },
  },
  runtime: {
    restart: () => ipcRenderer.send(CHANNELS.runtimeRestart),
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
    rename: (projectId, name) => ipcRenderer.invoke(CHANNELS.projectsRename, projectId, name),
    openExternally: (projectId) => ipcRenderer.invoke(CHANNELS.projectsOpenExternally, projectId),
    remove: (projectId) => ipcRenderer.invoke(CHANNELS.projectsRemove, projectId),
    getActive: () => ipcRenderer.invoke(CHANNELS.projectsActive),
  },
  sessions: {
    list: (projectId, includeArchived) => ipcRenderer.invoke(CHANNELS.sessionsList, projectId, includeArchived),
    listWithPaths: (projectId) => ipcRenderer.invoke(CHANNELS.sessionsListWithPaths, projectId),
    onCatalogChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, thread: Thread) => listener(thread);
      ipcRenderer.on(CHANNELS.sessionsCatalogChanged, handler);
      return () => ipcRenderer.removeListener(CHANNELS.sessionsCatalogChanged, handler);
    },
    getDraftConfig: (projectId) => ipcRenderer.invoke(CHANNELS.sessionsDraftConfig, projectId),
    create: async (input) => {
      const result = (await ipcRenderer.invoke(CHANNELS.sessionsCreate, input)) as SessionCreateIpcResult;
      if (result.ok) return result.bootstrap;
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code,
        details: result.error.details,
      });
    },
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
    close: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsClose, projectId, threadId),
    prewarm: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsPrewarm, projectId, threadId),
    rename: (projectId, threadId, title) => ipcRenderer.invoke(CHANNELS.sessionsRename, projectId, threadId, title),
    archive: (projectId, threadId, archived) =>
      ipcRenderer.invoke(CHANNELS.sessionsArchive, projectId, threadId, archived),
    remove: (projectId, threadId, policy) => ipcRenderer.invoke(CHANNELS.sessionsRemove, projectId, threadId, policy),
    promote: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsPromote, projectId, threadId),
    prompt: (input) => ipcRenderer.invoke(CHANNELS.sessionsPrompt, input),
    edit: (input) => ipcRenderer.invoke(CHANNELS.sessionsEdit, input),
    reload: (input) => ipcRenderer.invoke(CHANNELS.sessionsReload, input),
    reloadResources: (input) => ipcRenderer.invoke(CHANNELS.sessionsReloadResources, input),
    getCheckpointDiff: (input) => ipcRenderer.invoke(CHANNELS.sessionsGetCheckpointDiff, input),
    restoreCheckpoint: (input) => ipcRenderer.invoke(CHANNELS.sessionsRestoreCheckpoint, input),
    branch: (input) => ipcRenderer.invoke(CHANNELS.sessionsBranch, input),
    cancel: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsCancel, projectId, threadId),
    clearQueue: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsClearQueue, projectId, threadId),
    compact: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsCompact, projectId, threadId),
    refreshModels: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsRefreshModels, projectId, threadId),
    setModel: (projectId, threadId, provider, modelId) =>
      ipcRenderer.invoke(CHANNELS.sessionsSetModel, projectId, threadId, provider, modelId),
    setThinking: (projectId, threadId, level) =>
      ipcRenderer.invoke(CHANNELS.sessionsSetThinking, projectId, threadId, level),
    respond: (projectId, threadId, response) =>
      ipcRenderer.invoke(CHANNELS.sessionsRespond, projectId, threadId, response),
  },
  files: {
    getPath: (file) => webUtils.getPathForFile(file),
    list: (projectId, path, query, requestGroup) =>
      ipcRenderer.invoke(CHANNELS.filesList, projectId, path, query, requestGroup),
    read: (projectId, path) => ipcRenderer.invoke(CHANNELS.filesRead, projectId, path),
    readImage: (projectId, path) => ipcRenderer.invoke(CHANNELS.filesReadImage, projectId, path),
    previewOfficeDocument: (projectId, path) =>
      ipcRenderer.invoke(CHANNELS.filesPreviewOfficeDocument, projectId, path),
    cancelOfficeDocumentPreview: () => ipcRenderer.invoke(CHANNELS.filesCancelOfficeDocumentPreview),
    resolvePath: (projectId, path) => ipcRenderer.invoke(CHANNELS.filesResolvePath, projectId, path),
    open: (projectId, path) => ipcRenderer.invoke(CHANNELS.filesOpen, projectId, path),
    watch: (projectId) => ipcRenderer.invoke(CHANNELS.filesWatch, projectId),
    unwatch: (projectId) => ipcRenderer.invoke(CHANNELS.filesUnwatch, projectId),
    onChanged(projectId, listener) {
      const handler = (_event: Electron.IpcRendererEvent, change: FileChangeSet) => {
        if (change.projectId === projectId) listener(change);
      };
      ipcRenderer.on(CHANNELS.filesChanged, handler);
      return () => ipcRenderer.removeListener(CHANNELS.filesChanged, handler);
    },
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
    dispose: (projectId, threadId, terminalId) =>
      ipcRenderer.invoke(CHANNELS.terminalsDispose, projectId, threadId, terminalId),
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
  browser: {
    /** renderer 在 webview attach 后报告 guest webContentsId + 会话身份；返回分配的 tab。requestId 用于响应 main 的建 tab 请求。 */
    attach: (identity, webContentsId, requestId) =>
      ipcRenderer.invoke(CHANNELS.browserAttach, identity, webContentsId, requestId),
    /** renderer 移除 webview 时注销；幂等。 */
    detach: (identity, webContentsId) => ipcRenderer.invoke(CHANNELS.browserDetach, identity, webContentsId),
    /** 切换会话内活跃 tab（CDP attach 只跟随该会话活跃 tab）。 */
    selectTab: (identity, tabId) => ipcRenderer.invoke(CHANNELS.browserTabSelect, identity, tabId),
    /** 导航到 URL（http/https；file:// 拒绝）。 */
    navigate: (identity, tabId, url) => ipcRenderer.invoke(CHANNELS.browserNavigate, identity, tabId, url),
    /** 截取当前页面 PNG。 */
    screenshot: (identity, tabId) => ipcRenderer.invoke(CHANNELS.browserScreenshot, identity, tabId),
    /** 截取当前页面 PNG 并写入系统剪贴板。 */
    copyScreenshot: (identity, tabId) => ipcRenderer.invoke(CHANNELS.browserCopyScreenshot, identity, tabId),
    /** 结构化页面快照（AX 树简化 + 可交互元素编号 + 可选截图）。 */
    snapshot: (identity, tabId, opts) => ipcRenderer.invoke(CHANNELS.browserSnapshot, identity, tabId, opts),
    /** 元素级交互（click/type/scroll，编号来自 snapshot）。 */
    action: (identity, tabId, action: BrowserAction) =>
      ipcRenderer.invoke(CHANNELS.browserAction, identity, tabId, action),
    /** 会话内全部 tab（含活跃标识由调用方按状态事件维护）。 */
    tabsList: (identity) => ipcRenderer.invoke(CHANNELS.browserTabsList, identity),
    getSettings: () => ipcRenderer.invoke(CHANNELS.browserSettingsGet),
    saveSettings: (input) => ipcRenderer.invoke(CHANNELS.browserSettingsSave, input),
    /** 设置页未保存修改标记（窗口关闭守卫）。 */
    setEditorDirty: (dirty) => ipcRenderer.sendSync(CHANNELS.browserSetEditorDirty, dirty) === true,
    /** 会话退役：清理该会话的 webview/guest/映射（renderer 会话记录移除时调用）。 */
    sessionRetire: (identity) => ipcRenderer.invoke(CHANNELS.browserSessionRetire, identity),
    sessionAcquire: (identity) => ipcRenderer.invoke(CHANNELS.browserSessionAcquire, identity),
    /** 清除指定会话分区数据（cookie/缓存/登录态）。 */
    clearData: (identity) => ipcRenderer.invoke(CHANNELS.browserClearData, identity),
    /** 清除全部会话分区数据（设置页入口）。 */
    clearAllData: () => ipcRenderer.invoke(CHANNELS.browserClearAllData),
    /** 会话内访问历史（最近在前，仅用户 UI；Agent 不可见）。 */
    browserHistory: (identity) => ipcRenderer.invoke(CHANNELS.browserHistory, identity),
    /** 在系统文件管理器中打开下载目录。 */
    openDownloads: () => ipcRenderer.invoke(CHANNELS.browserOpenDownloads),
    /** 取视口坐标处元素（标注模式）：生成选择器与 bounds。 */
    annotationPick: (identity, tabId, x, y) =>
      ipcRenderer.invoke(CHANNELS.browserAnnotationPick, identity, tabId, x, y),
    /** 添加标注；返回完整标注对象（null = tab 不存在）。 */
    annotationAdd: (identity, tabId, input) =>
      ipcRenderer.invoke(CHANNELS.browserAnnotationAdd, identity, tabId, input),
    /** 指定 tab 的标注列表（最近在前）。 */
    annotationList: (identity, tabId) => ipcRenderer.invoke(CHANNELS.browserAnnotationList, identity, tabId),
    /** 删除标注。 */
    annotationRemove: (identity, tabId, id) =>
      ipcRenderer.invoke(CHANNELS.browserAnnotationRemove, identity, tabId, id),
    /** 按 id 批量删除标注（composer 成功发送后消费；id 会话内全局唯一）。 */
    annotationRemoveMany: (identity, ids) => ipcRenderer.invoke(CHANNELS.browserAnnotationRemoveMany, identity, ids),
    /** 原位更新标注文本（保持 id/selector/bounds 不变）。 */
    annotationUpdate: (identity, tabId, id, input) =>
      ipcRenderer.invoke(CHANNELS.browserAnnotationUpdate, identity, tabId, id, input),
    /** 按选择器重新解析标注 bounds；元素消失返回 null。 */
    annotationResolve: (identity, tabId, id) =>
      ipcRenderer.invoke(CHANNELS.browserAnnotationResolve, identity, tabId, id),
    /** 浏览器用户数据快照（历史/下载/联系人/密码/网站设置；仅用户 UI）。 */
    browserDataGet: (includePasswords) => ipcRenderer.invoke(CHANNELS.browserDataGet, includePasswords),
    /** 删除单条历史记录（按 url + timestamp 精确匹配）。 */
    browserHistoryDelete: (url, timestamp) => ipcRenderer.invoke(CHANNELS.browserHistoryDelete, url, timestamp),
    /** 清空全部浏览历史。 */
    browserHistoryClear: () => ipcRenderer.invoke(CHANNELS.browserHistoryClear),
    /** 清空全部下载历史（不删除已下载文件）。 */
    browserDownloadsClear: () => ipcRenderer.invoke(CHANNELS.browserDownloadsClear),
    /** 在系统文件管理器中显示已下载文件。 */
    browserDownloadReveal: (path) => ipcRenderer.invoke(CHANNELS.browserDownloadReveal, path),
    /** 用系统默认程序打开已下载文件。 */
    browserDownloadOpen: (path) => ipcRenderer.invoke(CHANNELS.browserDownloadOpen, path),
    /** 新增/更新联系信息（contactId 为 null 时新建）。 */
    browserContactSave: (input) => ipcRenderer.invoke(CHANNELS.browserContactSave, input),
    /** 删除联系信息。 */
    browserContactDelete: (id) => ipcRenderer.invoke(CHANNELS.browserContactDelete, id),
    /** 新增/更新保存的密码（passwordId 为 null 时新建）。 */
    browserPasswordSave: (input) => ipcRenderer.invoke(CHANNELS.browserPasswordSave, input),
    /** 删除保存的密码。 */
    browserPasswordDelete: (id) => ipcRenderer.invoke(CHANNELS.browserPasswordDelete, id),
    /** 新增/更新网站设置条目（同 site+kind 覆盖）。 */
    browserSitePermissionSave: (input) => ipcRenderer.invoke(CHANNELS.browserSitePermissionSave, input),
    /** 删除网站设置条目。 */
    browserSitePermissionDelete: (id) => ipcRenderer.invoke(CHANNELS.browserSitePermissionDelete, id),
    /** 主进程请求保存密码（登录表单提交后）；返回取消订阅函数。 */
    onPasswordOffer(listener) {
      const handler = (_event: Electron.IpcRendererEvent, offer: BrowserPasswordOffer) => listener(offer);
      ipcRenderer.on(CHANNELS.browserPasswordOffer, handler);
      return () => ipcRenderer.removeListener(CHANNELS.browserPasswordOffer, handler);
    },
    /** 用户对密码保存请求的响应（保存 / 忽略）。 */
    browserPasswordOfferResolve: (identity, offerId, save) =>
      ipcRenderer.invoke(CHANNELS.browserPasswordOfferResolve, identity, offerId, save),
    /** 订阅浏览器会话状态（携带 sessionKey，按身份路由）；返回取消订阅函数。 */
    onStateChanged(listener) {
      const handler = (_event: Electron.IpcRendererEvent, stateEvent: BrowserStateEvent) => listener(stateEvent);
      ipcRenderer.on(CHANNELS.browserStateChanged, handler);
      return () => ipcRenderer.removeListener(CHANNELS.browserStateChanged, handler);
    },
    /** main 请求创建新 tab（携带 sessionKey）；返回取消订阅函数。 */
    onCreateTabRequest(listener) {
      const handler = (_event: Electron.IpcRendererEvent, request: BrowserCreateTabRequest) => listener(request);
      ipcRenderer.on(CHANNELS.browserCreateTabRequest, handler);
      return () => ipcRenderer.removeListener(CHANNELS.browserCreateTabRequest, handler);
    },
    /** main 请求关闭指定 tab（工具 browser.close 触发；携带 sessionKey + tabId）。 */
    onCloseTabRequest(listener) {
      const handler = (_event: Electron.IpcRendererEvent, request: BrowserCloseTabRequest) => listener(request);
      ipcRenderer.on(CHANNELS.browserCloseTabRequest, handler);
      return () => ipcRenderer.removeListener(CHANNELS.browserCloseTabRequest, handler);
    },
  },
};

contextBridge.exposeInMainWorld("desktop", desktopApi);
