import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import type {
  AuthOauthLoginInput,
  AuthOauthLoginResponse,
  SaveAuthConfigInput,
} from "../../shared/auth-config-contracts.ts";
import type { SaveAutoTitleSettingsInput } from "../../shared/auto-title-contracts.ts";
import { CHANNELS } from "../../shared/channels.ts";
import type {
  MutateMemoryEntryInput,
  RunMemoryMaintenanceInput,
  SaveMemorySettingsInput,
} from "../../shared/memory-settings-contracts.ts";
import type { SaveModelsConfigInput } from "../../shared/models-config-contracts.ts";
import type { SavePreferencesInput } from "../../shared/preferences-contracts.ts";
import type { SaveSettingsConfigInput } from "../../shared/settings-config-contracts.ts";
import type { GetSubagentSettingsInput, SaveSubagentSettingsInput } from "../../shared/subagent-contracts.ts";
import type { AuthConfigService } from "../auth/auth-config-service.ts";
import { OauthLoginCoordinator } from "../auth/oauth-login-coordinator.ts";
import type { ModelsConfigService } from "../models/models-config-service.ts";
import type { PreferencesConfigService } from "../preferences/preferences-config-service.ts";
import type { ProvidersConfigService } from "../providers/providers-config-service.ts";
import type { AutoTitleSettingsService } from "../settings/auto-title-settings-service.ts";
import type { MemorySettingsService } from "../settings/memory-settings-service.ts";
import type { SettingsConfigService } from "../settings/settings-config-service.ts";
import type { SubagentSettingsConfigService } from "../subagents/subagent-settings-config-service.ts";
import type { WindowDirtyGuard } from "../window-dirty-guard.ts";
import { openPath } from "./ipc-shared.ts";

/** 配置领域 IPC 的核心服务和可选配置服务。 */
export interface SettingsIpcDependencies {
  readonly models: ModelsConfigService;
  readonly auth: AuthConfigService;
  readonly providers: ProvidersConfigService;
  readonly settings: SettingsConfigService;
  readonly dirtyGuard: WindowDirtyGuard;
  readonly preferences?: PreferencesConfigService;
  readonly memorySettings?: MemorySettingsService;
  readonly autoTitle?: AutoTitleSettingsService;
  readonly subagents?: SubagentSettingsConfigService;
  readonly refreshActiveModelRuntimes?: () => Promise<void>;
  readonly refreshMemoryConfiguration?: () => Promise<void>;
}

/** settings registrar 可能注册的 channel 清单。 */
export const SETTINGS_IPC_CHANNELS = [
  CHANNELS.modelsGetConfig,
  CHANNELS.modelsGetConfigRevision,
  CHANNELS.modelsSaveConfig,
  CHANNELS.modelsOpenConfigExternally,
  CHANNELS.authGetConfig,
  CHANNELS.authGetConfigRevision,
  CHANNELS.authSaveConfig,
  CHANNELS.authOpenConfigExternally,
  CHANNELS.authOauthLogin,
  CHANNELS.authOauthRespond,
  CHANNELS.authOauthCancel,
  CHANNELS.providersGetConfig,
  CHANNELS.providersSaveConfig,
  CHANNELS.providersOpenConfigExternally,
  CHANNELS.settingsGetConfig,
  CHANNELS.settingsSaveConfig,
  CHANNELS.preferencesGetInitial,
  CHANNELS.preferencesSave,
  CHANNELS.settingsChooseUserAvatar,
  CHANNELS.memorySettingsGetSnapshot,
  CHANNELS.memorySettingsSaveConfig,
  CHANNELS.memorySettingsMutateEntry,
  CHANNELS.memorySettingsRunMaintenance,
  CHANNELS.autoTitleGetSnapshot,
  CHANNELS.autoTitleSaveConfig,
  CHANNELS.autoTitleGetModelOptions,
  CHANNELS.subagentsGetSnapshot,
  CHANNELS.subagentsSaveConfig,
  CHANNELS.memorySettingsSetEditorDirty,
  CHANNELS.browserSetEditorDirty,
  CHANNELS.autoTitleSetEditorDirty,
  CHANNELS.authSetEditorDirty,
  CHANNELS.modelsSetEditorDirty,
  CHANNELS.providersSetEditorDirty,
] as const;

