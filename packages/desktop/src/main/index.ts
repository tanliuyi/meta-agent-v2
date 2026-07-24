import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu } from "electron";
import { installExtension, REACT_DEVELOPER_TOOLS } from "electron-devtools-installer";
import windowStateKeeper from "electron-window-state";
import { CHANNELS } from "../shared/channels.ts";
import { AuthConfigService } from "./auth/auth-config-service.ts";
import { DesktopControlledExtensionRegistry } from "./extensions/desktop-extension-registry.ts";
import { DesktopExtensionSettingsService } from "./extensions/desktop-extension-settings-service.ts";
import { DesktopExtensionSourcePolicy } from "./extensions/desktop-extension-source-policy.ts";
import { FileService } from "./files/file-service.ts";
import { broadcastTerminalEvent, registerIpc } from "./ipc.ts";
import { ModelsConfigService } from "./models/models-config-service.ts";
import { SessionSupervisor } from "./pi/session-supervisor.ts";
import { SettingsConfigService } from "./settings/settings-config-service.ts";
import { MetadataWorkerClient } from "./sidecar/metadata-worker-client.ts";
import { NodeRuntimeInstaller } from "./sidecar/node-runtime-installer.ts";
import {
  detectNodeRuntime,
  loadNodeRuntimeManifest,
  type NodeRuntimeManifest,
} from "./sidecar/node-runtime-locator.ts";
import { SidecarLog } from "./sidecar/sidecar-log.ts";
import { SubagentWorkerRegistry } from "./sidecar/subagent-worker-registry.ts";
import { ThreadWorkerRegistry } from "./sidecar/thread-worker-registry.ts";
import { ProjectStore } from "./store/project-store.ts";
import { TerminalSupervisor } from "./terminal/terminal-supervisor.ts";
import { AutoUpdateService, scheduleAutoUpdateChecks } from "./updater.ts";
import { WindowDirtyGuard } from "./window-dirty-guard.ts";

