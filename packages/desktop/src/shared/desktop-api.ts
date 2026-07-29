import type {
  AuthConfigSnapshot,
  AuthOauthLoginEvent,
  AuthOauthLoginInput,
  AuthOauthLoginResponse,
  SaveAuthConfigInput,
  SaveAuthConfigResult,
} from "./auth-config-contracts.ts";
import type {
  ClearedQueue,
  DraftSessionConfig,
  FileNode,
  HostResponse,
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
  SessionPromptInput,
  SessionPushPayload,
  SessionReloadInput,
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
import type { ModelsConfigSnapshot, SaveModelsConfigInput, SaveModelsConfigResult } from "./models-config-contracts.ts";
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
  SaveMarketplaceEndpointInput,
  SaveMarketplaceEndpointResult,
  TestMarketplaceEndpointInput,
  TestMarketplaceEndpointResult,
  UninstallMarketplacePluginInput,
  UninstallMarketplacePluginResult,
  UpdateMarketplacePluginInput,
  UpdateMarketplacePluginResult,
} from "./plugin-marketplace-contracts.ts";
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

export interface NodeRuntimeStatus {
  state: "ready" | "missing" | "invalid";
  path?: string;
  version?: string;
  requiredVersion: string;
  message: string;
  installUrl: string;
}

export interface NodeRuntimeProgress {
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

export type ShellRuntimeProgress = NodeRuntimeProgress;

/** Renderer 可以调用的最小 Desktop API。 */
export interface DesktopApi {
  platform: DesktopPlatform;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  nodeRuntime: {
    getStatus(): Promise<NodeRuntimeStatus>;
    install(): Promise<NodeRuntimeStatus>;
    onProgress(listener: (progress: NodeRuntimeProgress) => void): () => void;
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
    open(projectId: string, url: string): Promise<void>;
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
  };
  extensions: {
    getConfig(projectId?: string, threadId?: string): Promise<DesktopExtensionSettingsSnapshot>;
    saveConfig(input: SaveDesktopExtensionSettingsInput): Promise<SaveDesktopExtensionSettingsResult>;
    chooseDevelopmentEntry(input: ApproveDevelopmentExtensionInput): Promise<SaveDesktopExtensionSettingsResult>;
    apply(input: ApplyDesktopExtensionSetInput): Promise<ApplyDesktopExtensionSetResult>;
  };
  marketplace: {
    getEndpointSettings(): Promise<MarketplaceEndpointSettingsSnapshot>;
    testEndpoint(input: TestMarketplaceEndpointInput): Promise<TestMarketplaceEndpointResult>;
    saveEndpoint(input: SaveMarketplaceEndpointInput): Promise<SaveMarketplaceEndpointResult>;
    listPlugins(input?: ListMarketplacePluginsInput): Promise<MarketplacePluginPage>;
    getInstalled(): Promise<InstalledMarketplacePluginsSnapshot>;
    getPluginConfiguration(pluginId: string): Promise<PluginConfigurationSnapshot>;
    savePluginConfiguration(input: SavePluginConfigurationInput): Promise<SavePluginConfigurationResult>;
    installPlugin(input: InstallMarketplacePluginInput): Promise<InstallMarketplacePluginResult>;
    updatePlugin(input: UpdateMarketplacePluginInput): Promise<UpdateMarketplacePluginResult>;
    uninstallPlugin(input: UninstallMarketplacePluginInput): Promise<UninstallMarketplacePluginResult>;
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
    remove(projectId: string): Promise<void>;
    getActive(): Promise<Project | null>;
  };
  sessions: {
    list(projectId: string, includeArchived?: boolean): Promise<Thread[]>;
    onCatalogChanged(listener: (thread: Thread) => void): () => void;
    getDraftConfig(projectId: string): Promise<DraftSessionConfig>;
    create(input: SessionCreateInput): Promise<SessionBootstrap>;
    attach(input: SessionAttachInput, listener: (update: SessionPushPayload) => void): Promise<SessionAttachment>;
    flush(attachmentId: string): SessionFlushResult;
    detach(attachmentId: string): void;
    prewarm(projectId: string, threadId: string): Promise<void>;
    rename(projectId: string, threadId: string, title: string): Promise<void>;
    archive(projectId: string, threadId: string, archived: boolean): Promise<void>;
    remove(projectId: string, threadId: string): Promise<void>;
    prompt(input: SessionPromptInput): Promise<SessionCommandResult>;
    edit(input: SessionEditInput): Promise<SessionCommandResult>;
    reload(input: SessionReloadInput): Promise<SessionCommandResult>;
    reloadResources(input: SessionResourceReloadInput): Promise<SessionCommandResult>;
    branch(input: SessionBranchInput): Promise<SessionBranchResult>;
    cancel(projectId: string, threadId: string): Promise<void>;
    clearQueue(projectId: string, threadId: string): Promise<ClearedQueue>;
    compact(projectId: string, threadId: string): Promise<void>;
    refreshModels(projectId: string, threadId: string): Promise<void>;
    setModel(projectId: string, threadId: string, provider: string, modelId: string): Promise<void>;
    setThinking(projectId: string, threadId: string, level: SessionControlState["thinkingLevel"]): Promise<void>;
    respond(projectId: string, threadId: string, response: HostResponse): Promise<void>;
  };
  files: {
    list(projectId: string, path?: string, query?: string): Promise<FileNode[]>;
    read(projectId: string, path: string): Promise<TextFile>;
    resolvePath(projectId: string, path: string): Promise<string>;
    open(projectId: string, path: string): Promise<void>;
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
    onEvent(listener: (event: TerminalEvent) => void): () => void;
  };
  workbench: {
    get(projectId: string, threadId: string): Promise<WorkbenchState>;
    update(state: WorkbenchState): Promise<void>;
  };
}