/** 注册模型、认证、provider、偏好、memory 和 subagent settings IPC。 */
export function registerSettingsIpc(dependencies: SettingsIpcDependencies): readonly string[] {
  const { models, auth, providers, settings, preferences, memorySettings, autoTitle, subagents, dirtyGuard } =
    dependencies;
  const oauthOwners = new Set<number>();
  const oauth = new OauthLoginCoordinator({ login: (providerId, callbacks) => auth.loginOauth(providerId, callbacks) });

  ipcMain.handle(CHANNELS.modelsGetConfig, () => models.getConfig());
  ipcMain.handle(CHANNELS.modelsGetConfigRevision, () => models.getConfigRevision());
  ipcMain.handle(CHANNELS.modelsSaveConfig, async (_event, input: SaveModelsConfigInput) => {
    const result = await models.saveConfig(input);
    if (result.status !== "saved" || !dependencies.refreshActiveModelRuntimes) return result;
    const activeSessionsRefreshed = await refreshActiveModelRuntimes(dependencies.refreshActiveModelRuntimes);
    return { ...result, snapshot: { ...result.snapshot, activeSessionsRefreshed } };
  });
  ipcMain.handle(CHANNELS.modelsOpenConfigExternally, async () => openPath(await models.getExternalOpenTarget()));
  ipcMain.handle(CHANNELS.authGetConfig, () => auth.getConfig());
  ipcMain.handle(CHANNELS.authGetConfigRevision, () => auth.getConfigRevision());
  ipcMain.handle(CHANNELS.authSaveConfig, async (_event, input: SaveAuthConfigInput) => {
    const result = await auth.saveConfig(input);
    if (result.status === "saved" && dependencies.refreshActiveModelRuntimes) {
      await refreshActiveModelRuntimes(dependencies.refreshActiveModelRuntimes);
    }
    return result;
  });
  ipcMain.handle(CHANNELS.authOpenConfigExternally, async () => openPath(await auth.getExternalOpenTarget()));
  ipcMain.handle(CHANNELS.authOauthLogin, (event, input: AuthOauthLoginInput) => {
    const ownerId = event.sender.id;
    if (!oauthOwners.has(ownerId)) {
      oauthOwners.add(ownerId);
      event.sender.once("destroyed", () => {
        oauthOwners.delete(ownerId);
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
        if (dependencies.refreshActiveModelRuntimes)
          await refreshActiveModelRuntimes(dependencies.refreshActiveModelRuntimes);
        return snapshot;
      });
  });
  ipcMain.handle(CHANNELS.authOauthRespond, (event, response: AuthOauthLoginResponse) =>
    oauth.respond(event.sender.id, response),
  );
  ipcMain.handle(CHANNELS.authOauthCancel, (event, loginId: string) => oauth.cancel(event.sender.id, loginId));
  ipcMain.handle(CHANNELS.providersGetConfig, () => providers.getConfig());
  ipcMain.handle(CHANNELS.providersSaveConfig, async (_event, input) => {
    const result = await providers.saveConfig(input);
    if (result.status === "saved" && dependencies.refreshActiveModelRuntimes) {
      await refreshActiveModelRuntimes(dependencies.refreshActiveModelRuntimes);
    }
    return result;
  });
  ipcMain.handle(CHANNELS.providersOpenConfigExternally, async () => openPath(await providers.getExternalOpenTarget()));
  ipcMain.handle(CHANNELS.settingsGetConfig, () => settings.getConfig());
  ipcMain.handle(CHANNELS.settingsSaveConfig, (_event, input: SaveSettingsConfigInput) => settings.saveConfig(input));
  if (preferences) {
    ipcMain.on(CHANNELS.preferencesGetInitial, (event) => {
      event.returnValue = preferences.getInitial();
    });
    ipcMain.handle(CHANNELS.preferencesSave, (_event, input: SavePreferencesInput) => preferences.save(input));
  }
  ipcMain.handle(CHANNELS.settingsChooseUserAvatar, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: OpenDialogOptions = {
      title: "选择用户头像",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  if (memorySettings) {
    ipcMain.handle(CHANNELS.memorySettingsGetSnapshot, () => memorySettings.getSnapshot());
    ipcMain.handle(CHANNELS.memorySettingsSaveConfig, async (_event, input: SaveMemorySettingsInput) => {
      const result = await memorySettings.saveConfig(input);
      if (result.status !== "saved" || !dependencies.refreshMemoryConfiguration) return result;
      try {
        await dependencies.refreshMemoryConfiguration();
        return result;
      } catch (error) {
        console.error("Memory settings were saved, but active sessions failed to refresh:", error);
        const refreshWarning = "设置已保存，但活动会话刷新失败；新会话将使用最新配置。";
        return { ...result, warning: result.warning ? `${result.warning} ${refreshWarning}` : refreshWarning };
      }
    });
    ipcMain.handle(CHANNELS.memorySettingsMutateEntry, (_event, input: MutateMemoryEntryInput) =>
      memorySettings.mutateEntry(input),
    );
    ipcMain.handle(CHANNELS.memorySettingsRunMaintenance, (_event, input: RunMemoryMaintenanceInput) =>
      memorySettings.runMaintenance(input),
    );
  }
  if (autoTitle) {
    ipcMain.handle(CHANNELS.autoTitleGetSnapshot, () => autoTitle.getSnapshot());
    ipcMain.handle(CHANNELS.autoTitleSaveConfig, (_event, input: SaveAutoTitleSettingsInput) =>
      autoTitle.saveConfig(input),
    );
    ipcMain.handle(CHANNELS.autoTitleGetModelOptions, () => autoTitle.getModelOptions());
  }
  if (subagents) {
    ipcMain.handle(CHANNELS.subagentsGetSnapshot, (_event, input?: GetSubagentSettingsInput) =>
      subagents.getSnapshot(input),
    );
    ipcMain.handle(CHANNELS.subagentsSaveConfig, (_event, input: SaveSubagentSettingsInput) =>
      subagents.saveConfig(input),
    );
  }
  registerDirtyEditor(CHANNELS.memorySettingsSetEditorDirty, dirtyGuard);
  registerDirtyEditor(CHANNELS.browserSetEditorDirty, dirtyGuard);
  registerDirtyEditor(CHANNELS.autoTitleSetEditorDirty, dirtyGuard);
  registerDirtyEditor(CHANNELS.authSetEditorDirty, dirtyGuard);
  registerDirtyEditor(CHANNELS.modelsSetEditorDirty, dirtyGuard);
  registerDirtyEditor(CHANNELS.providersSetEditorDirty, dirtyGuard);
  const unavailable = new Set<string>();
  if (!preferences) {
    unavailable.add(CHANNELS.preferencesGetInitial);
    unavailable.add(CHANNELS.preferencesSave);
  }
  if (!memorySettings) {
    unavailable.add(CHANNELS.memorySettingsGetSnapshot);
    unavailable.add(CHANNELS.memorySettingsSaveConfig);
    unavailable.add(CHANNELS.memorySettingsMutateEntry);
    unavailable.add(CHANNELS.memorySettingsRunMaintenance);
  }
  if (!autoTitle) {
    unavailable.add(CHANNELS.autoTitleGetSnapshot);
    unavailable.add(CHANNELS.autoTitleSaveConfig);
    unavailable.add(CHANNELS.autoTitleGetModelOptions);
  }
  if (!subagents) {
    unavailable.add(CHANNELS.subagentsGetSnapshot);
    unavailable.add(CHANNELS.subagentsSaveConfig);
  }
  return SETTINGS_IPC_CHANNELS.filter((channel) => !unavailable.has(channel));
}

function registerDirtyEditor(channel: string, dirtyGuard: WindowDirtyGuard): void {
  const owners = new Set<number>();
  ipcMain.on(channel, (event, dirty: unknown) => {
    if (typeof dirty !== "boolean") {
      event.returnValue = false;
      return;
    }
    const ownerId = event.sender.id;
    dirtyGuard.setDirty(ownerId, dirty);
    if (!owners.has(ownerId)) {
      owners.add(ownerId);
      event.sender.once("destroyed", () => {
        owners.delete(ownerId);
        dirtyGuard.remove(ownerId);
      });
    }
    event.returnValue = true;
  });
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

async function openOauthUrl(target: string): Promise<void> {
  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported OAuth URL protocol");
  await shell.openExternal(url.href);
}
