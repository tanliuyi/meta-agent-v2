import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { app, BrowserWindow, Menu, safeStorage } from "electron";
import { installExtension, REACT_DEVELOPER_TOOLS } from "electron-devtools-installer";
import windowStateKeeper from "electron-window-state";
import { CHANNELS } from "../shared/channels.ts";
import { AuthConfigService } from "./auth/auth-config-service.ts";
import { BrowserDataService } from "./browser/browser-data-service.ts";
import { type BrowserHostServer, createBrowserHostServer } from "./browser/browser-host-server.ts";
import {
  handleBrowserInternalPageRequests,
  registerBrowserInternalScheme,
} from "./browser/browser-internal-page-protocol.ts";
import { BrowserManager } from "./browser/browser-manager.ts";
import { installBrowserWebviewSecurity } from "./browser/browser-webview-policy.ts";
import { FileService } from "./files/file-service.ts";
import { ProjectFileWatcher } from "./files/file-watcher.ts";
import { OfficeDocumentPreviewService } from "./files/office-document-preview-service.ts";
import { handlePdfPreviewRequests, registerPdfPreviewScheme } from "./files/pdf-preview-protocol.ts";
import {
  broadcastBrowserCloseTabRequest,
  broadcastBrowserCreateTabRequest,
  broadcastBrowserEvent,
  broadcastTerminalEvent,
  broadcastThreadCatalogUpdate,
  registerIpc,
  sendBrowserPasswordOffer,
} from "./ipc.ts";
import { FileCredentialStore } from "./models/credential-store.ts";
import { ModelsConfigService } from "./models/models-config-service.ts";
import { SessionSupervisor } from "./pi/session-supervisor.ts";
import { PreferencesConfigService } from "./preferences/preferences-config-service.ts";
import { ProvidersConfigService } from "./providers/providers-config-service.ts";
import { attachRendererCrashRecovery } from "./renderer-crash-recovery.ts";
import { SettingsConfigService } from "./settings/settings-config-service.ts";
import { handleLocalImageRequests, registerLocalImageSchemes } from "./settings/user-avatar-protocol.ts";
import { locateGitForWindowsBash, locateManagedBash } from "./sidecar/managed-shell-locator.ts";
import { MetadataWorkerClient } from "./sidecar/metadata-worker-client.ts";
import { getBashShellConfig, getPiShellPath } from "./sidecar/pi-settings.ts";
import { parseRuntimeSetupSelection, runRuntimeSetup } from "./sidecar/runtime-setup.ts";
import {
  SHELL_RUNTIME_VERSION,
  ShellRuntimeInstaller,
  shellRuntimeInstallUrl,
} from "./sidecar/shell-runtime-installer.ts";
import { saveShellRuntimePath } from "./sidecar/shell-runtime-settings.ts";
import { validateBashRuntime } from "./sidecar/shell-runtime-validator.ts";
import { SidecarLog } from "./sidecar/sidecar-log.ts";
import { loadSidecarRuntimeManifest } from "./sidecar/sidecar-runtime-manifest.ts";
import { ThreadWorkerRegistry } from "./sidecar/thread-worker-registry.ts";
import { ProjectStore } from "./store/project-store.ts";
import { createTerminalShellResolver, TerminalSupervisor } from "./terminal/terminal-supervisor.ts";
import { TrayController } from "./tray.ts";
import { AutoUpdateService, scheduleAutoUpdateChecks } from "./updater.ts";
import { WindowDirtyGuard } from "./window-dirty-guard.ts";

let sessions: SessionSupervisor | undefined;
let metadata: MetadataWorkerClient | undefined;
let sidecarLog: SidecarLog | undefined;
let terminals: TerminalSupervisor | undefined;
let browserManager: BrowserManager | undefined;
let browserHostServer: BrowserHostServer | undefined;
let stopAutoUpdateChecks: (() => void) | undefined;
let quitGuardPending = false;
let applicationShuttingDown = false;
const dirtyGuard = new WindowDirtyGuard({
  beforeReload: (window) => sessions?.detachAll(window.webContents.id),
});
const appDir = dirname(fileURLToPath(import.meta.url));
const trayController = new TrayController({
  platform: process.platform,
  isPackaged: app.isPackaged,
  appDir,
  resourcesPath: process.resourcesPath,
  quit: () => app.quit(),
});
const runtimeSetupSelection = parseRuntimeSetupSelection(process.argv);
const defaultWindowBounds = { width: 1440, height: 920 };
const minimumWindowBounds = { width: 1024, height: 680 };
// 开发实例允许并行启动；发布版保持单实例，避免多个主进程同时管理同一份状态。
const hasSingleInstanceLock = runtimeSetupSelection || !app.isPackaged ? true : app.requestSingleInstanceLock();

