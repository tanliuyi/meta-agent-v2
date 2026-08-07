import type {
  AuthConfigSnapshot,
  AuthOauthLoginEvent,
  AuthOauthLoginInput,
  AuthOauthLoginResponse,
  SaveAuthConfigInput,
  SaveAuthConfigResult,
} from "./auth-config-contracts.ts";
import type {
  AutoTitleModelOption,
  AutoTitleSettingsSnapshot,
  SaveAutoTitleSettingsInput,
  SaveAutoTitleSettingsResult,
} from "./auto-title-contracts.ts";
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserAnnotation,
  BrowserAnnotationBounds,
  BrowserAnnotationInput,
  BrowserAnnotationPickResult,
  BrowserAttachResult,
  BrowserClipboardResult,
  BrowserCreateTabRequest,
  BrowserHistoryEntry,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserSessionIdentity,
  BrowserSnapshotResult,
  BrowserStateEvent,
  BrowserTab,
} from "./browser-contracts.ts";
import type {
  BrowserSettingsSnapshot,
  SaveBrowserSettingsInput,
  SaveBrowserSettingsResult,
} from "./browser-settings-contracts.ts";
import type {
  ClearedQueue,
  DraftSessionConfig,
  FileChangeSet,
  FileImage,
  FileNode,
  HostResponse,
  OpenLinkResult,
  Project,
  SessionAttachInput,
  SessionAttachment,
  SessionBootstrap,
  SessionBranchInput,
  SessionBranchResult,
  SessionCommandResult,
  SessionControlState,
  SessionCreateInput,
  SessionEditInput,
  SessionFlushResult,
  SessionMentionCandidate,
  SessionPromptInput,
  SessionPushPayload,
  SessionReloadInput,
  SessionRemovePolicy,
  SessionRemoveResult,
  SessionResourceReloadInput,
  TerminalEvent,
  TerminalSnapshot,
  TextFile,
  Thread,
  WorkbenchState,
} from "./contracts.ts";
import type {
  ApplyDesktopExtensionSetInput,
  ApplyDesktopExtensionSetResult,
  ApproveDevelopmentExtensionInput,
  DesktopExtensionSettingsSnapshot,
  SaveDesktopExtensionSettingsInput,
  SaveDesktopExtensionSettingsResult,
} from "./desktop-extension-contracts.ts";
import type {
  MemoryMaintenanceResult,
  MemoryMutationResult,
  MemorySettingsSnapshot,
  MutateMemoryEntryInput,
  RunMemoryMaintenanceInput,
  SaveMemorySettingsInput,
  SaveMemorySettingsResult,
} from "./memory-settings-contracts.ts";
import type { ModelsConfigSnapshot, SaveModelsConfigInput, SaveModelsConfigResult } from "./models-config-contracts.ts";
import type {
  SessionCheckpointDiffInput,
  SessionCheckpointDiffResult,
  SessionCheckpointRestoreInput,
  SessionCheckpointRestoreResult,
} from "./pi-rewind-contracts.ts";
import type {
  PluginConfigurationSnapshot,
  SavePluginConfigurationInput,
  SavePluginConfigurationResult,
} from "./plugin-configuration-contracts.ts";
import type {
  InstalledMarketplacePluginsSnapshot,
  InstallMarketplacePluginInput,
  InstallMarketplacePluginResult,
  ListMarketplacePluginsInput,
  MarketplaceEndpointSettingsSnapshot,
  MarketplacePluginPage,
  MarketplacePluginSummary,
  SaveMarketplaceEndpointInput,
  SaveMarketplaceEndpointResult,
  SetMarketplacePluginScopeInput,
  SetMarketplacePluginScopeResult,
  TestMarketplaceEndpointInput,
  TestMarketplaceEndpointResult,
  UninstallMarketplacePluginInput,
  UninstallMarketplacePluginResult,
  UpdateMarketplacePluginInput,
  UpdateMarketplacePluginResult,
} from "./plugin-marketplace-contracts.ts";
import type { PreferencesSnapshot, SavePreferencesInput, SavePreferencesResult } from "./preferences-contracts.ts";
import type { ProvidersSnapshot, SaveProvidersInput, SaveProvidersResult } from "./providers-config-contracts.ts";
import type {
  SaveSettingsConfigInput,
  SaveSettingsConfigResult,
  SettingsConfigSnapshot,
} from "./settings-config-contracts.ts";
import type {
  GetSubagentSettingsInput,
  SaveSubagentSettingsInput,
  SaveSubagentSettingsResult,
  SubagentSettingsSnapshot,
} from "./subagent-contracts.ts";
import type { UpdaterApi } from "./updater-contracts.ts";

export type DesktopPlatform = "win32" | "darwin" | "linux";

