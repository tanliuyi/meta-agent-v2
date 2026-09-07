import { BrowserWindow, dialog, ipcMain } from "electron";
import { CHANNELS } from "../../shared/channels.ts";
import type { CodexPluginMutationInput, SetCodexPluginEnabledInput } from "../../shared/codex-plugin-contracts.ts";
import type {
  ApplyDesktopExtensionSetInput,
  ApplySessionPluginSelectionInput,
  ApproveDevelopmentExtensionInput,
  SaveDesktopExtensionSettingsInput,
} from "../../shared/desktop-extension-contracts.ts";
import type { DesktopExtensionSettingsService } from "../extensions/desktop-extension-settings-service.ts";
import type { SessionSupervisor } from "../pi/session-supervisor.ts";
import type { CodexPluginCatalog } from "../plugins/codex/codex-plugin-catalog.ts";

/** 插件和 marketplace IPC 所需的最小服务集合。 */
export interface PluginIpcDependencies {
  readonly sessions: SessionSupervisor;
  readonly extensions?: DesktopExtensionSettingsService;
  readonly codexCatalog?: CodexPluginCatalog;
}

/** plugin registrar 可能注册的 channel 清单。 */
export const PLUGIN_IPC_CHANNELS = [
  CHANNELS.extensionsGetConfig,
  CHANNELS.extensionsSaveConfig,
  CHANNELS.extensionsChooseDevelopmentEntry,
  CHANNELS.extensionsApply,
  CHANNELS.extensionsGetSessionPlugins,
  CHANNELS.extensionsApplySessionPlugins,
  CHANNELS.codexPluginsList,
  CHANNELS.codexPluginsInstall,
  CHANNELS.codexPluginsUpdate,
  CHANNELS.codexPluginsUninstall,
  CHANNELS.codexPluginsSetEnabled,
] as const;

/** 注册扩展配置、marketplace 安装和插件应用 IPC。 */
export function registerPluginIpc(dependencies: PluginIpcDependencies): readonly string[] {
  const { sessions, extensions, codexCatalog } = dependencies;
  const registered: string[] = [];
  if (codexCatalog) {
    registered.push(
      CHANNELS.codexPluginsList,
      CHANNELS.codexPluginsInstall,
      CHANNELS.codexPluginsUpdate,
      CHANNELS.codexPluginsUninstall,
      CHANNELS.codexPluginsSetEnabled,
    );
    ipcMain.handle(CHANNELS.codexPluginsList, () => codexCatalog.list());
    ipcMain.handle(CHANNELS.codexPluginsInstall, async (_event, input: CodexPluginMutationInput) => {
      assertRecordFields(input, ["requestId", "expectedRevision", "pluginId", "confirmFullTrust"]);
      const result = await codexCatalog.install(input);
      if (result.status === "installed") await sessions.extensionSettingsChanged();
      return result;
    });
    ipcMain.handle(CHANNELS.codexPluginsUpdate, async (_event, input: CodexPluginMutationInput) => {
      assertRecordFields(input, ["requestId", "expectedRevision", "pluginId", "confirmFullTrust"]);
      const result = await codexCatalog.update(input);
      if (result.status === "updated") await sessions.extensionSettingsChanged();
      return result;
    });
    ipcMain.handle(CHANNELS.codexPluginsUninstall, async (_event, input: CodexPluginMutationInput) => {
      assertRecordFields(input, ["requestId", "expectedRevision", "pluginId", "confirmRemoval"]);
      const result = await codexCatalog.uninstall(input);
      if (result.status === "uninstalled") await sessions.extensionSettingsChanged();
      return result;
    });
    ipcMain.handle(CHANNELS.codexPluginsSetEnabled, async (_event, input: SetCodexPluginEnabledInput) => {
      assertRecordFields(input, ["requestId", "expectedRevision", "pluginId", "enabled"]);
      const result = await codexCatalog.setEnabled(input.expectedRevision, input.pluginId, input.enabled);
      if (result.status === "saved") await sessions.extensionSettingsChanged();
      return result;
    });
  }
  if (!extensions) return registered;
  registered.push(
    CHANNELS.extensionsGetConfig,
    CHANNELS.extensionsSaveConfig,
    CHANNELS.extensionsChooseDevelopmentEntry,
    CHANNELS.extensionsApply,
    CHANNELS.extensionsGetSessionPlugins,
    CHANNELS.extensionsApplySessionPlugins,
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
    assertRecordFields(input, ["requestId", "expectedRevision", "mutation"]);
    const result = await extensions.saveConfig(input);
    if (result.status === "saved") await sessions.extensionSettingsChanged();
    return result;
  });
  ipcMain.handle(CHANNELS.extensionsChooseDevelopmentEntry, async (event, input: ApproveDevelopmentExtensionInput) => {
    assertRecordFields(input, ["requestId", "expectedRevision"]);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Development adapter", extensions: ["ts", "js", "mjs", "cjs"] }],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const saved = await extensions.approveDevelopmentEntry(input, result.canceled ? undefined : result.filePaths[0]);
    if (saved.status === "saved") await sessions.extensionSettingsChanged();
    return saved;
  });
  ipcMain.handle(CHANNELS.extensionsApply, (_event, input: ApplyDesktopExtensionSetInput) => {
    assertExtensionApplyInput(input);
    return sessions.applyExtensionSet(
      input.projectId,
      input.threadId,
      input.expectedDesiredGeneration,
      input.abortRunning,
    );
  });
  ipcMain.handle(CHANNELS.extensionsGetSessionPlugins, (_event, projectId: string, threadId: string) =>
    sessions.getSessionPluginOptions(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.extensionsApplySessionPlugins, (_event, input: ApplySessionPluginSelectionInput) => {
    assertSessionPluginSelectionInput(input);
    return sessions.applySessionPluginSelection(
      input.projectId,
      input.threadId,
      input.enabledPluginIds,
      input.abortRunning,
    );
  });
  return registered;
}

function assertExtensionApplyInput(input: ApplyDesktopExtensionSetInput): void {
  if (!isRecord(input) || !isNonEmptyString(input.projectId) || !isNonEmptyString(input.threadId)) {
    throw new Error("Invalid extension apply input");
  }
  if (!isNonEmptyString(input.expectedDesiredGeneration) || !isOptionalBoolean(input.abortRunning)) {
    throw new Error("Invalid extension apply input");
  }
}

function assertSessionPluginSelectionInput(input: ApplySessionPluginSelectionInput): void {
  if (!isRecord(input) || !isNonEmptyString(input.projectId) || !isNonEmptyString(input.threadId)) {
    throw new Error("Invalid session plugin selection input");
  }
  if (
    !(
      input.enabledPluginIds === null ||
      (Array.isArray(input.enabledPluginIds) && input.enabledPluginIds.every(isNonEmptyString))
    ) ||
    !isOptionalBoolean(input.abortRunning)
  ) {
    throw new Error("Invalid session plugin selection input");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function assertRecordFields(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid plugin IPC input");
  for (const field of fields) {
    const item = value[field];
    if (field === "enabled") {
      if (typeof item !== "boolean") throw new Error("Invalid plugin IPC input");
    } else if (field === "confirmFullTrust" || field === "confirmRemoval") {
      if (item !== true) throw new Error("Invalid plugin IPC input");
    } else if (field === "values" || field === "mutation") {
      if (!isRecord(item)) throw new Error("Invalid plugin IPC input");
    } else if (!isNonEmptyString(item)) {
      throw new Error("Invalid plugin IPC input");
    }
  }
}
