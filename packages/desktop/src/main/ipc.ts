import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  type OpenDialogOptions,
  shell,
  webContents,
} from "electron";
import type {
  AuthOauthLoginInput,
  AuthOauthLoginResponse,
  SaveAuthConfigInput,
} from "../shared/auth-config-contracts.ts";
import type {
  BrowserCloseTabRequest,
  BrowserCreateTabRequest,
  BrowserSessionIdentity,
  BrowserStateEvent,
} from "../shared/browser-contracts.ts";
import type {
  BrowserContactInput,
  BrowserPasswordInput,
  BrowserPasswordOffer,
  BrowserSitePermissionInput,
} from "../shared/browser-data-contracts.ts";
import { parseBrowserInternalPage } from "../shared/browser-internal-contracts.ts";
import type { SaveBrowserSettingsInput } from "../shared/browser-settings-contracts.ts";
import { CHANNELS } from "../shared/channels.ts";
import type {
  HostResponse,
  OpenLinkResult,
  SessionAttachInput,
  SessionControlState,
  SessionCreateInput,
  SessionForkInput,
  SessionPromptInput,
  SessionRemovePolicy,
  TerminalEvent,
  Thread,
  WorkbenchState,
} from "../shared/contracts.ts";
import type { ShellRuntimeProgress, ShellRuntimeStatus } from "../shared/desktop-api.ts";
import { filePathWithoutLocation } from "../shared/file-location.ts";
import type { SaveModelsConfigInput } from "../shared/models-config-contracts.ts";
import type { SavePreferencesInput } from "../shared/preferences-contracts.ts";
import type { SaveSettingsConfigInput } from "../shared/settings-config-contracts.ts";
import type { AuthConfigService } from "./auth/auth-config-service.ts";
import { OauthLoginCoordinator } from "./auth/oauth-login-coordinator.ts";
import type { BrowserManager } from "./browser/browser-manager.ts";
import type { FileService } from "./files/file-service.ts";
import type { ProjectFileWatcher } from "./files/file-watcher.ts";
import type { OfficeDocumentPreviewService } from "./files/office-document-preview-service.ts";
import type { ModelsConfigService } from "./models/models-config-service.ts";
import type { SessionSupervisor } from "./pi/session-supervisor.ts";
import type { PreferencesConfigService } from "./preferences/preferences-config-service.ts";
import type { ProvidersConfigService } from "./providers/providers-config-service.ts";
import type { SettingsConfigService } from "./settings/settings-config-service.ts";
import type { ProjectStore } from "./store/project-store.ts";
import type { TerminalSupervisor } from "./terminal/terminal-supervisor.ts";
import type { AutoUpdateService } from "./updater.ts";
import type { WindowDirtyGuard } from "./window-dirty-guard.ts";

/** 注册 Desktop 的 Project、Pi session、文件和 Workbench IPC。 */
const authEditorWebContents = new Set<number>();
const providerEditorWebContents = new Set<number>();
const browserEditorWebContents = new Set<number>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function handleTrustedBrowserDataRequest<T>(event: IpcMainInvokeEvent, request: () => T): T {
  const isMainRenderer =
    Boolean(BrowserWindow.fromWebContents(event.sender)) && event.senderFrame === event.sender.mainFrame;
  const isInternalPage = parseBrowserInternalPage(event.senderFrame?.url) !== null;
  if (!isMainRenderer && !isInternalPage) throw new Error("拒绝非受信页面访问浏览器内部数据");
  return request();
}