registerLocalImageSchemes();
registerPdfPreviewScheme();
registerBrowserInternalScheme();

if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.ELECTRON_REMOTE_DEBUGGING_PORT ?? "9222");
}

/** 在开发环境加载 React DevTools，生产构建不下载开发扩展。 */
async function installReactDevTools(): Promise<void> {
  if (app.isPackaged || process.env.PI_DISABLE_REACT_DEVTOOLS === "1") return;

  try {
    const extensions = await installExtension(REACT_DEVELOPER_TOOLS, {
      loadExtensionOptions: { allowFileAccess: true },
    });
    console.info(`React DevTools 已加载: ${extensions.name}`);
  } catch (error) {
    console.warn("React DevTools 加载失败:", error);
  }
}

/** 创建主工作台窗口。 */
function createWindow(): void {
  const windowState = windowStateKeeper({
    defaultWidth: defaultWindowBounds.width,
    defaultHeight: defaultWindowBounds.height,
  });
  const window = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: minimumWindowBounds.width,
    minHeight: minimumWindowBounds.height,
    show: false,
    frame: process.platform !== "win32",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 12 } : undefined,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(appDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,
      // IAB 内置浏览器面板依赖 renderer 侧 <webview> 标签；保持其余隔离默认不变。
      webviewTag: true,
    },
  });
  windowState.manage(window);

  dirtyGuard.attach(window);
  trayController.attach(window);
  const detachCrashRecovery = attachRendererCrashRecovery(window, {
    isShuttingDown: () => applicationShuttingDown,
    reload: (crashedWindow) => {
      const webContentsId = crashedWindow.webContents.id;
      dirtyGuard.remove(webContentsId);
      sessions?.detachAll(webContentsId);
      crashedWindow.webContents.reload();
    },
    quit: (crashedWindow) => {
      dirtyGuard.remove(crashedWindow.webContents.id);
      app.quit();
    },
    report: (message, error) => {
      if (error === undefined) console.error(message);
      else console.error(message, error);
      sidecarLog?.write("main", error === undefined ? message : `${message}: ${String(error)}`);
    },
  });
  window.once("closed", detachCrashRecovery);
  window.once("ready-to-show", () => window.show());
  window.on("maximize", () => window.webContents.send(CHANNELS.windowMaximizedChanged, true));
  window.on("unmaximize", () => window.webContents.send(CHANNELS.windowMaximizedChanged, false));
  const removeBrowserWebviewSecurity = installBrowserWebviewSecurity(
    window.webContents,
    join(appDir, "../preload/browser-internal.cjs"),
  );
  window.once("closed", removeBrowserWebviewSecurity);
  window.webContents.on("preload-error", (_event, path, error) => {
    console.error(`Preload 加载失败: ${path}`, error);
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const key = input.key.toLowerCase();
    const isReloadKey = input.code === "KeyR" || key === "r";
    const isDevToolsKey = input.code === "KeyI" || key === "i";
    const isMac = process.platform === "darwin";
    const hasPrimaryModifier = isMac ? input.meta : input.control;
    const hasConflictingModifier = isMac ? input.control : input.meta;
    if (!hasPrimaryModifier || hasConflictingModifier) return;

    if (isReloadKey && !input.alt && !input.shift) {
      event.preventDefault();
      void dirtyGuard.requestReload(window);
    } else if (isDevToolsKey && (isMac ? input.alt && !input.shift : input.shift && !input.alt)) {
      event.preventDefault();
      window.webContents.toggleDevTools();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(appDir, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  handleLocalImageRequests();
  handleBrowserInternalPageRequests(join(appDir, "../renderer"), process.env.ELECTRON_RENDERER_URL);
  Menu.setApplicationMenu(null);
  const userDataDir = app.getPath("userData");
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  if (runtimeSetupSelection) {
    try {
      await runRuntimeSetup(userDataDir, agentDir, runtimeSetupSelection);
      app.exit(0);
    } catch (error) {
      console.error("Runtime setup failed:", error);
      app.exit(1);
    }
    return;
  }
  const reactDevToolsInstall = installReactDevTools();
  const shellInstaller = new ShellRuntimeInstaller(userDataDir, () => undefined);
  const managedBashPath = locateManagedBash({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir,
  });
  const installedBashPath = shellInstaller.installedBashPath();
  const desktopBashPath = managedBashPath ?? installedBashPath ?? locateGitForWindowsBash();
  const generalWorkspaceCwd = join(userDataDir, "workspaces", "general");
  const projects = new ProjectStore(
    join(userDataDir, "desktop-state.json"),
    join(agentDir, "projects.json"),
    generalWorkspaceCwd,
  );
  const files = new FileService(projects);
  handlePdfPreviewRequests(projects);
  const projectsLoad = projects.load();
  sidecarLog = new SidecarLog(userDataDir);
  sidecarLog.write("main", `Sidecar log initialized at ${sidecarLog.path}`);
  const models = new ModelsConfigService(agentDir, {
    log: (text) => sidecarLog?.write("models", text),
  });
  const credentialStore = new FileCredentialStore(join(agentDir, "auth.json"));
  const authModels = createModels({ credentials: credentialStore });
  for (const provider of builtinProviders()) authModels.setProvider(provider);
  const settings = new SettingsConfigService(userDataDir);
  const preferences = new PreferencesConfigService(userDataDir);
  await Promise.all([projectsLoad, reactDevToolsInstall]);
  const auth = new AuthConfigService(agentDir, {
    log: (text) => sidecarLog?.write("auth", text),
    models: authModels,
  });
  const updater = new AutoUpdateService({ app });
  const runtimeManifest = loadSidecarRuntimeManifest({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir,
  });
  metadata = new MetadataWorkerClient(runtimeManifest, agentDir, userDataDir, (scope, text) =>
    sidecarLog?.write(scope, text),
  );
  const metadataClient = metadata;
  // supervisor 在 registry 之后才能构造；回调必须容忍赋值前被触发，避免 ack 饿死。
  let supervisor: SessionSupervisor | undefined;
  let browserManagerInstance: BrowserManager | undefined;
  const workers = new ThreadWorkerRegistry({
    manifest: runtimeManifest,
    metadata: metadataClient,
    userDataDir,
    agentDir,
    ...(desktopBashPath ? { shellPath: desktopBashPath } : {}),
    getCwd: (projectId) => projects.getCwd(projectId),
    resolveSessionCwd: (projectId, cwd) => projects.resolveSessionCwd(projectId, cwd),
    push: (payload, workerInstanceId, sidecarSequence, payloadJsonLength) => {
      if (supervisor) supervisor.receive(payload, workerInstanceId, sidecarSequence, payloadJsonLength);
      else workers.acknowledge(workerInstanceId, sidecarSequence);
    },
    failed: (projectId, threadId, error) => {
      console.error(`Pi sidecar failed for ${projectId}/${threadId}:`, error);
      supervisor?.workerFailed(projectId, threadId, error);
    },
    resync: (projectId, threadId, reason) => supervisor?.resyncRequired(projectId, threadId, reason),
    catalogChanged: broadcastThreadCatalogUpdate,
    log: (scope, text) => sidecarLog?.write(scope, text),
    registerBrowserSession: (identity) => browserManagerInstance?.registerSession(identity),
    revokeBrowserSession: (_identity, token) => browserManagerInstance?.revokeSessionCapability(token),
  });
  const startedSupervisor = new SessionSupervisor(projects, workers, {
    log: (scope, text) => sidecarLog?.write(scope, text),
  });
  supervisor = startedSupervisor;
  sessions = startedSupervisor;
  terminals = new TerminalSupervisor(
    projects,
    broadcastTerminalEvent,
    createTerminalShellResolver(agentDir, desktopBashPath),
    (projectId, threadId) => workers.getSessionCwd(projectId, threadId),
  );
  const providers = new ProvidersConfigService(models, auth);
  const browserDataService = new BrowserDataService(userDataDir, {
    crypto: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    },
    log: (text) => sidecarLog?.write("browser", text),
  });
  browserManagerInstance = new BrowserManager(userDataDir, {
    onStateChanged: broadcastBrowserEvent,
    onCreateTabRequest: broadcastBrowserCreateTabRequest,
    onCloseTabRequest: broadcastBrowserCloseTabRequest,
    onPasswordOffer: sendBrowserPasswordOffer,
    data: browserDataService,
    onSessionCreated: (browserSession) =>
      handleBrowserInternalPageRequests(join(appDir, "../renderer"), process.env.ELECTRON_RENDERER_URL, browserSession),
    log: (text) => sidecarLog?.write("browser", text),
  });
  browserManager = browserManagerInstance;
  const browserHostServerInstance = await createBrowserHostServer(browserManagerInstance, {
    log: (text) => sidecarLog?.write("browser-host", text),
  });
  browserHostServer = browserHostServerInstance;
  const browserEndpoint = browserHostServerInstance.getEndpoint();
  if (browserEndpoint) {
    // sidecar 的 env 白名单放行 PI_* 前缀（保留 PI_DESKTOP_*），以此中转注入。
    process.env.PI_BROWSER_HOST_PORT = String(browserEndpoint.port);
    process.env.PI_BROWSER_TOKEN = browserEndpoint.token;
  }
  let modelConfigurationGeneration = 0;
  registerIpc(
    projects,
    sessions,
    files,
    new OfficeDocumentPreviewService(projects, {
      cacheDir: join(userDataDir, "cache", "office-document-preview"),
      getConfiguration: async () => ({
        binaryPath: process.env.PI_OFFICECLI_BINARY_PATH,
        dataDir: process.env.PI_OFFICECLI_DATA_DIR,
        version: process.env.PI_OFFICECLI_VERSION,
        autoDownload: process.env.PI_OFFICECLI_AUTO_DOWNLOAD !== "0",
      }),
    }),
    new ProjectFileWatcher(projects, (change) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CHANNELS.filesChanged, change);
      }
    }),
    terminals,
    models,
    auth,
    providers,
    settings,
    dirtyGuard,
    {
      refreshActiveModelRuntimes: async () => {
        modelConfigurationGeneration += 1;
        const revision = { generation: modelConfigurationGeneration };
        await workers.refreshAllModels(revision);
      },
      shell: {
        getStatus: async () => {
          const activeProject = await projects.getActive();
          const cwd = activeProject?.cwd ?? process.cwd();
          const configuredShellPath = getPiShellPath(cwd, agentDir);
          const shellPath = configuredShellPath ?? desktopBashPath;
          if (!shellPath) {
            return {
              state: "missing" as const,
              message: "未找到 Git for Windows；WSL bash 不支持",
              installUrl: shellRuntimeInstallUrl(),
            };
          }
          try {
            const shell = getBashShellConfig(shellPath).shell;
            const runtime = await validateBashRuntime(shell);
            return {
              state: "ready" as const,
              path: runtime.path,
              version: shell === shellInstaller.installedBashPath() ? SHELL_RUNTIME_VERSION : runtime.version,
              message: `Git Bash ${runtime.version} 可用`,
              installUrl: shellRuntimeInstallUrl(),
            };
          } catch (error) {
            return {
              state: configuredShellPath ? ("invalid" as const) : ("missing" as const),
              path: shellPath,
              message: error instanceof Error ? error.message : String(error),
              installUrl: shellRuntimeInstallUrl(),
            };
          }
        },
        install: async () => {
          const activeProject = await projects.getActive();
          const cwd = activeProject?.cwd ?? process.cwd();
          const status = await shellInstaller.install();
          if (!status.path) throw new Error("Git Bash 安装完成但未返回可执行文件路径");
          await saveShellRuntimePath(cwd, agentDir, status.path);
          return status;
        },
        use: async (path) => {
          const activeProject = await projects.getActive();
          const cwd = activeProject?.cwd ?? process.cwd();
          const runtime = await validateBashRuntime(path);
          await saveShellRuntimePath(cwd, agentDir, runtime.path);
          return {
            state: "ready" as const,
            path: runtime.path,
            version: runtime.version,
            message: `Git Bash ${runtime.version} 可用`,
            installUrl: shellRuntimeInstallUrl(),
          };
        },
        onProgress: (listener) => shellInstaller.onProgress(listener),
      },
    },
    updater,
    preferences,
    browserManagerInstance,
  );
  createWindow();
  stopAutoUpdateChecks = scheduleAutoUpdateChecks(updater);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
  trayController.markQuitting();
  if (!dirtyGuard.isApplicationQuitConfirmed() && dirtyGuard.hasDirtyWindows(BrowserWindow.getAllWindows())) {
    event.preventDefault();
    if (!quitGuardPending) {
      quitGuardPending = true;
      void dirtyGuard
        .confirmApplicationQuit(BrowserWindow.getAllWindows())
        .then((confirmed) => {
          if (confirmed) app.quit();
        })
        .finally(() => {
          quitGuardPending = false;
        });
    }
    return;
  }
  stopAutoUpdateChecks?.();
  stopAutoUpdateChecks = undefined;
  applicationShuttingDown = true;
  trayController.dispose();
  if (!sessions && !metadata && !sidecarLog && !terminals) return;
  sidecarLog?.write("main", "Desktop shutdown started");
  event.preventDefault();
  const currentSessions = sessions;
  const currentMetadata = metadata;
  const currentSidecarLog = sidecarLog;
  const currentTerminals = terminals;
  sessions = undefined;
  metadata = undefined;
  sidecarLog = undefined;
  terminals = undefined;
  browserManager?.dispose();
  browserManager = undefined;
  void browserHostServer?.dispose();
  browserHostServer = undefined;
  currentTerminals?.dispose();
  void (async () => {
    await currentSessions
      ?.dispose()
      .catch((error: unknown) => console.error("Failed to stop Pi thread workers:", error));
    await currentMetadata
      ?.dispose()
      .catch((error: unknown) => console.error("Failed to stop Pi metadata worker:", error));
    await currentSidecarLog?.dispose().catch((error: unknown) => console.error("Failed to close sidecar log:", error));
  })().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
