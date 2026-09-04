import { BrowserWindow, dialog, ipcMain } from "electron";
import { CHANNELS } from "../../shared/channels.ts";
import type {
  ApplyDesktopExtensionSetInput,
  ApplyDesktopExtensionSetResult,
  ApplySessionPluginSelectionInput,
  ApproveDevelopmentExtensionInput,
  SaveDesktopExtensionSettingsInput,
} from "../../shared/desktop-extension-contracts.ts";
import type {
  SavePluginConfigurationInput,
  SavePluginConfigurationResult,
} from "../../shared/plugin-configuration-contracts.ts";
import type {
  InstallMarketplacePluginInput,
  ListMarketplacePluginsInput,
  SaveMarketplaceEndpointInput,
  SetMarketplacePluginEnabledInput,
  SetMarketplacePluginEnabledResult,
  SetMarketplacePluginScopeInput,
  SetMarketplacePluginScopeResult,
  TestMarketplaceEndpointInput,
  UninstallMarketplacePluginInput,
  UpdateMarketplacePluginInput,
} from "../../shared/plugin-marketplace-contracts.ts";
import type { DesktopExtensionSettingsService } from "../extensions/desktop-extension-settings-service.ts";
import type { SessionSupervisor } from "../pi/session-supervisor.ts";
import type { MarketplaceCatalogService } from "../plugins/marketplace-catalog-service.ts";
import type { MarketplaceEndpointSettingsService } from "../plugins/marketplace-endpoint-settings-service.ts";
import type { MarketplacePluginInstaller } from "../plugins/marketplace-plugin-installer.ts";
import type { MarketplacePluginRegistry } from "../plugins/marketplace-plugin-registry.ts";
import type { PluginConfigurationService } from "../plugins/plugin-configuration-service.ts";

/** 插件和 marketplace IPC 所需的最小服务集合。 */
export interface PluginIpcDependencies {
  readonly sessions: SessionSupervisor;
  readonly extensions?: DesktopExtensionSettingsService;
  readonly marketplaceEndpoints?: MarketplaceEndpointSettingsService;
  readonly marketplaceCatalog?: MarketplaceCatalogService;
  readonly marketplaceRegistry?: MarketplacePluginRegistry;
  readonly marketplaceInstaller?: MarketplacePluginInstaller;
  readonly pluginConfigurations?: PluginConfigurationService;
}

/** plugin registrar 可能注册的 channel 清单。 */
export const PLUGIN_IPC_CHANNELS = [
  CHANNELS.marketplaceGetEndpointSettings,
  CHANNELS.marketplaceTestEndpoint,
  CHANNELS.marketplaceSaveEndpoint,
  CHANNELS.marketplaceListPlugins,
  CHANNELS.marketplaceGetPlugin,
  CHANNELS.marketplaceGetInstalled,
  CHANNELS.marketplaceGetPluginConfiguration,
  CHANNELS.marketplaceSavePluginConfiguration,
  CHANNELS.marketplaceInstallPlugin,
  CHANNELS.marketplaceUpdatePlugin,
  CHANNELS.marketplaceUninstallPlugin,
  CHANNELS.marketplaceSetPluginEnabled,
  CHANNELS.marketplaceSetPluginScope,
  CHANNELS.extensionsGetConfig,
  CHANNELS.extensionsSaveConfig,
  CHANNELS.extensionsChooseDevelopmentEntry,
  CHANNELS.extensionsApply,
  CHANNELS.extensionsGetSessionPlugins,
  CHANNELS.extensionsApplySessionPlugins,
  CHANNELS.extensionsGetPluginConfiguration,
  CHANNELS.extensionsSavePluginConfiguration,
] as const;

