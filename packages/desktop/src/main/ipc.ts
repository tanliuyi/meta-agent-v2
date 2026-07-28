import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  AuthOauthLoginInput,
  AuthOauthLoginResponse,
  SaveAuthConfigInput,
} from "../shared/auth-config-contracts.ts";
import { CHANNELS } from "../shared/channels.ts";
import type {
  HostResponse,
  SessionAttachInput,
  SessionBranchInput,
  SessionBranchResult,
  SessionControlState,
  SessionCreateInput,
  SessionCreateIpcResult,
  SessionEditInput,
  SessionPromptInput,
  SessionReloadInput,
  SessionResourceReloadInput,
  TerminalEvent,
  Thread,
  WorkbenchState,
} from "../shared/contracts.ts";
import type {
  NodeRuntimeProgress,
  NodeRuntimeStatus,
  ShellRuntimeProgress,
  ShellRuntimeStatus,
} from "../shared/desktop-api.ts";
import type {
  ApplyDesktopExtensionSetInput,
  ApplyDesktopExtensionSetResult,
  ApproveDevelopmentExtensionInput,
  SaveDesktopExtensionSettingsInput,
} from "../shared/desktop-extension-contracts.ts";
import type { SaveModelsConfigInput } from "../shared/models-config-contracts.ts";
import type {
  InstallMarketplacePluginInput,
  InstallMarketplacePluginResult,
  ListMarketplacePluginsInput,
  SaveMarketplaceEndpointInput,
  TestMarketplaceEndpointInput,
  UninstallMarketplacePluginInput,
  UninstallMarketplacePluginResult,
  UpdateMarketplacePluginInput,
  UpdateMarketplacePluginResult,
} from "../shared/plugin-marketplace-contracts.ts";
import type { SaveSettingsConfigInput } from "../shared/settings-config-contracts.ts";
import type { GetSubagentSettingsInput, SaveSubagentSettingsInput } from "../shared/subagent-contracts.ts";
import type { AuthConfigService } from "./auth/auth-config-service.ts";
import { OauthLoginCoordinator } from "./auth/oauth-login-coordinator.ts";
import type { DesktopExtensionSettingsService } from "./extensions/desktop-extension-settings-service.ts";
import type { FileService } from "./files/file-service.ts";
import type { ModelsConfigService } from "./models/models-config-service.ts";
import type { SessionSupervisor } from "./pi/session-supervisor.ts";
import type { MarketplaceCatalogService } from "./plugins/marketplace-catalog-service.ts";
import type { MarketplaceEndpointSettingsService } from "./plugins/marketplace-endpoint-settings-service.ts";
import type { MarketplaceExtensionApplyJournal } from "./plugins/marketplace-extension-apply-journal.ts";
import type { MarketplaceMutationApplyCoordinator } from "./plugins/marketplace-mutation-apply-coordinator.ts";
import type { MarketplacePluginInstaller } from "./plugins/marketplace-plugin-installer.ts";
import type { MarketplacePluginRegistry } from "./plugins/marketplace-plugin-registry.ts";
import type { MarketplaceRevocationService } from "./plugins/marketplace-revocation-service.ts";
import type { ProvidersConfigService } from "./providers/providers-config-service.ts";
import type { SettingsConfigService } from "./settings/settings-config-service.ts";
import type { ProjectStore } from "./store/project-store.ts";
import type { SubagentSettingsConfigService } from "./subagents/subagent-settings-config-service.ts";
import type { TerminalSupervisor } from "./terminal/terminal-supervisor.ts";
import type { AutoUpdateService } from "./updater.ts";
import type { WindowDirtyGuard } from "./window-dirty-guard.ts";

/** 注册 Desktop 的 Project、Pi session、文件和 Workbench IPC。 */
const authEditorWebContents = new Set<number>();
const providerEditorWebContents = new Set<number>();