export interface ShellRuntimeProgress {
  phase: "checking" | "downloading" | "verifying" | "extracting" | "ready" | "error";
  percent: number;
  message: string;
  error?: string;
}

export interface ShellRuntimeStatus {
  state: "ready" | "missing" | "invalid";
  path?: string;
  version?: string;
  message: string;
  installUrl: string;
}

/** Renderer 可以调用的最小 Desktop API。 */
export interface DesktopApi {
  platform: DesktopPlatform;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  shellRuntime: {
    getStatus(): Promise<ShellRuntimeStatus>;
    install(): Promise<ShellRuntimeStatus>;
    choose(): Promise<ShellRuntimeStatus | null>;
    onProgress(listener: (progress: ShellRuntimeProgress) => void): () => void;
  };
  runtime: {
    restart(): void;
  };
  links: {
    open(projectId: string, url: string): Promise<OpenLinkResult>;
  };
  models: {
    getConfig(): Promise<ModelsConfigSnapshot>;
    getConfigRevision(): Promise<string>;
    saveConfig(input: SaveModelsConfigInput): Promise<SaveModelsConfigResult>;
    openConfigExternally(): Promise<void>;
    setEditorDirty(dirty: boolean): boolean;
  };
  auth: {
    getConfig(): Promise<AuthConfigSnapshot>;
    getConfigRevision(): Promise<string>;
    saveConfig(input: SaveAuthConfigInput): Promise<SaveAuthConfigResult>;
    openConfigExternally(): Promise<void>;
    setEditorDirty(dirty: boolean): boolean;
    loginOauth(input: AuthOauthLoginInput): Promise<AuthConfigSnapshot>;
    respondToOauth(response: AuthOauthLoginResponse): Promise<void>;
    cancelOauth(loginId: string): Promise<void>;
    onOauthEvent(listener: (event: AuthOauthLoginEvent) => void): () => void;
  };
  providers: {
    getConfig(): Promise<ProvidersSnapshot>;
    saveConfig(input: SaveProvidersInput): Promise<SaveProvidersResult>;
    openConfigExternally(): Promise<void>;
    setEditorDirty(dirty: boolean): boolean;
  };
  settings: {
    getConfig(): Promise<SettingsConfigSnapshot>;
    saveConfig(input: SaveSettingsConfigInput): Promise<SaveSettingsConfigResult>;
    chooseUserAvatar(): Promise<string | null>;
  };
  preferences: {
    /** 首帧初始化所需的同步快照（preload sendSync），任何失败都回退为空 values。 */
    getInitial(): PreferencesSnapshot;
    save(input: SavePreferencesInput): Promise<SavePreferencesResult>;
  };
  memorySettings: {
    getSnapshot(): Promise<MemorySettingsSnapshot>;
    saveConfig(input: SaveMemorySettingsInput): Promise<SaveMemorySettingsResult>;
    mutateEntry(input: MutateMemoryEntryInput): Promise<MemoryMutationResult>;
    runMaintenance(input: RunMemoryMaintenanceInput): Promise<MemoryMaintenanceResult>;
    setEditorDirty(dirty: boolean): boolean;
  };
  autoTitle: {
    getSnapshot(): Promise<AutoTitleSettingsSnapshot>;
    saveConfig(input: SaveAutoTitleSettingsInput): Promise<SaveAutoTitleSettingsResult>;
    getModelOptions(): Promise<AutoTitleModelOption[]>;
    setEditorDirty(dirty: boolean): boolean;
  };
  extensions: {
    getConfig(projectId?: string, threadId?: string): Promise<DesktopExtensionSettingsSnapshot>;
    saveConfig(input: SaveDesktopExtensionSettingsInput): Promise<SaveDesktopExtensionSettingsResult>;
    chooseDevelopmentEntry(input: ApproveDevelopmentExtensionInput): Promise<SaveDesktopExtensionSettingsResult>;
    apply(input: ApplyDesktopExtensionSetInput): Promise<ApplyDesktopExtensionSetResult>;
    getPluginConfiguration(pluginId: string): Promise<PluginConfigurationSnapshot>;
    savePluginConfiguration(input: SavePluginConfigurationInput): Promise<SavePluginConfigurationResult>;
  };
  marketplace: {
    getEndpointSettings(): Promise<MarketplaceEndpointSettingsSnapshot>;
    testEndpoint(input: TestMarketplaceEndpointInput): Promise<TestMarketplaceEndpointResult>;
    saveEndpoint(input: SaveMarketplaceEndpointInput): Promise<SaveMarketplaceEndpointResult>;
    listPlugins(input?: ListMarketplacePluginsInput): Promise<MarketplacePluginPage>;
    /** 按 pluginId 直达详情；市场目录中不存在时返回 null。 */
    getPlugin(pluginId: string): Promise<MarketplacePluginSummary | null>;
    getInstalled(): Promise<InstalledMarketplacePluginsSnapshot>;
    getPluginConfiguration(pluginId: string): Promise<PluginConfigurationSnapshot>;
    savePluginConfiguration(input: SavePluginConfigurationInput): Promise<SavePluginConfigurationResult>;
    installPlugin(input: InstallMarketplacePluginInput): Promise<InstallMarketplacePluginResult>;
    updatePlugin(input: UpdateMarketplacePluginInput): Promise<UpdateMarketplacePluginResult>;
    uninstallPlugin(input: UninstallMarketplacePluginInput): Promise<UninstallMarketplacePluginResult>;
    setPluginScope(input: SetMarketplacePluginScopeInput): Promise<SetMarketplacePluginScopeResult>;
  };
  subagents: {
    getSnapshot(input?: GetSubagentSettingsInput): Promise<SubagentSettingsSnapshot>;
    saveConfig(input: SaveSubagentSettingsInput): Promise<SaveSubagentSettingsResult>;
  };
  updater: UpdaterApi;
  windowControls: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    onMaximizedChanged(listener: (maximized: boolean) => void): () => void;
  };
  projects: {
    list(): Promise<Project[]>;
    choose(): Promise<Project | null>;
    open(projectId: string): Promise<Project>;
    rename(projectId: string, name: string): Promise<Project>;
    openExternally(projectId: string): Promise<void>;
    remove(projectId: string): Promise<void>;
    getActive(): Promise<Project | null>;
  };
  sessions: {
    list(projectId: string, includeArchived?: boolean): Promise<Thread[]>;
    /** 保留 session.jsonl 绝对路径的会话列表（@ 提及会话引用用）。 */
    listWithPaths(projectId: string): Promise<SessionMentionCandidate[]>;
    onCatalogChanged(listener: (thread: Thread) => void): () => void;
    getDraftConfig(projectId: string): Promise<DraftSessionConfig>;
    create(input: SessionCreateInput): Promise<SessionBootstrap>;
    attach(input: SessionAttachInput, listener: (update: SessionPushPayload) => void): Promise<SessionAttachment>;
    flush(attachmentId: string): SessionFlushResult;
    detach(attachmentId: string): void;
    prewarm(projectId: string, threadId: string): Promise<void>;
    rename(projectId: string, threadId: string, title: string): Promise<void>;
    archive(projectId: string, threadId: string, archived: boolean): Promise<void>;
    remove(projectId: string, threadId: string, policy: SessionRemovePolicy): Promise<SessionRemoveResult>;
    promote(projectId: string, threadId: string): Promise<SessionRemoveResult>;
    prompt(input: SessionPromptInput): Promise<SessionCommandResult>;
    edit(input: SessionEditInput): Promise<SessionCommandResult>;
    reload(input: SessionReloadInput): Promise<SessionCommandResult>;
    reloadResources(input: SessionResourceReloadInput): Promise<SessionCommandResult>;
    getCheckpointDiff(input: SessionCheckpointDiffInput): Promise<SessionCheckpointDiffResult>;
    restoreCheckpoint(input: SessionCheckpointRestoreInput): Promise<SessionCheckpointRestoreResult>;
    branch(input: SessionBranchInput): Promise<SessionBranchResult>;
    cancel(projectId: string, threadId: string): Promise<ClearedQueue>;
    clearQueue(projectId: string, threadId: string): Promise<ClearedQueue>;
    compact(projectId: string, threadId: string): Promise<void>;
    refreshModels(projectId: string, threadId: string): Promise<void>;
    setModel(projectId: string, threadId: string, provider: string, modelId: string): Promise<void>;
    setThinking(projectId: string, threadId: string, level: SessionControlState["thinkingLevel"]): Promise<void>;
    respond(projectId: string, threadId: string, response: HostResponse): Promise<void>;
  };
  files: {
    list(projectId: string, path?: string, query?: string, requestGroup?: string): Promise<FileNode[]>;
    read(projectId: string, path: string): Promise<TextFile>;
    readImage(projectId: string, path: string): Promise<FileImage>;
    resolvePath(projectId: string, path: string): Promise<string>;
    open(projectId: string, path: string): Promise<void>;
    watch(projectId: string): Promise<void>;
    unwatch(projectId: string): Promise<void>;
    /** 订阅 Project 文件变化；返回取消订阅函数。 */
    onChanged(projectId: string, listener: (change: FileChangeSet) => void): () => void;
  };
  terminals: {
    open(
      projectId: string,
      threadId: string,
      terminalId: string,
      cols: number,
      rows: number,
    ): Promise<TerminalSnapshot>;
    write(projectId: string, threadId: string, terminalId: string, data: string): Promise<void>;
    resize(projectId: string, threadId: string, terminalId: string, cols: number, rows: number): Promise<void>;
    restart(
      projectId: string,
      threadId: string,
      terminalId: string,
      cols: number,
      rows: number,
    ): Promise<TerminalSnapshot>;
    dispose(projectId: string, threadId: string, terminalId: string): Promise<void>;
    onEvent(listener: (event: TerminalEvent) => void): () => void;
  };
  workbench: {
    get(projectId: string, threadId: string): Promise<WorkbenchState>;
    update(state: WorkbenchState): Promise<void>;
  };
  browser: {
    /** renderer 在 webview attach 后报告 guest webContentsId + 会话身份；返回分配的 tab。requestId 用于响应 main 的建 tab 请求。 */
    attach(identity: BrowserSessionIdentity, webContentsId: number, requestId?: number): Promise<BrowserAttachResult>;
    /** renderer 移除 webview 时注销；幂等。 */
    detach(identity: BrowserSessionIdentity, webContentsId: number): Promise<void>;
    /** 切换会话内活跃 tab（CDP attach 只跟随该会话活跃 tab）。 */
    selectTab(identity: BrowserSessionIdentity, tabId: number): Promise<BrowserTab | null>;
    /** 导航到 URL（http/https；file:// 拒绝）。 */
    navigate(identity: BrowserSessionIdentity, tabId: number, url: string): Promise<BrowserNavigateResult>;
    /** 截取当前页面 PNG。 */
    screenshot(identity: BrowserSessionIdentity, tabId: number): Promise<BrowserScreenshotResult>;
    /** 截取当前页面 PNG 并写入系统剪贴板。 */
    copyScreenshot(identity: BrowserSessionIdentity, tabId: number): Promise<BrowserClipboardResult>;
    /** 结构化页面快照（AX 树简化 + 可交互元素编号 + 可选截图）。 */
    snapshot(
      identity: BrowserSessionIdentity,
      tabId: number,
      opts?: { withScreenshot?: boolean },
    ): Promise<BrowserSnapshotResult>;
    /** 元素级交互（click/type/scroll，编号来自 snapshot）。 */
    action(identity: BrowserSessionIdentity, tabId: number, action: BrowserAction): Promise<BrowserActionResult>;
    /** 会话内全部 tab（含活跃标识由调用方按状态事件维护）。 */
    tabsList(identity: BrowserSessionIdentity): Promise<BrowserTab[]>;
    getSettings(): Promise<BrowserSettingsSnapshot>;
    saveSettings(input: SaveBrowserSettingsInput): Promise<SaveBrowserSettingsResult>;
    /** 设置页未保存修改标记（窗口关闭守卫）。 */
    setEditorDirty(dirty: boolean): boolean;
    /** 会话退役：清理该会话的 webview/guest/映射（renderer 会话记录移除时调用）。 */
    sessionRetire(identity: BrowserSessionIdentity): Promise<void>;
    /** 清除指定会话分区数据（cookie/缓存/登录态）。 */
    clearData(identity: BrowserSessionIdentity): Promise<void>;
    /** 清除全部会话分区数据（设置页入口）。 */
    clearAllData(): Promise<void>;
    /** 会话内访问历史（最近在前，仅用户 UI；Agent 不可见）。 */
    browserHistory(identity: BrowserSessionIdentity): Promise<BrowserHistoryEntry[]>;
    /** 取视口坐标处元素（标注模式）：生成选择器与 bounds。 */
    annotationPick(
      identity: BrowserSessionIdentity,
      tabId: number,
      x: number,
      y: number,
    ): Promise<BrowserAnnotationPickResult>;
    /** 添加标注；返回完整标注对象（null = tab 不存在）。 */
    annotationAdd(
      identity: BrowserSessionIdentity,
      tabId: number,
      input: BrowserAnnotationInput,
    ): Promise<BrowserAnnotation | null>;
    /** 指定 tab 的标注列表（最近在前）。 */
    annotationList(identity: BrowserSessionIdentity, tabId: number): Promise<BrowserAnnotation[]>;
    /** 删除标注。 */
    annotationRemove(identity: BrowserSessionIdentity, tabId: number, id: string): Promise<void>;
    /** 按选择器重新解析标注 bounds；元素消失返回 null。 */
    annotationResolve(
      identity: BrowserSessionIdentity,
      tabId: number,
      id: string,
    ): Promise<BrowserAnnotationBounds | null>;
    /** 订阅浏览器会话状态（携带 sessionKey，按身份路由）；返回取消订阅函数。 */
    onStateChanged(listener: (event: BrowserStateEvent) => void): () => void;
    /** main 请求创建新 tab（携带 sessionKey）；返回取消订阅函数。 */
    onCreateTabRequest(listener: (request: BrowserCreateTabRequest) => void): () => void;
  };
}