/** 注册扩展配置、marketplace 安装和插件应用 IPC。 */
export function registerPluginIpc(dependencies: PluginIpcDependencies): readonly string[] {
  const {
    sessions,
    extensions,
    marketplaceEndpoints,
    marketplaceCatalog,
    marketplaceRegistry,
    marketplaceInstaller,
    pluginConfigurations,
  } = dependencies;
  const registered: string[] = [];
  if (marketplaceEndpoints && marketplaceCatalog) {
    registered.push(
      CHANNELS.marketplaceGetEndpointSettings,
      CHANNELS.marketplaceTestEndpoint,
      CHANNELS.marketplaceSaveEndpoint,
      CHANNELS.marketplaceListPlugins,
      CHANNELS.marketplaceGetPlugin,
    );
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
    ipcMain.handle(CHANNELS.marketplaceGetPlugin, (_event, pluginId: string) => marketplaceCatalog.getPlugin(pluginId));
    if (marketplaceRegistry && marketplaceInstaller) {
      registered.push(
        CHANNELS.marketplaceGetInstalled,
        CHANNELS.marketplaceGetPluginConfiguration,
        CHANNELS.marketplaceSavePluginConfiguration,
        CHANNELS.marketplaceInstallPlugin,
        CHANNELS.marketplaceUpdatePlugin,
        CHANNELS.marketplaceUninstallPlugin,
        CHANNELS.marketplaceSetPluginEnabled,
        CHANNELS.marketplaceSetPluginScope,
      );
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
        return {
          ...result,
          ...(await applyMarketplaceMutation(sessions, input.applyToCurrentSession, result.recoveryPending)),
        };
      });
      ipcMain.handle(CHANNELS.marketplaceUpdatePlugin, async (_event, input: UpdateMarketplacePluginInput) => {
        const result = await marketplaceInstaller.update(input);
        if (result.status !== "updated") return result;
        await sessions.extensionSettingsChanged();
        return {
          ...result,
          ...(await applyMarketplaceMutation(sessions, input.applyToCurrentSession, result.recoveryPending)),
        };
      });
      ipcMain.handle(CHANNELS.marketplaceUninstallPlugin, async (_event, input: UninstallMarketplacePluginInput) => {
        const result = await marketplaceInstaller.uninstall(input);
        if (result.status !== "uninstalled") return result;
        await sessions.extensionSettingsChanged();
        return {
          ...result,
          ...(await applyMarketplaceMutation(sessions, input.applyToCurrentSession, result.recoveryPending)),
        };
      });
      ipcMain.handle(
        CHANNELS.marketplaceSetPluginEnabled,
        async (_event, input: SetMarketplacePluginEnabledInput): Promise<SetMarketplacePluginEnabledResult> => {
          const result = await marketplaceRegistry.commitEnabled(input.expectedRevision, input.pluginId, input.enabled);
          if (result.status === "conflict") return { status: "conflict", current: result.snapshot };
          if (result.status === "not-installed") return { status: "not-installed", snapshot: result.snapshot };
          if (result.status === "broken") return { status: "broken", snapshot: result.snapshot };
          await sessions.extensionSettingsChanged();
          return { status: "saved", snapshot: result.snapshot };
        },
      );
      ipcMain.handle(
        CHANNELS.marketplaceSetPluginScope,
        async (_event, input: SetMarketplacePluginScopeInput): Promise<SetMarketplacePluginScopeResult> => {
          const result = await marketplaceRegistry.commitScope(
            input.expectedRevision,
            input.pluginId,
            input.scope,
            input.scope === "project" ? input.projectIds : undefined,
          );
          if (result.status === "conflict") return { status: "conflict", current: result.snapshot };
          if (result.status !== "saved") return { status: "not-installed", snapshot: result.snapshot };
          await sessions.extensionSettingsChanged();
          const application = await applyMarketplaceMutation(sessions, input.applyToCurrentSession, undefined);
          return { status: "saved", snapshot: result.snapshot, ...application };
        },
      );
    }
  }
  if (!extensions) return registered;
  registered.push(
    CHANNELS.extensionsGetConfig,
    CHANNELS.extensionsSaveConfig,
    CHANNELS.extensionsChooseDevelopmentEntry,
    CHANNELS.extensionsApply,
    CHANNELS.extensionsGetSessionPlugins,
    CHANNELS.extensionsApplySessionPlugins,
    CHANNELS.extensionsGetPluginConfiguration,
    CHANNELS.extensionsSavePluginConfiguration,
  );
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
  ipcMain.handle(CHANNELS.extensionsChooseDevelopmentEntry, async (event, input: ApproveDevelopmentExtensionInput) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Pi extension", extensions: ["ts", "js", "mjs", "cjs"] }],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const saved = await extensions.approveDevelopmentEntry(input, result.canceled ? undefined : result.filePaths[0]);
    if (saved.status === "saved") await sessions.extensionSettingsChanged();
    return saved;
  });
  ipcMain.handle(CHANNELS.extensionsApply, (_event, input: ApplyDesktopExtensionSetInput) =>
    sessions.applyExtensionSet(input.projectId, input.threadId, input.expectedDesiredGeneration, input.abortRunning),
  );
  ipcMain.handle(CHANNELS.extensionsGetSessionPlugins, (_event, projectId: string, threadId: string) =>
    sessions.getSessionPluginOptions(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.extensionsApplySessionPlugins, (_event, input: ApplySessionPluginSelectionInput) =>
    sessions.applySessionPluginSelection(input.projectId, input.threadId, input.enabledPluginIds, input.abortRunning),
  );
  ipcMain.handle(CHANNELS.extensionsGetPluginConfiguration, async (_event, pluginId: string) => {
    if (!pluginConfigurations) throw new Error("Plugin configuration service is unavailable");
    const schema = await extensions.getDevelopmentConfigurationSchema(pluginId);
    if (!schema) throw new Error(`Development plugin is not configurable: ${pluginId}`);
    return pluginConfigurations.getDevelopmentConfig(pluginId, schema);
  });
  ipcMain.handle(
    CHANNELS.extensionsSavePluginConfiguration,
    async (_event, input: SavePluginConfigurationInput): Promise<SavePluginConfigurationResult> => {
      if (!pluginConfigurations) throw new Error("Plugin configuration service is unavailable");
      const schema = await extensions.getDevelopmentConfigurationSchema(input.pluginId);
      if (!schema) throw new Error(`Development plugin is not configurable: ${input.pluginId}`);
      const result = await pluginConfigurations.saveDevelopmentConfig(input, schema);
      if (result.status === "saved") await sessions.extensionSettingsChanged();
      return result;
    },
  );
  return registered;
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

function publicMarketplaceApplication(application: ApplyDesktopExtensionSetResult): ApplyDesktopExtensionSetResult {
  return application.status === "rolled-back"
    ? { ...application, error: "插件 worker 启动失败，当前会话已恢复之前的扩展集合" }
    : application;
}
