import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getShellConfig, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { app, BrowserWindow, Menu } from "electron";
import { installExtension, REACT_DEVELOPER_TOOLS } from "electron-devtools-installer";
import windowStateKeeper from "electron-window-state";
import { CHANNELS } from "../shared/channels.ts";
import { AuthConfigService } from "./auth/auth-config-service.ts";
import { DesktopControlledExtensionRegistry } from "./extensions/desktop-extension-registry.ts";
import { DesktopExtensionSettingsService } from "./extensions/desktop-extension-settings-service.ts";
import { DesktopExtensionSourcePolicy } from "./extensions/desktop-extension-source-policy.ts";
import { FileService } from "./files/file-service.ts";
import { broadcastTerminalEvent, broadcastThreadCatalogUpdate, registerIpc } from "./ipc.ts";
import { FileCredentialStore } from "./models/credential-store.ts";
import { ModelsConfigService } from "./models/models-config-service.ts";
import { SessionSupervisor } from "./pi/session-supervisor.ts";
import { DEFAULT_PLUGIN_MARKETPLACE } from "./plugins/default-plugin-marketplace.ts";
import { MarketplaceCatalogService } from "./plugins/marketplace-catalog-service.ts";
import { MarketplaceEndpointSettingsService } from "./plugins/marketplace-endpoint-settings-service.ts";
import { MarketplaceExtensionApplyJournal } from "./plugins/marketplace-extension-apply-journal.ts";
import { MarketplaceGenerationReferenceTracker } from "./plugins/marketplace-generation-reference-tracker.ts";
import { MarketplaceMutationApplyCoordinator } from "./plugins/marketplace-mutation-apply-coordinator.ts";
import { MarketplacePluginGarbageCollector } from "./plugins/marketplace-plugin-garbage-collector.ts";
import { MarketplacePluginInstaller } from "./plugins/marketplace-plugin-installer.ts";
import { MarketplacePluginReconciler } from "./plugins/marketplace-plugin-reconciler.ts";
import { MarketplacePluginRegistry } from "./plugins/marketplace-plugin-registry.ts";
import { MarketplacePluginTransactionStore } from "./plugins/marketplace-plugin-transaction-store.ts";
import { MarketplaceRevocationService } from "./plugins/marketplace-revocation-service.ts";
import { ProvidersConfigService } from "./providers/providers-config-service.ts";
import { SettingsConfigService } from "./settings/settings-config-service.ts";
import { locateManagedBash } from "./sidecar/managed-shell-locator.ts";
import { MetadataWorkerClient } from "./sidecar/metadata-worker-client.ts";
import { NodeRuntimeInstaller } from "./sidecar/node-runtime-installer.ts";
import {
  detectNodeRuntime,
  loadNodeRuntimeManifest,
  type NodeRuntimeManifest,
} from "./sidecar/node-runtime-locator.ts";
import { parseRuntimeSetupSelection, runRuntimeSetup } from "./sidecar/runtime-setup.ts";
import {
  SHELL_RUNTIME_VERSION,
  ShellRuntimeInstaller,
  shellRuntimeInstallUrl,
} from "./sidecar/shell-runtime-installer.ts";
import { SidecarLog } from "./sidecar/sidecar-log.ts";
import { SubagentWorkerRegistry } from "./sidecar/subagent-worker-registry.ts";
import { ThreadWorkerRegistry } from "./sidecar/thread-worker-registry.ts";
import { ProjectStore } from "./store/project-store.ts";
import { SubagentSettingsConfigService } from "./subagents/subagent-settings-config-service.ts";
import { createTerminalShellResolver, TerminalSupervisor } from "./terminal/terminal-supervisor.ts";
import { AutoUpdateService, scheduleAutoUpdateChecks } from "./updater.ts";
import { WindowDirtyGuard } from "./window-dirty-guard.ts";