let sessions: SessionSupervisor | undefined;
let metadata: MetadataWorkerClient | undefined;
let sidecarLog: SidecarLog | undefined;
let subagents: SubagentWorkerRegistry | undefined;
let terminals: TerminalSupervisor | undefined;
let stopAutoUpdateChecks: (() => void) | undefined;
let quitGuardPending = false;
const dirtyGuard = new WindowDirtyGuard({
  beforeReload: (window) => sessions?.detachAll(window.webContents.id),
});
const appDir = dirname(fileURLToPath(import.meta.url));
const defaultWindowBounds = { width: 1440, height: 920 };
const minimumWindowBounds = { width: 1024, height: 680 };
// 开发实例允许并行启动；发布版保持单实例，避免多个主进程同时管理同一份状态。
const hasSingleInstanceLock = app.isPackaged ? app.requestSingleInstanceLock() : true;

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
  if (app.isPackaged) return;

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
    trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 16 } : undefined,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(appDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowState.manage(window);

  dirtyGuard.attach(window);
  window.once("ready-to-show", () => window.show());
  window.on("maximize", () => window.webContents.send(CHANNELS.windowMaximizedChanged, true));
  window.on("unmaximize", () => window.webContents.send(CHANNELS.windowMaximizedChanged, false));
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
  Menu.setApplicationMenu(null);
  const userDataDir = app.getPath("userData");
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const projects = new ProjectStore(join(userDataDir, "desktop-state.json"), join(agentDir, "projects.json"));
  await projects.load();
  sidecarLog = new SidecarLog(userDataDir);
  sidecarLog.write("main", `Sidecar log initialized at ${sidecarLog.path}`);
  const models = new ModelsConfigService(agentDir, {
    log: (text) => sidecarLog?.write("models", text),
  });
  const auth = new AuthConfigService(agentDir, {
    log: (text) => sidecarLog?.write("auth", text),
  });
  const settings = new SettingsConfigService(userDataDir);
  const builtinExtensions = DesktopControlledExtensionRegistry.getBuiltinDefinitions();
  const curatedExtensions = DesktopControlledExtensionRegistry.getCuratedDefinitions();
  const extensionSettings = new DesktopExtensionSettingsService(userDataDir, {
    builtinDefinitions: builtinExtensions,
    curatedDefinitions: curatedExtensions,
  });
  const extensionSourcePolicy = new DesktopExtensionSourcePolicy({
    settings: extensionSettings,
    getBuiltinDefinitions: () => builtinExtensions,
    getCuratedDefinitions: () => curatedExtensions,
    curatedRoot: app.isPackaged ? join(process.resourcesPath, "extensions") : join(appDir, "../extensions"),
  });
  const updater = new AutoUpdateService({ app });
  const installer = new NodeRuntimeInstaller(userDataDir, () => undefined);
  const configuredNode = detectNodeRuntime();
  const installedNode =
    configuredNode.state === "ready" ? configuredNode : detectNodeRuntime(installer.activeNodePath());
  let runtimeManifest: NodeRuntimeManifest;
  try {
    runtimeManifest = loadNodeRuntimeManifest({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appDir,
      nodePathOverride: installedNode.path,
      allowUnavailable: installedNode.state !== "ready",
    });
  } catch (error) {
    console.error("Node runtime is unavailable:", error);
    runtimeManifest = loadNodeRuntimeManifest({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appDir,
      allowUnavailable: true,
    });
  }
  metadata = new MetadataWorkerClient(runtimeManifest, agentDir, userDataDir, (scope, text) =>
    sidecarLog?.write(scope, text),
  );
  subagents = new SubagentWorkerRegistry({
    manifest: runtimeManifest,
    agentDir,
    log: (scope, text) => sidecarLog?.write(scope, text),
  });
  let supervisor: SessionSupervisor;
  const workers = new ThreadWorkerRegistry({
    manifest: runtimeManifest,
    metadata,
    userDataDir,
    agentDir,
    extensionSourcePolicy,
    getCwd: (projectId) => projects.getCwd(projectId),
    push: (payload, workerInstanceId, sidecarSequence) =>
      supervisor.receive(payload, workerInstanceId, sidecarSequence),
    failed: (projectId, threadId, error) => {
      console.error(`Pi sidecar failed for ${projectId}/${threadId}:`, error);
      supervisor.workerFailed(projectId, threadId, error);
    },
    resync: (projectId, threadId, reason) => supervisor.resyncRequired(projectId, threadId, reason),
    log: (scope, text) => sidecarLog?.write(scope, text),
    handleHostRequest: (request, emit) => subagents!.handleHostRequest(request, emit),
    hostWorkerFailed: (projectId, threadId) => subagents!.cancelThread(projectId, threadId),
  });
  supervisor = new SessionSupervisor(projects, workers, {
    log: (scope, text) => sidecarLog?.write(scope, text),
  });
  sessions = supervisor;
  terminals = new TerminalSupervisor(projects, broadcastTerminalEvent);
  registerIpc(
    projects,
    sessions,
    new FileService(projects),
    terminals,
    models,
    auth,
    settings,
    dirtyGuard,
    {
      getStatus: () => {
        const system = detectNodeRuntime();
        return system.state === "ready" ? system : detectNodeRuntime(installer.activeNodePath());
      },
      install: async () => {
        const status = await installer.install();
        app.relaunch();
        app.exit(0);
        return status;
      },
      onProgress: (listener) => installer.onProgress(listener),
    },
    updater,
    extensionSettings,
  );
  await installReactDevTools();
  createWindow();
  stopAutoUpdateChecks = scheduleAutoUpdateChecks(updater);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
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
  if (!sessions && !metadata && !sidecarLog && !subagents && !terminals) return;
  sidecarLog?.write("main", "Desktop shutdown started");
  event.preventDefault();
  const currentSessions = sessions;
  const currentMetadata = metadata;
  const currentSidecarLog = sidecarLog;
  const currentSubagents = subagents;
  const currentTerminals = terminals;
  sessions = undefined;
  metadata = undefined;
  sidecarLog = undefined;
  subagents = undefined;
  terminals = undefined;
  currentTerminals?.dispose();
  void (async () => {
    await currentSessions
      ?.dispose()
      .catch((error: unknown) => console.error("Failed to stop Pi thread workers:", error));
    await currentSubagents
      ?.dispose()
      .catch((error: unknown) => console.error("Failed to stop Pi subagent workers:", error));
    await currentMetadata
      ?.dispose()
      .catch((error: unknown) => console.error("Failed to stop Pi metadata worker:", error));
    await currentSidecarLog?.dispose().catch((error: unknown) => console.error("Failed to close sidecar log:", error));
  })().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