export function registerIpc(
  projects: ProjectStore,
  sessions: SessionSupervisor,
  files: FileService,
  officeDocuments: OfficeDocumentPreviewService,
  fileWatcher: ProjectFileWatcher,
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
  preferences?: PreferencesConfigService,
  browser?: BrowserManager,
): void {
  const subscribedWebContents = new Set<number>();
  const modelEditorWebContents = new Set<number>();
  const oauthWebContents = new Set<number>();
  const browserSessionOwnerWebContents = new Set<number>();
  const officePreviewWebContents = new Set<number>();
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
  if (preferences) {
    ipcMain.on(CHANNELS.preferencesGetInitial, (event) => {
      event.returnValue = preferences.getInitial();
    });
    ipcMain.handle(CHANNELS.preferencesSave, (_event, input: SavePreferencesInput) => preferences.save(input));
  }
  if (browser) {
    ipcMain.handle(
      CHANNELS.browserAttach,
      (_event, identity: BrowserSessionIdentity, webContentsId: number, requestId?: number) =>
        browser.attach(identity, webContentsId, requestId),
    );
    ipcMain.handle(CHANNELS.browserDetach, (_event, identity: BrowserSessionIdentity, webContentsId: number) =>
      browser.detach(identity, webContentsId),
    );
    ipcMain.handle(CHANNELS.browserTabSelect, (_event, identity: BrowserSessionIdentity, tabId: number) =>
      browser.selectTab(identity, tabId),
    );
    ipcMain.handle(CHANNELS.browserNavigate, (_event, identity: BrowserSessionIdentity, tabId: number, url: string) =>
      browser.navigate(identity, tabId, url),
    );
    ipcMain.handle(CHANNELS.browserScreenshot, (_event, identity: BrowserSessionIdentity, tabId: number) =>
      browser.screenshot(identity, tabId),
    );
    ipcMain.handle(CHANNELS.browserCopyScreenshot, (_event, identity: BrowserSessionIdentity, tabId: number) =>
      browser.copyScreenshot(identity, tabId),
    );
    ipcMain.handle(
      CHANNELS.browserSnapshot,
      (_event, identity: BrowserSessionIdentity, tabId: number, opts?: { withScreenshot?: boolean }) =>
        browser.snapshot(identity, tabId, opts),
    );
    ipcMain.handle(CHANNELS.browserAction, (_event, identity: BrowserSessionIdentity, tabId: number, action) =>
      browser.action(identity, tabId, action),
    );
    ipcMain.handle(CHANNELS.browserTabsList, (_event, identity: BrowserSessionIdentity) => browser.tabsList(identity));
    ipcMain.handle(CHANNELS.browserSettingsGet, () => browser.getSettingsSnapshot());
    ipcMain.handle(CHANNELS.browserSettingsSave, (_event, input: SaveBrowserSettingsInput) =>
      browser.saveSettings(input),
    );
    ipcMain.handle(CHANNELS.browserSessionRetire, (event, identity: BrowserSessionIdentity) =>
      browser.retireSession(identity, event.sender.id),
    );
    ipcMain.handle(CHANNELS.browserSessionAcquire, (event, identity: BrowserSessionIdentity) => {
      const ownerId = event.sender.id;
      if (!browserSessionOwnerWebContents.has(ownerId)) {
        browserSessionOwnerWebContents.add(ownerId);
        event.sender.once("destroyed", () => {
          browserSessionOwnerWebContents.delete(ownerId);
          browser.releaseOwner(ownerId);
        });
      }
      browser.acquireSession(identity, ownerId);
    });
    ipcMain.handle(CHANNELS.browserClearData, (_event, identity: BrowserSessionIdentity) =>
      browser.clearSessionData(identity),
    );
    ipcMain.handle(CHANNELS.browserClearAllData, () => browser.clearAllData());
    ipcMain.handle(CHANNELS.browserHistory, (_event, identity: BrowserSessionIdentity) =>
      browser.browserHistory(identity),
    );
    ipcMain.handle(CHANNELS.browserOpenDownloads, async () => {
      const error = await shell.openPath(app.getPath("downloads"));
      return error ? { ok: false as const, error } : { ok: true as const };
    });
    ipcMain.handle(
      CHANNELS.browserAnnotationPick,
      (_event, identity: BrowserSessionIdentity, tabId: number, x: number, y: number) =>
        browser.pickAnnotationTarget(identity, tabId, x, y),
    );
    ipcMain.handle(CHANNELS.browserAnnotationAdd, (_event, identity: BrowserSessionIdentity, tabId: number, input) =>
      browser.addAnnotation(identity, tabId, input),
    );
    ipcMain.handle(CHANNELS.browserAnnotationList, (_event, identity: BrowserSessionIdentity, tabId: number) =>
      browser.listAnnotations(identity, tabId),
    );
    ipcMain.handle(
      CHANNELS.browserAnnotationRemove,
      (_event, identity: BrowserSessionIdentity, tabId: number, id: string) =>
        browser.removeAnnotation(identity, tabId, id),
    );
    ipcMain.handle(CHANNELS.browserAnnotationRemoveMany, (_event, identity: BrowserSessionIdentity, ids: string[]) =>
      browser.removeAnnotations(identity, ids),
    );
    ipcMain.handle(
      CHANNELS.browserAnnotationUpdate,
      (_event, identity: BrowserSessionIdentity, tabId: number, id: string, input) =>
        browser.updateAnnotation(identity, tabId, id, input),
    );
    ipcMain.handle(
      CHANNELS.browserAnnotationResolve,
      (_event, identity: BrowserSessionIdentity, tabId: number, id: string) =>
        browser.resolveAnnotationBounds(identity, tabId, id),
    );
    ipcMain.handle(CHANNELS.browserDataGet, (event, includePasswords?: boolean) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserDataGet(includePasswords === true)),
    );
    ipcMain.handle(CHANNELS.browserHistoryDelete, (event, url: string, timestamp: number) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserHistoryDelete(url, timestamp)),
    );
    ipcMain.handle(CHANNELS.browserHistoryClear, (event) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserHistoryClear()),
    );
    ipcMain.handle(CHANNELS.browserDownloadsClear, (event) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserDownloadsClear()),
    );
    ipcMain.handle(CHANNELS.browserDownloadReveal, (event, path: string) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserDownloadReveal(path)),
    );
    ipcMain.handle(CHANNELS.browserDownloadOpen, (event, path: string) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserDownloadOpen(path)),
    );
    ipcMain.handle(
      CHANNELS.browserContactSave,
      (event, input: { contactId: string | null; contact: BrowserContactInput }) =>
        handleTrustedBrowserDataRequest(event, () => browser.browserContactSave(input)),
    );
    ipcMain.handle(CHANNELS.browserContactDelete, (event, id: string) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserContactDelete(id)),
    );
    ipcMain.handle(
      CHANNELS.browserPasswordSave,
      (event, input: { passwordId: string | null; password: BrowserPasswordInput }) =>
        handleTrustedBrowserDataRequest(event, () => browser.browserPasswordSave(input)),
    );
    ipcMain.handle(CHANNELS.browserPasswordDelete, (event, id: string) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserPasswordDelete(id)),
    );
    ipcMain.handle(CHANNELS.browserSitePermissionSave, (event, input: BrowserSitePermissionInput) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserSitePermissionSave(input)),
    );
    ipcMain.handle(CHANNELS.browserSitePermissionDelete, (event, id: string) =>
      handleTrustedBrowserDataRequest(event, () => browser.browserSitePermissionDelete(id)),
    );
    ipcMain.handle(
      CHANNELS.browserPasswordOfferResolve,
      (event, identity: BrowserSessionIdentity, offerId: string, save: boolean) =>
        browser.browserPasswordOfferResolve(identity, offerId, save, event.sender.id),
    );
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
  ipcMain.on(CHANNELS.browserSetEditorDirty, (event, dirty: unknown) => {
    if (typeof dirty !== "boolean") {
      event.returnValue = false;
      return;
    }
    const ownerId = event.sender.id;
    dirtyGuard.setDirty(ownerId, dirty);
    if (!browserEditorWebContents.has(ownerId)) {
      browserEditorWebContents.add(ownerId);
      event.sender.once("destroyed", () => {
        browserEditorWebContents.delete(ownerId);
        dirtyGuard.remove(ownerId);
      });
    }
    event.returnValue = true;
  });

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
  ipcMain.handle(CHANNELS.projectsRemove, async (_event, projectId: string) => {
    terminals.disposeProject(projectId);
    return projects.remove(projectId);
  });
  ipcMain.handle(CHANNELS.projectsWorktrees, (_event, projectId: string) => projects.listWorktrees(projectId));

  ipcMain.handle(CHANNELS.sessionsList, (_event, projectId: string, includeArchived?: boolean) =>
    sessions.list(projectId, includeArchived),
  );
  ipcMain.handle(CHANNELS.sessionsListWithPaths, (_event, projectId: string) => sessions.listWithPaths(projectId));
  ipcMain.handle(CHANNELS.sessionsDraftConfig, (_event, projectId: string) => sessions.getDraftConfig(projectId));
  ipcMain.handle(CHANNELS.sessionsCreate, (_event, input: SessionCreateInput) => sessions.create(input));
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
  ipcMain.handle(CHANNELS.sessionsClose, (event, projectId: string, threadId: string) =>
    sessions.close(event.sender.id, projectId, threadId),
  );
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
  ipcMain.handle(
    CHANNELS.sessionsRemove,
    async (_event, projectId: string, threadId: string, policy: SessionRemovePolicy) => {
      if (policy !== "subtree" && policy !== "reparent") throw new Error(`Invalid session removal policy: ${policy}`);
      const result = await sessions.remove(projectId, threadId, policy);
      for (const removedThreadId of result.removedThreadIds) terminals.disposeSession(projectId, removedThreadId);
      return result;
    },
  );
  ipcMain.handle(CHANNELS.sessionsPromote, (_event, projectId: string, threadId: string) =>
    sessions.promote(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.sessionsPrompt, (_event, input: SessionPromptInput) => sessions.prompt(input));
  ipcMain.handle(CHANNELS.sessionsFork, (_event, input: SessionForkInput) => sessions.fork(input));
  ipcMain.handle(CHANNELS.sessionsCancel, (_event, projectId: string, threadId: string) =>
    sessions.cancel(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.sessionsCompact, (_event, projectId: string, threadId: string) =>
    sessions.compact(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.sessionsReload, (_event, projectId: string, threadId: string) =>
    sessions.reload(projectId, threadId),
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
  ipcMain.handle(CHANNELS.sessionsReadImageResource, (event, attachmentId: string, resourceId: string) => {
    if (typeof attachmentId !== "string" || typeof resourceId !== "string" || !UUID_PATTERN.test(resourceId)) {
      throw new Error("Invalid image resource request");
    }
    return sessions.readImageResource(event.sender.id, attachmentId, resourceId);
  });
  ipcMain.handle(CHANNELS.filesList, (event, projectId: string, path?: string, query?: string, requestGroup?: string) =>
    files.list(projectId, path, query, `${event.sender.id}\0${requestGroup ?? "default"}`),
  );
  ipcMain.handle(CHANNELS.filesRead, (_event, projectId: string, path: string) => files.read(projectId, path));
  ipcMain.handle(CHANNELS.filesReadImage, (_event, projectId: string, path: string) =>
    files.readImage(projectId, path),
  );
  ipcMain.handle(CHANNELS.filesPreviewPdf, (_event, projectId: string, path: string) =>
    files.previewPdf(projectId, path),
  );
  ipcMain.handle(CHANNELS.filesPreviewOfficeDocument, (event, projectId: string, path: string) => {
    const ownerId = event.sender.id;
    if (!officePreviewWebContents.has(ownerId)) {
      officePreviewWebContents.add(ownerId);
      event.sender.once("destroyed", () => {
        officePreviewWebContents.delete(ownerId);
        officeDocuments.cancelOwner(ownerId);
      });
    }
    return officeDocuments.preview(ownerId, projectId, path);
  });
  ipcMain.handle(CHANNELS.filesCancelOfficeDocumentPreview, (event) => {
    officeDocuments.cancelOwner(event.sender.id);
  });
  ipcMain.handle(CHANNELS.filesWatch, (_event, projectId: string) => fileWatcher.watch(projectId));
  ipcMain.handle(CHANNELS.filesUnwatch, (_event, projectId: string) => fileWatcher.unwatch(projectId));
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
  ipcMain.handle(CHANNELS.terminalsDispose, (_event, projectId: string, threadId: string, terminalId: string) =>
    terminals.disposeTerminal(projectId, threadId, terminalId),
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

async function refreshActiveModelRuntimes(refresh: () => Promise<void>): Promise<boolean> {
  try {
    await refresh();
    return true;
  } catch (error) {
    console.error("Model configuration was saved, but one or more active runtimes failed to refresh:", error);
    return false;
  }
}

async function openLink(projectId: string, target: string, projects: ProjectStore): Promise<OpenLinkResult> {
  const value = target.trim();
  if (!value) throw new Error("Cannot open an empty link");

  const localTarget = value.split(/[?#]/, 1)[0];
  if (!localTarget) throw new Error("Cannot open a link without a file path");
  if (isAbsolute(localTarget)) {
    return openLocalPath(projectId, decodeURIComponent(localTarget), projects);
  }

  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    return openLocalPath(projectId, resolve(projects.getCwd(projectId), decodeURIComponent(localTarget)), projects);
  }

  if (url.protocol === "file:") {
    return openLocalPath(projectId, fileURLToPath(url), projects);
  }

  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:") {
    await shell.openExternal(url.href);
    return { openInApp: false };
  }

  throw new Error(`Unsupported link protocol: ${url.protocol}`);
}

/** 打开项目内文件链接时，兼容 `path:line` 这类源代码位置标记。 */
function normalizeLocalFilePath(path: string): string {
  const pathWithoutLocation = filePathWithoutLocation(path);
  if (pathWithoutLocation === path) return path;

  // 真实文件名可能包含冒号；只有完整路径不存在而去掉后缀的文件存在时才解析位置标记。
  try {
    if (statSync(path).isFile()) return path;
  } catch {
    // 继续检查去掉位置标记后的候选路径。
  }
  try {
    if (statSync(pathWithoutLocation).isFile()) return pathWithoutLocation;
  } catch {
    // 保留原路径，让调用方报告真实的文件错误。
  }
  return path;
}

/** 打开本地文件路径：位于项目 cwd 内时交回应用内打开，否则交给系统默认程序。 */
async function openLocalPath(projectId: string, absolutePath: string, projects: ProjectStore): Promise<OpenLinkResult> {
  const normalizedPath = normalizeLocalFilePath(absolutePath);
  const cwd = projects.getCwd(projectId);
  const rel = relative(cwd, normalizedPath);
  if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    // 目录链接应用内无法打开（文件面板仅支持文件），交回系统文件管理器。
    let isDirectory = false;
    try {
      isDirectory = statSync(resolve(cwd, rel)).isDirectory();
    } catch {
      // 路径不存在或不可访问：保持应用内打开，由读取侧报错。
    }
    if (!isDirectory) return { openInApp: true, path: rel.split(sep).join("/") };
  }
  await openPath(normalizedPath);
  return { openInApp: false };
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

/** 向所有 renderer 广播内置浏览器状态（会话 + tabs/活跃 tab）。 */
export function broadcastBrowserEvent(event: BrowserStateEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.browserStateChanged, event);
  }
}

/** 向所有 renderer 广播建 tab 请求（工具 browser.open 等触发；携带会话身份）。 */
export function broadcastBrowserCreateTabRequest(request: BrowserCreateTabRequest): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.browserCreateTabRequest, request);
  }
}

/** 向所有 renderer 广播关闭 tab 请求（工具 browser.close 触发；renderer 负责删除视图）。 */
export function broadcastBrowserCloseTabRequest(request: BrowserCloseTabRequest): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.browserCloseTabRequest, request);
  }
}

/** 只向提交表单所属的 renderer 发送无密码正文的保存请求。 */
export function sendBrowserPasswordOffer(offer: BrowserPasswordOffer, ownerWebContentsId: number): void {
  const owner = webContents.fromId(ownerWebContentsId);
  if (owner && !owner.isDestroyed()) owner.send(CHANNELS.browserPasswordOffer, offer);
}