let sessions: SessionSupervisor | undefined;
let metadata: MetadataWorkerClient | undefined;
let sidecarLog: SidecarLog | undefined;
let subagents: SubagentWorkerRegistry | undefined;
let terminals: TerminalSupervisor | undefined;
let stopAutoUpdateChecks: (() => void) | undefined;
let stopMarketplaceRevocationChecks: (() => void) | undefined;
let stopMarketplaceGarbageCollection: (() => void) | undefined;
let quitGuardPending = false;
const dirtyGuard = new WindowDirtyGuard({
  beforeReload: (window) => sessions?.detachAll(window.webContents.id),
});
const appDir = dirname(fileURLToPath(import.meta.url));
const runtimeSetupSelection = parseRuntimeSetupSelection(process.argv);
const defaultWindowBounds = { width: 1440, height: 920 };
const minimumWindowBounds = { width: 1024, height: 680 };
// 开发实例允许并行启动；发布版保持单实例，避免多个主进程同时管理同一份状态。
const hasSingleInstanceLock = runtimeSetupSelection || !app.isPackaged ? true : app.requestSingleInstanceLock();

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

function scheduleMarketplaceGarbageCollection(
  collector: MarketplacePluginGarbageCollector,
  log: (text: string) => void,
): () => void {
  const collect = async () => {
    try {
      const result = await collector.run();
      if (result.removedVersions.length > 0 || result.removedRoots.length > 0) {
        log(`Plugin GC removed ${result.removedVersions.length} version(s) and ${result.removedRoots.length} root(s)`);
      }
    } catch (error) {
      log(`Plugin GC failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const initial = setTimeout(() => void collect(), 30_000);
  const interval = setInterval(() => void collect(), 60 * 60_000);
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}

function scheduleMarketplaceRevocationChecks(
  registry: MarketplacePluginRegistry,
  revocations: MarketplaceRevocationService,
  changed: () => Promise<unknown>,
  log: (text: string) => void,
): () => void {
  let running = false;
  let stopped = false;
  const refresh = async () => {
    if (running || stopped) return;
    running = true;
    let refreshed = false;
    try {
      const marketplaceIds = [
        ...new Set((await registry.getInternalSnapshot()).plugins.map((plugin) => plugin.marketplaceId)),
      ];
      for (const marketplaceId of marketplaceIds) {
        try {
          await revocations.refresh(marketplaceId);
          refreshed = true;
        } catch (error) {
          log(
            `Revocation refresh failed for ${marketplaceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (refreshed) await changed();
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void refresh(), 10_000);
  const interval = setInterval(() => void refresh(), 60 * 60_000);
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  const userDataDir = app.getPath("userData");
  if (runtimeSetupSelection) {
    try {
      await runRuntimeSetup(userDataDir, runtimeSetupSelection);
      app.exit(0);
    } catch (error) {
      console.error("Runtime setup failed:", error);
      app.exit(1);
    }
    return;
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const shellInstaller = new ShellRuntimeInstaller(userDataDir, () => undefined);
  const managedBashPath =
    shellInstaller.activeBashPath() ??
    locateManagedBash({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appDir,
    });
  const projects = new ProjectStore(join(userDataDir, "desktop-state.json"), join(agentDir, "projects.json"));
  await projects.load();
  sidecarLog = new SidecarLog(userDataDir);
  sidecarLog.write("main", `Sidecar log initialized at ${sidecarLog.path}`);
  const models = new ModelsConfigService(agentDir, {
    log: (text) => sidecarLog?.write("models", text),
  });
  const authModelRuntime = await ModelRuntime.create({
    credentials: new FileCredentialStore(join(agentDir, "auth.json")),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const auth = new AuthConfigService(agentDir, {
    log: (text) => sidecarLog?.write("auth", text),
    modelRuntime: authModelRuntime,
  });
  const settings = new SettingsConfigService(userDataDir);
  const builtinExtensions = DesktopControlledExtensionRegistry.getBuiltinDefinitions();
  const curatedExtensions = DesktopControlledExtensionRegistry.getCuratedDefinitions();
  const extensionSettings = new DesktopExtensionSettingsService(userDataDir, {
    builtinDefinitions: builtinExtensions,
    curatedDefinitions: curatedExtensions,
  });
  const marketplaceEndpoints = new MarketplaceEndpointSettingsService(userDataDir, {
    defaultEndpoint: DEFAULT_PLUGIN_MARKETPLACE,
  });
  const marketplaceRegistry = new MarketplacePluginRegistry(userDataDir);
  const marketplaceTransactions = new MarketplacePluginTransactionStore(userDataDir);
  const marketplaceGenerationReferences = new MarketplaceGenerationReferenceTracker();
  const marketplaceReconciler = new MarketplacePluginReconciler(
    marketplaceRegistry,
    marketplaceTransactions,
    agentDir,
    { log: (text) => sidecarLog?.write("marketplace", text) },
  );
  const marketplaceMutationApply = new MarketplaceMutationApplyCoordinator(
    marketplaceRegistry,
    marketplaceTransactions,
    marketplaceReconciler,
    agentDir,
  );
  const marketplaceApplyJournal = new MarketplaceExtensionApplyJournal(userDataDir, marketplaceGenerationReferences, {
    mutationLifecycle: marketplaceMutationApply,
  });
  const marketplaceGarbageCollector = new MarketplacePluginGarbageCollector(
    marketplaceRegistry,
    marketplaceTransactions,
    marketplaceGenerationReferences,
    agentDir,
  );
  const marketplaceRevocations = new MarketplaceRevocationService(marketplaceEndpoints, userDataDir);
  await marketplaceApplyJournal.reconcileStartup();
  await marketplaceReconciler.reconcile();
  const extensionSourcePolicy = new DesktopExtensionSourcePolicy({
    settings: extensionSettings,
    getBuiltinDefinitions: () => builtinExtensions,
    getCuratedDefinitions: () => curatedExtensions,
    getMarketplaceExtensions: () => marketplaceRegistry.getInternalSnapshot(),
    getMarketplaceRevocation: (plugin) => marketplaceRevocations.getCachedPluginRevocation(plugin),
    marketplaceRoot: join(agentDir, "extensions"),
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
  const marketplaceCatalog = new MarketplaceCatalogService(marketplaceEndpoints, {
    desktopVersion: app.getVersion(),
    runtimeCompatibility: runtimeManifest.compatibility,
  });
  const marketplacePluginInstaller = new MarketplacePluginInstaller(
    marketplaceEndpoints,
    marketplaceRegistry,
    marketplaceTransactions,
    agentDir,
    app.getVersion(),
    runtimeManifest.compatibility,
    {
      reservedExtensionIds: new Set([
        ...builtinExtensions.map((extension) => extension.id),
        ...curatedExtensions.map((extension) => extension.id),
      ]),
      revocations: marketplaceRevocations,
    },
  );
  metadata = new MetadataWorkerClient(
    runtimeManifest,
    agentDir,
    userDataDir,
    (scope, text) => sidecarLog?.write(scope, text),
    marketplaceGenerationReferences,
  );
  // supervisor 在两个 registry 之后才能构造（循环依赖）；回调必须容忍赋值前被触发，避免 TDZ 崩溃或 ack 饿死。
  let supervisor: SessionSupervisor | undefined;
  subagents = new SubagentWorkerRegistry({
    manifest: runtimeManifest,
    agentDir,
    ...(managedBashPath ? { shellPath: managedBashPath } : {}),
    log: (scope, text) => sidecarLog?.write(scope, text),
    catalogChanged: broadcastThreadCatalogUpdate,
    persistSession: (projectId, sessionFile, thread) =>
      metadata!.registerExternal(projectId, projects.getCwd(projectId), sessionFile, thread),
    push: (payload, workerInstanceId, sidecarSequence) => {
      if (supervisor) supervisor.receive(payload, workerInstanceId, sidecarSequence);
      else subagents?.acknowledge(workerInstanceId, sidecarSequence);
    },
    resync: (projectId, threadId, reason) => supervisor?.resyncRequired(projectId, threadId, reason),
  });
  const workers = new ThreadWorkerRegistry({
    manifest: runtimeManifest,
    metadata,
    userDataDir,
    agentDir,
    ...(managedBashPath ? { shellPath: managedBashPath } : {}),
    extensionSourcePolicy,
    generationReferences: marketplaceGenerationReferences,
    extensionApplyJournal: marketplaceApplyJournal,
    getCwd: (projectId) => projects.getCwd(projectId),
    push: (payload, workerInstanceId, sidecarSequence) => {
      if (supervisor) supervisor.receive(payload, workerInstanceId, sidecarSequence);
      else workers.acknowledge(workerInstanceId, sidecarSequence);
    },
    failed: (projectId, threadId, error) => {
      console.error(`Pi sidecar failed for ${projectId}/${threadId}:`, error);
      supervisor?.workerFailed(projectId, threadId, error);
    },
    resync: (projectId, threadId, reason) => supervisor?.resyncRequired(projectId, threadId, reason),
    log: (scope, text) => sidecarLog?.write(scope, text),
    handleHostRequest: (request, emit) => subagents!.handleHostRequest(request, emit),
    hostWorkerFailed: (projectId, threadId) => subagents!.cancelThread(projectId, threadId),
    listSubagentThreads: (projectId) => subagents!.listThreads(projectId),
    isActiveSubagentThread: (projectId, threadId) => subagents!.isActiveThread(projectId, threadId),
    attachSubagent: (projectId, threadId) => subagents!.attach(projectId, threadId),
    acknowledgeSubagent: (workerInstanceId, sidecarSequence) =>
      subagents!.acknowledge(workerInstanceId, sidecarSequence),
  });
  const startedSupervisor = new SessionSupervisor(projects, workers, {
    log: (scope, text) => sidecarLog?.write(scope, text),
  });
  supervisor = startedSupervisor;
  sessions = startedSupervisor;
  terminals = new TerminalSupervisor(
    projects,
    broadcastTerminalEvent,
    createTerminalShellResolver(agentDir, managedBashPath),
  );
  const providers = new ProvidersConfigService(models, auth, authModelRuntime);
  let modelConfigurationGeneration = 0;
  const subagentSettings = new SubagentSettingsConfigService({
    agentDir,
    builtinAgentsDir: join(
      dirname(runtimeManifest.entries.subagent),
      "..",
      "main",
      "pi",
      "extensions",
      "pi-subagents",
      "agents",
    ),
    modelRuntime: authModelRuntime,
    getProjectCwd: (projectId) => projects.getCwd(projectId),
    getActiveProject: async () => {
      const project = await projects.getActive();
      return project ? { id: project.id, cwd: project.cwd } : null;
    },
  });
  registerIpc(
    projects,
    sessions,
    new FileService(projects),
    terminals,
    models,
    auth,
    providers,
    settings,
    dirtyGuard,
    {
      getStatus: () => {
        const system = detectNodeRuntime();
        return system.state === "ready" ? system : detectNodeRuntime(installer.activeNodePath());
      },
      install: () => installer.install(),
      onProgress: (listener) => installer.onProgress(listener),
      refreshActiveModelRuntimes: async () => {
        modelConfigurationGeneration += 1;
        const revision = { generation: modelConfigurationGeneration };
        const results = await Promise.allSettled([
          workers.refreshAllModels(revision),
          subagents!.refreshAllModels(revision),
        ]);
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to refresh one or more active model runtimes");
        }
      },
      shell: {
        getStatus: async () => {
          const activeProject = await projects.getActive();
          const cwd = activeProject?.cwd ?? process.cwd();
          const configuredShellPath = SettingsManager.create(cwd, agentDir).getShellPath();
          try {
            const shell = getShellConfig(configuredShellPath).shell;
            return {
              state: "ready" as const,
              path: shell,
              ...(shell === shellInstaller.activeBashPath() ? { version: SHELL_RUNTIME_VERSION } : {}),
              message: `已找到 Git Bash: ${shell}`,
              installUrl: shellRuntimeInstallUrl(),
            };
          } catch (error) {
            return {
              state: configuredShellPath ? ("invalid" as const) : ("missing" as const),
              message: error instanceof Error ? error.message : String(error),
              installUrl: shellRuntimeInstallUrl(),
            };
          }
        },
        install: () => shellInstaller.install(),
        onProgress: (listener) => shellInstaller.onProgress(listener),
      },
    },
    updater,
    extensionSettings,
    subagentSettings,
    marketplaceEndpoints,
    marketplaceCatalog,
    marketplaceRegistry,
    marketplacePluginInstaller,
    marketplaceMutationApply,
    marketplaceApplyJournal,
    marketplaceRevocations,
  );
  await installReactDevTools();
  createWindow();
  stopAutoUpdateChecks = scheduleAutoUpdateChecks(updater);
  stopMarketplaceGarbageCollection = scheduleMarketplaceGarbageCollection(marketplaceGarbageCollector, (text) =>
    sidecarLog?.write("marketplace", text),
  );
  stopMarketplaceRevocationChecks = scheduleMarketplaceRevocationChecks(
    marketplaceRegistry,
    marketplaceRevocations,
    async () => sessions?.extensionSettingsChanged(),
    (text) => sidecarLog?.write("marketplace", text),
  );

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
  stopMarketplaceRevocationChecks?.();
  stopMarketplaceRevocationChecks = undefined;
  stopMarketplaceGarbageCollection?.();
  stopMarketplaceGarbageCollection = undefined;
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
