import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions, shell } from "electron";
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
import type { ShellRuntimeProgress, ShellRuntimeStatus } from "../shared/desktop-api.ts";
import type {
  ApplyDesktopExtensionSetInput,
  ApplyDesktopExtensionSetResult,
  ApproveDevelopmentExtensionInput,
  SaveDesktopExtensionSettingsInput,
} from "../shared/desktop-extension-contracts.ts";
import type { SaveModelsConfigInput } from "../shared/models-config-contracts.ts";
import type {
  SavePluginConfigurationInput,
  SavePluginConfigurationResult,
} from "../shared/plugin-configuration-contracts.ts";
import type {
  InstallMarketplacePluginInput,
  ListMarketplacePluginsInput,
  SaveMarketplaceEndpointInput,
  TestMarketplaceEndpointInput,
  UninstallMarketplacePluginInput,
  UpdateMarketplacePluginInput,
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
import type { MarketplacePluginInstaller } from "./plugins/marketplace-plugin-installer.ts";
import type { MarketplacePluginRegistry } from "./plugins/marketplace-plugin-registry.ts";
import type { PluginConfigurationService } from "./plugins/plugin-configuration-service.ts";
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
  runtimeDependencies: {
    refreshActiveModelRuntimes?(): Promise<void>;
    shell?: {
      getStatus(): Promise<ShellRuntimeStatus> | ShellRuntimeStatus;
      install(): Promise<ShellRuntimeStatus>;
      use(path: string): Promise<ShellRuntimeStatus>;
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
  pluginConfigurations?: PluginConfigurationService,
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
    if (result.status !== "saved" || !runtimeDependencies.refreshActiveModelRuntimes) return result;
    const activeSessionsRefreshed = await refreshActiveModelRuntimes(runtimeDependencies.refreshActiveModelRuntimes);
    return { ...result, snapshot: { ...result.snapshot, activeSessionsRefreshed } };
  });
  ipcMain.handle(CHANNELS.modelsOpenConfigExternally, async () => openPath(await models.getExternalOpenTarget()));
  ipcMain.handle(CHANNELS.authGetConfig, () => auth.getConfig());
  ipcMain.handle(CHANNELS.authGetConfigRevision, () => auth.getConfigRevision());
  ipcMain.handle(CHANNELS.authSaveConfig, async (_event, input: SaveAuthConfigInput) => {
    const result = await auth.saveConfig(input);
    if (result.status === "saved" && runtimeDependencies.refreshActiveModelRuntimes) {
      await refreshActiveModelRuntimes(runtimeDependencies.refreshActiveModelRuntimes);
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
        if (runtimeDependencies.refreshActiveModelRuntimes) {
          await refreshActiveModelRuntimes(runtimeDependencies.refreshActiveModelRuntimes);
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
    if (result.status === "saved" && runtimeDependencies.refreshActiveModelRuntimes) {
      await refreshActiveModelRuntimes(runtimeDependencies.refreshActiveModelRuntimes);
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
      ipcMain.handle(CHANNELS.marketplaceGetInstalled, () => marketplaceRegistry.getSnapshot());
      ipcMain.handle(CHANNELS.marketplaceGetPluginConfiguration, (_event, pluginId: string) => {
        if (!pluginConfigurations) throw new Error("Plugin configuration service is unavailable");
        return pluginConfigurations.getConfig(pluginId);
      });
      ipcMain.handle(
        CHANNELS.marketplaceSavePluginConfiguration,
        async (_event, input: SavePluginConfigurationInput): Promise<SavePluginConfigurationResult> => {
          if (!pluginConfigurations) throw new Error("Plugin configuration service is unavailable");
          const result = await pluginConfigurations.saveConfig(input);
          if (result.status === "saved") await sessions.extensionSettingsChanged();
          return result;
        },
      );
      ipcMain.handle(CHANNELS.marketplaceInstallPlugin, async (_event, input: InstallMarketplacePluginInput) => {
        const result = await marketplaceInstaller.install(input);
        if (result.status !== "installed") return result;
        await sessions.extensionSettingsChanged();
        const application = await applyMarketplaceMutation(
          sessions,
          input.applyToCurrentSession,
          result.recoveryPending,
        );
        return { ...result, ...application };
      });
      ipcMain.handle(CHANNELS.marketplaceUpdatePlugin, async (_event, input: UpdateMarketplacePluginInput) => {
        const result = await marketplaceInstaller.update(input);
        if (result.status !== "updated") return result;
        await sessions.extensionSettingsChanged();
        const application = await applyMarketplaceMutation(
          sessions,
          input.applyToCurrentSession,
          result.recoveryPending,
        );
        return { ...result, ...application };
      });
      ipcMain.handle(CHANNELS.marketplaceUninstallPlugin, async (_event, input: UninstallMarketplacePluginInput) => {
        const result = await marketplaceInstaller.uninstall(input);
        if (result.status !== "uninstalled") return result;
        await sessions.extensionSettingsChanged();
        const application = await applyMarketplaceMutation(
          sessions,
          input.applyToCurrentSession,
          result.recoveryPending,
        );
        return { ...result, ...application };
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
  ipcMain.handle(CHANNELS.projectsRename, (_event, projectId: string, name: string) =>
    projects.rename(projectId, name),
  );
  ipcMain.handle(CHANNELS.projectsOpenExternally, async (_event, projectId: string) => {
    await openPath(projects.getCwd(projectId));
  });
  ipcMain.handle(CHANNELS.projectsRemove, (_event, projectId: string) => projects.remove(projectId));

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
  if (runtimeDependencies.shell) {
    ipcMain.handle(CHANNELS.shellRuntimeStatus, () => runtimeDependencies.shell?.getStatus());
    ipcMain.handle(CHANNELS.shellRuntimeInstall, () => runtimeDependencies.shell?.install());
    ipcMain.handle(CHANNELS.shellRuntimeChoose, async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: OpenDialogOptions = {
        title: "选择 Git Bash 可执行文件",
        properties: ["openFile"],
        filters: [{ name: "Bash executable", extensions: ["exe"] }],
      };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      const path = result.filePaths[0];
      return result.canceled || !path ? null : runtimeDependencies.shell?.use(path);
    });
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
  runtimeDependencies.shell?.onProgress((progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.shellRuntimeProgress, progress);
    }
  });
}

async function applyMarketplaceMutation(
  sessions: SessionSupervisor,
  target: { projectId: string; threadId: string; abortRunning?: boolean } | undefined,
  recoveryPending: boolean | undefined,
): Promise<{ application?: ApplyDesktopExtensionSetResult; applicationError?: string }> {
  if (!target || recoveryPending) return {};
  try {
    const state = await sessions.getExtensionState(target.projectId, target.threadId);
    const application = await sessions.applyExtensionSet(
      target.projectId,
      target.threadId,
      state.desiredGeneration,
      target.abortRunning,
    );
    return { application: publicMarketplaceApplication(application) };
  } catch (error) {
    return { applicationError: error instanceof Error ? error.message : String(error) };
  }
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