export function registerIpc(
  projects: ProjectStore,
  sessions: SessionSupervisor,
  files: FileService,
  terminals: TerminalSupervisor,
  models: ModelsConfigService,
  auth: AuthConfigService,
  providers: ProvidersConfigService,
  settings: SettingsConfigService,
  dirtyGuard: WindowDirtyGuard,
  nodeRuntime: {
    getStatus(): NodeRuntimeStatus;
    install(): Promise<NodeRuntimeStatus>;
    onProgress(listener: (progress: NodeRuntimeProgress) => void): () => void;
    refreshActiveModelRuntimes?(): Promise<void>;
    shell?: {
      getStatus(): Promise<ShellRuntimeStatus> | ShellRuntimeStatus;
      install(): Promise<ShellRuntimeStatus>;
      onProgress(listener: (progress: ShellRuntimeProgress) => void): () => void;
    };
  },
  updater?: AutoUpdateService,
  extensions?: DesktopExtensionSettingsService,
  subagents?: SubagentSettingsConfigService,
  marketplaceEndpoints?: MarketplaceEndpointSettingsService,
  marketplaceCatalog?: MarketplaceCatalogService,
  marketplaceRegistry?: MarketplacePluginRegistry,
  marketplaceInstaller?: MarketplacePluginInstaller,
  marketplaceMutationApply?: MarketplaceMutationApplyCoordinator,
  marketplaceApplyJournal?: MarketplaceExtensionApplyJournal,
  marketplaceRevocations?: MarketplaceRevocationService,
): void {
  const subscribedWebContents = new Set<number>();
  const modelEditorWebContents = new Set<number>();
  const oauthWebContents = new Set<number>();
  const oauth = new OauthLoginCoordinator({
    login: (providerId, callbacks) => auth.loginOauth(providerId, callbacks),
  });
  ipcMain.on(CHANNELS.windowMinimize, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.on(CHANNELS.windowToggleMaximize, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return;
    if (owner.isMaximized()) owner.unmaximize();
    else owner.maximize();
  });
  ipcMain.on(CHANNELS.runtimeRestart, () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.on(CHANNELS.windowClose, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) void dirtyGuard.requestClose(owner);
  });
  ipcMain.handle(CHANNELS.linksOpen, (_event, projectId: string, target: string) =>
    openLink(projectId, target, projects),
  );
  ipcMain.handle(CHANNELS.modelsGetConfig, () => models.getConfig());
  ipcMain.handle(CHANNELS.modelsGetConfigRevision, () => models.getConfigRevision());
  ipcMain.handle(CHANNELS.modelsSaveConfig, async (_event, input: SaveModelsConfigInput) => {
    const result = await models.saveConfig(input);
    if (result.status !== "saved" || !nodeRuntime.refreshActiveModelRuntimes) return result;
    const activeSessionsRefreshed = await refreshActiveModelRuntimes(nodeRuntime.refreshActiveModelRuntimes);
    return { ...result, snapshot: { ...result.snapshot, activeSessionsRefreshed } };
  });
  ipcMain.handle(CHANNELS.modelsOpenConfigExternally, async () => openPath(await models.getExternalOpenTarget()));
  ipcMain.handle(CHANNELS.authGetConfig, () => auth.getConfig());
  ipcMain.handle(CHANNELS.authGetConfigRevision, () => auth.getConfigRevision());
  ipcMain.handle(CHANNELS.authSaveConfig, async (_event, input: SaveAuthConfigInput) => {
    const result = await auth.saveConfig(input);
    if (result.status === "saved" && nodeRuntime.refreshActiveModelRuntimes) {
      await refreshActiveModelRuntimes(nodeRuntime.refreshActiveModelRuntimes);
    }
    return result;
  });
  ipcMain.handle(CHANNELS.authOpenConfigExternally, async () => openPath(await auth.getExternalOpenTarget()));
  ipcMain.handle(CHANNELS.authOauthLogin, (event, input: AuthOauthLoginInput) => {
    const ownerId = event.sender.id;
    if (!oauthWebContents.has(ownerId)) {
      oauthWebContents.add(ownerId);
      event.sender.once("destroyed", () => {
        oauthWebContents.delete(ownerId);
        oauth.cancelOwner(ownerId);
      });
    }
    return oauth
      .start(
        ownerId,
        input,
        (oauthEvent) => {
          if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.authOauthEvent, oauthEvent);
        },
        openOauthUrl,
      )
      .then(async (snapshot) => {
        if (nodeRuntime.refreshActiveModelRuntimes) {
          await refreshActiveModelRuntimes(nodeRuntime.refreshActiveModelRuntimes);
        }
        return snapshot;
      });
  });
  ipcMain.handle(CHANNELS.authOauthRespond, (event, response: AuthOauthLoginResponse) => {
    oauth.respond(event.sender.id, response);
  });
  ipcMain.handle(CHANNELS.authOauthCancel, (event, loginId: string) => {
    oauth.cancel(event.sender.id, loginId);
  });
  ipcMain.handle(CHANNELS.providersGetConfig, () => providers.getConfig());
  ipcMain.handle(CHANNELS.providersSaveConfig, async (_event, input) => {
    const result = await providers.saveConfig(input);
    if (result.status === "saved" && nodeRuntime.refreshActiveModelRuntimes) {
      await refreshActiveModelRuntimes(nodeRuntime.refreshActiveModelRuntimes);
    }
    return result;
  });
  ipcMain.handle(CHANNELS.providersOpenConfigExternally, async () => openPath(await providers.getExternalOpenTarget()));
  ipcMain.handle(CHANNELS.settingsGetConfig, () => settings.getConfig());
  ipcMain.handle(CHANNELS.settingsSaveConfig, (_event, input: SaveSettingsConfigInput) => settings.saveConfig(input));
  if (subagents) {
    ipcMain.handle(CHANNELS.subagentsGetSnapshot, (_event, input?: GetSubagentSettingsInput) =>
      subagents.getSnapshot(input),
    );
    ipcMain.handle(CHANNELS.subagentsSaveConfig, (_event, input: SaveSubagentSettingsInput) =>
      subagents.saveConfig(input),
    );
  }
  if (marketplaceEndpoints && marketplaceCatalog) {
    ipcMain.handle(CHANNELS.marketplaceGetEndpointSettings, () => marketplaceEndpoints.getSettings());
    ipcMain.handle(CHANNELS.marketplaceTestEndpoint, (_event, input: TestMarketplaceEndpointInput) =>
      marketplaceEndpoints.testEndpoint(input),
    );
    ipcMain.handle(CHANNELS.marketplaceSaveEndpoint, (_event, input: SaveMarketplaceEndpointInput) =>
      marketplaceEndpoints.saveEndpoint(input),
    );
    ipcMain.handle(CHANNELS.marketplaceListPlugins, (_event, input: ListMarketplacePluginsInput = {}) =>
      marketplaceCatalog.list(input),
    );
    if (marketplaceRegistry && marketplaceInstaller) {
      ipcMain.handle(CHANNELS.marketplaceGetInstalled, async () => {
        const snapshot = await marketplaceRegistry.getSnapshot();
        return marketplaceRevocations ? marketplaceRevocations.decorateSnapshot(snapshot) : snapshot;
      });
      ipcMain.handle(CHANNELS.marketplaceInstallPlugin, async (_event, input: InstallMarketplacePluginInput) => {
        assertMarketplaceApplyAvailable(input.applyToCurrentSession, marketplaceMutationApply, marketplaceApplyJournal);
        const result = await marketplaceInstaller.install(input);
        if (result.status !== "installed") {
          return decorateMarketplaceMutationResult(result, marketplaceRevocations);
        }
        await sessions.extensionSettingsChanged();
        if (!input.applyToCurrentSession || result.recoveryPending || !marketplaceMutationApply) {
          return decorateMarketplaceMutationResult(result, marketplaceRevocations);
        }
        const transaction = await marketplaceInstaller.getPendingApplyTransaction(input.requestId);
        if (!transaction) return decorateMarketplaceMutationResult(result, marketplaceRevocations);
        let application: ApplyDesktopExtensionSetResult;
        try {
          application = await applyMarketplaceMutation(
            sessions,
            marketplaceMutationApply,
            marketplaceApplyJournal,
            input.applyToCurrentSession,
            transaction.operationId,
          );
        } catch (error) {
          // 安装已提交；应用失败不能让 renderer 把整个 mutation 当作失败。
          return decorateMarketplaceMutationResult(
            { ...result, applicationError: error instanceof Error ? error.message : String(error) },
            marketplaceRevocations,
          );
        }
        if (application.status === "rolled-back") {
          marketplaceInstaller.clearCompletedMutation(input.requestId);
          const snapshot = await marketplaceRegistry.getSnapshot();
          return decorateMarketplaceMutationResult({ ...result, snapshot, application }, marketplaceRevocations);
        }
        return decorateMarketplaceMutationResult({ ...result, application }, marketplaceRevocations);
      });
      ipcMain.handle(CHANNELS.marketplaceUpdatePlugin, async (_event, input: UpdateMarketplacePluginInput) => {
        assertMarketplaceApplyAvailable(input.applyToCurrentSession, marketplaceMutationApply, marketplaceApplyJournal);
        const result = await marketplaceInstaller.update(input);
        if (result.status !== "updated") {
          return decorateMarketplaceMutationResult(result, marketplaceRevocations);
        }
        await sessions.extensionSettingsChanged();
        if (!input.applyToCurrentSession || result.recoveryPending || !marketplaceMutationApply) {
          return decorateMarketplaceMutationResult(result, marketplaceRevocations);
        }
        const transaction = await marketplaceInstaller.getPendingApplyTransaction(input.requestId);
        if (!transaction) return decorateMarketplaceMutationResult(result, marketplaceRevocations);
        let application: ApplyDesktopExtensionSetResult;
        try {
          application = await applyMarketplaceMutation(
            sessions,
            marketplaceMutationApply,
            marketplaceApplyJournal,
            input.applyToCurrentSession,
            transaction.operationId,
          );
        } catch (error) {
          return decorateMarketplaceMutationResult(
            { ...result, applicationError: error instanceof Error ? error.message : String(error) },
            marketplaceRevocations,
          );
        }
        if (application.status === "rolled-back") {
          marketplaceInstaller.clearCompletedMutation(input.requestId);
          const snapshot = await marketplaceRegistry.getSnapshot();
          return decorateMarketplaceMutationResult({ ...result, snapshot, application }, marketplaceRevocations);
        }
        return decorateMarketplaceMutationResult({ ...result, application }, marketplaceRevocations);
      });
      ipcMain.handle(CHANNELS.marketplaceUninstallPlugin, async (_event, input: UninstallMarketplacePluginInput) => {
        assertMarketplaceApplyAvailable(input.applyToCurrentSession, marketplaceMutationApply, marketplaceApplyJournal);
        const result = await marketplaceInstaller.uninstall(input);
        if (result.status !== "uninstalled") {
          return decorateMarketplaceMutationResult(result, marketplaceRevocations);
        }
        await sessions.extensionSettingsChanged();
        if (!input.applyToCurrentSession || result.recoveryPending || !marketplaceMutationApply) {
          return decorateMarketplaceMutationResult(result, marketplaceRevocations);
        }
        const transaction = await marketplaceInstaller.getPendingApplyTransaction(input.requestId);
        if (!transaction) return decorateMarketplaceMutationResult(result, marketplaceRevocations);
        let application: ApplyDesktopExtensionSetResult;
        try {
          application = await applyMarketplaceMutation(
            sessions,
            marketplaceMutationApply,
            marketplaceApplyJournal,
            input.applyToCurrentSession,
            transaction.operationId,
          );
        } catch (error) {
          return decorateMarketplaceMutationResult(
            { ...result, applicationError: error instanceof Error ? error.message : String(error) },
            marketplaceRevocations,
          );
        }
        if (application.status === "rolled-back") {
          marketplaceInstaller.clearCompletedMutation(input.requestId);
          const snapshot = await marketplaceRegistry.getSnapshot();
          return decorateMarketplaceMutationResult({ ...result, snapshot, application }, marketplaceRevocations);
        }
        return decorateMarketplaceMutationResult({ ...result, application }, marketplaceRevocations);
      });
    }
  }
  if (extensions) {
    ipcMain.handle(CHANNELS.extensionsGetConfig, async (_event, projectId?: string, threadId?: string) => {
      const snapshot = await extensions.getConfig();
      if (!projectId || !threadId) return snapshot;
      const state = await sessions.getExtensionState(projectId, threadId);
      return {
        ...snapshot,
        reloadRequired: state.reloadRequired,
        appliedGeneration: state.appliedGeneration,
        desiredGeneration: state.desiredGeneration,
        diagnostics: state.diagnostics,
      };
    });
    ipcMain.handle(CHANNELS.extensionsSaveConfig, async (_event, input: SaveDesktopExtensionSettingsInput) => {
      const result = await extensions.saveConfig(input);
      if (result.status === "saved") await sessions.extensionSettingsChanged();
      return result;
    });
    ipcMain.handle(
      CHANNELS.extensionsChooseDevelopmentEntry,
      async (event, input: ApproveDevelopmentExtensionInput) => {
        const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const result = owner
          ? await dialog.showOpenDialog(owner, {
              properties: ["openFile"],
              filters: [{ name: "Pi extension", extensions: ["ts", "js", "mjs", "cjs"] }],
            })
          : await dialog.showOpenDialog({
              properties: ["openFile"],
              filters: [{ name: "Pi extension", extensions: ["ts", "js", "mjs", "cjs"] }],
            });
        const saved = await extensions.approveDevelopmentEntry(
          input,
          result.canceled ? undefined : result.filePaths[0],
        );
        if (saved.status === "saved") await sessions.extensionSettingsChanged();
        return saved;
      },
    );
    ipcMain.handle(CHANNELS.extensionsApply, (_event, input: ApplyDesktopExtensionSetInput) =>
      sessions.applyExtensionSet(input.projectId, input.threadId, input.expectedDesiredGeneration, input.abortRunning),
    );
  }
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

  ipcMain.on(CHANNELS.providersSetEditorDirty, (event, dirty: unknown) => {
    if (typeof dirty !== "boolean") {
      event.returnValue = false;
      return;
    }
    const ownerId = event.sender.id;
    dirtyGuard.setDirty(ownerId, dirty);
    if (!providerEditorWebContents.has(ownerId)) {
      providerEditorWebContents.add(ownerId);
      event.sender.once("destroyed", () => {
        providerEditorWebContents.delete(ownerId);
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
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
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
  ipcMain.handle(CHANNELS.sessionsReloadResources, (_event, input: SessionResourceReloadInput) =>
    sessions.reloadResources(input),
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
  ipcMain.handle(CHANNELS.filesList, (_event, projectId: string, path?: string, query?: string) =>
    files.list(projectId, path, query),
  );
  ipcMain.handle(CHANNELS.filesRead, (_event, projectId: string, path: string) => files.read(projectId, path));
  ipcMain.handle(CHANNELS.filesResolvePath, (_event, projectId: string, path: string) =>
    resolveFilePath(projectId, path, projects),
  );
  ipcMain.handle(CHANNELS.filesOpen, async (_event, projectId: string, path: string) => {
    await openPath(await resolveFilePath(projectId, path, projects));
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
  if (nodeRuntime.shell) {
    ipcMain.handle(CHANNELS.shellRuntimeStatus, () => nodeRuntime.shell?.getStatus());
    ipcMain.handle(CHANNELS.shellRuntimeInstall, () => nodeRuntime.shell?.install());
  }
  if (updater) {
    ipcMain.handle(CHANNELS.updaterGetState, () => updater.getState());
    ipcMain.handle(CHANNELS.updaterCheck, () => updater.check());
    ipcMain.handle(CHANNELS.updaterDownload, () => updater.download());
    ipcMain.handle(CHANNELS.updaterInstall, async () => {
      const confirmed = await dirtyGuard.confirmApplicationQuit(BrowserWindow.getAllWindows());
      if (confirmed) updater.install();
    });
    updater.subscribe((state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(CHANNELS.updaterStateChanged, state);
        }
      }
    });
  }
  nodeRuntime.onProgress((progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.nodeRuntimeProgress, progress);
    }
  });
  nodeRuntime.shell?.onProgress((progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.shellRuntimeProgress, progress);
    }
  });
}

function decorateMarketplaceMutationResult(
  result: InstallMarketplacePluginResult,
  revocations: MarketplaceRevocationService | undefined,
): Promise<InstallMarketplacePluginResult>;
function decorateMarketplaceMutationResult(
  result: UpdateMarketplacePluginResult,
  revocations: MarketplaceRevocationService | undefined,
): Promise<UpdateMarketplacePluginResult>;
function decorateMarketplaceMutationResult(
  result: UninstallMarketplacePluginResult,
  revocations: MarketplaceRevocationService | undefined,
): Promise<UninstallMarketplacePluginResult>;
async function decorateMarketplaceMutationResult(
  result: InstallMarketplacePluginResult | UpdateMarketplacePluginResult | UninstallMarketplacePluginResult,
  revocations: MarketplaceRevocationService | undefined,
): Promise<InstallMarketplacePluginResult | UpdateMarketplacePluginResult | UninstallMarketplacePluginResult> {
  if (!revocations) return result;
  if ("current" in result) {
    return { ...result, current: await revocations.decorateSnapshot(result.current) };
  }
  return { ...result, snapshot: await revocations.decorateSnapshot(result.snapshot) };
}

function assertMarketplaceApplyAvailable(
  target: { projectId: string; threadId: string } | undefined,
  mutationApply: MarketplaceMutationApplyCoordinator | undefined,
  applyJournal: MarketplaceExtensionApplyJournal | undefined,
): void {
  if (target && (!mutationApply || !applyJournal)) {
    throw new Error("Marketplace extension apply recovery is unavailable");
  }
}

async function applyMarketplaceMutation(
  sessions: SessionSupervisor,
  mutationApply: MarketplaceMutationApplyCoordinator,
  applyJournal: MarketplaceExtensionApplyJournal | undefined,
  target: { projectId: string; threadId: string; abortRunning?: boolean },
  operationId: string,
): Promise<ApplyDesktopExtensionSetResult> {
  try {
    if (await applyJournal?.hasMutationOperation(operationId)) {
      throw new Error("Marketplace extension apply recovery is pending; restart Desktop before retrying");
    }
    const state = await sessions.getExtensionState(target.projectId, target.threadId);
    const application = await sessions.applyExtensionSet(
      target.projectId,
      target.threadId,
      state.desiredGeneration,
      target.abortRunning,
      operationId,
    );
    if (application.status === "unchanged") await mutationApply.complete(operationId);
    return publicMarketplaceApplication(application);
  } catch (error) {
    if (await applyJournal?.hasMutationOperation(operationId)) throw error;
    if (isColdExtensionSetApplyStartupError(error)) {
      await mutationApply.rollback(operationId);
      await mutationApply.complete(operationId);
      await sessions.extensionSettingsChanged();
      const restored = await sessions.getExtensionState(target.projectId, target.threadId);
      return publicMarketplaceApplication({
        status: "rolled-back",
        generation: restored.desiredGeneration,
        error: error.message,
      });
    }
    await mutationApply.complete(operationId);
    throw error;
  }
}

function isColdExtensionSetApplyStartupError(
  error: unknown,
): error is Error & { code: "COLD_EXTENSION_SET_APPLY_STARTUP_FAILED" } {
  return error instanceof Error && "code" in error && error.code === "COLD_EXTENSION_SET_APPLY_STARTUP_FAILED";
}

async function refreshActiveModelRuntimes(refresh: () => Promise<void>): Promise<boolean> {
  try {
    await refresh();
    return true;
  } catch (error) {
    console.error("Model configuration was saved, but one or more active runtimes failed to refresh:", error);
    return false;
  }
}

function publicMarketplaceApplication(application: ApplyDesktopExtensionSetResult): ApplyDesktopExtensionSetResult {
  return application.status === "rolled-back"
    ? { ...application, error: "插件 worker 启动失败，当前会话已恢复之前的扩展集合" }
    : application;
}

async function openLink(projectId: string, target: string, projects: ProjectStore): Promise<void> {
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
    await openPath(resolve(projects.getCwd(projectId), decodeURIComponent(localTarget)));
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

async function resolveFilePath(projectId: string, path: string, projects: ProjectStore): Promise<string> {
  const value = path.trim();
  if (!value) throw new Error("Cannot resolve an empty file path");
  if (isAbsolute(value)) return value;
  return resolve(projects.getCwd(projectId), value);
}

async function openPath(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

async function openOauthUrl(target: string): Promise<void> {
  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported OAuth URL protocol");
  await shell.openExternal(url.href);
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

/** 向所有 renderer 广播低频 thread catalog 更新。 */
export function broadcastThreadCatalogUpdate(thread: Thread): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.sessionsCatalogChanged, thread);
  }
}

/** 向所有 renderer 广播 PTY 增量事件。 */
export function broadcastTerminalEvent(event: TerminalEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.terminalsEvent, event);
  }
}
