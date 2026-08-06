import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getShellConfig, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { app, BrowserWindow, Menu, safeStorage } from "electron";
import { installExtension, REACT_DEVELOPER_TOOLS } from "electron-devtools-installer";
import windowStateKeeper from "electron-window-state";
import { CHANNELS } from "../shared/channels.ts";
import { AuthConfigService } from "./auth/auth-config-service.ts";
import { DesktopControlledExtensionRegistry } from "./extensions/desktop-extension-registry.ts";
import { DesktopExtensionSettingsService } from "./extensions/desktop-extension-settings-service.ts";
import { DesktopExtensionSourcePolicy } from "./extensions/desktop-extension-source-policy.ts";
import { FileService } from "./files/file-service.ts";
import { ProjectFileWatcher } from "./files/file-watcher.ts";
import { broadcastTerminalEvent, broadcastThreadCatalogUpdate, registerIpc } from "./ipc.ts";
import { FileCredentialStore } from "./models/credential-store.ts";
import { ModelsConfigService } from "./models/models-config-service.ts";
import { DesktopBuiltinProviderRegistry } from "./pi/desktop-builtin-provider.ts";
import { deleteSessionCheckpoints } from "./pi/extensions/pi-rewind/src/core.ts";
import { SessionSupervisor } from "./pi/session-supervisor.ts";
import { DEFAULT_PLUGIN_MARKETPLACE } from "./plugins/default-plugin-marketplace.ts";
import { MarketplaceCatalogService } from "./plugins/marketplace-catalog-service.ts";
import { MarketplaceEndpointSettingsService } from "./plugins/marketplace-endpoint-settings-service.ts";
import { MarketplaceGenerationReferenceTracker } from "./plugins/marketplace-generation-reference-tracker.ts";
import { MarketplacePluginGarbageCollector } from "./plugins/marketplace-plugin-garbage-collector.ts";
import { MarketplacePluginInstaller } from "./plugins/marketplace-plugin-installer.ts";
import { MarketplacePluginReconciler } from "./plugins/marketplace-plugin-reconciler.ts";
import { MarketplacePluginRegistry } from "./plugins/marketplace-plugin-registry.ts";
import { PluginConfigurationService } from "./plugins/plugin-configuration-service.ts";
import { PreferencesConfigService } from "./preferences/preferences-config-service.ts";
import { ProvidersConfigService } from "./providers/providers-config-service.ts";
import { MemorySettingsService } from "./settings/memory-settings-service.ts";
import { SettingsConfigService } from "./settings/settings-config-service.ts";
import { handleLocalImageRequests, registerLocalImageSchemes } from "./settings/user-avatar-protocol.ts";
import { locateGitForWindowsBash, locateManagedBash } from "./sidecar/managed-shell-locator.ts";
import { MetadataWorkerClient } from "./sidecar/metadata-worker-client.ts";
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
import { SubagentWorkerRegistry } from "./sidecar/subagent-worker-registry.ts";
import { ThreadWorkerRegistry } from "./sidecar/thread-worker-registry.ts";
import { resolveWorkspaceMutationKey } from "./sidecar/workspace-mutation-key.ts";
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

registerLocalImageSchemes();

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

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  handleLocalImageRequests();
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
  const projectsLoad = projects.load();
  const getWorkspaceKey = (projectId: string): Promise<string> =>
    resolveWorkspaceMutationKey(projects.getCwd(projectId));
  sidecarLog = new SidecarLog(userDataDir);
  sidecarLog.write("main", `Sidecar log initialized at ${sidecarLog.path}`);
  const models = new ModelsConfigService(agentDir, {
    log: (text) => sidecarLog?.write("models", text),
  });
  const credentialStore = new FileCredentialStore(join(agentDir, "auth.json"));
  const authModelRuntimeCreation = ModelRuntime.create({
    credentials: credentialStore,
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const settings = new SettingsConfigService(userDataDir);
  const preferences = new PreferencesConfigService(userDataDir);
  const memorySettings = new MemorySettingsService(agentDir, {
    listProjects: () => projects.list(),
    getProjectCwd: (projectId) => projects.getCwd(projectId),
  });
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
  const marketplaceLockDirectory = join(userDataDir, "plugins", "locks");
  const pluginConfigurations = new PluginConfigurationService(userDataDir, marketplaceRegistry, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  });
  const marketplaceGenerationReferences = new MarketplaceGenerationReferenceTracker();
  const marketplaceReconciler = new MarketplacePluginReconciler(marketplaceRegistry, agentDir, userDataDir, {
    log: (text) => sidecarLog?.write("marketplace", text),
  });
  const marketplaceGarbageCollector = new MarketplacePluginGarbageCollector(
    marketplaceRegistry,
    marketplaceGenerationReferences,
    agentDir,
    marketplaceLockDirectory,
  );
  const marketplaceReconciliation = marketplaceReconciler.reconcile();
  const [authModelRuntime] = await Promise.all([
    authModelRuntimeCreation,
    projectsLoad,
    marketplaceReconciliation,
    reactDevToolsInstall,
  ]);
  const auth = new AuthConfigService(agentDir, {
    log: (text) => sidecarLog?.write("auth", text),
    modelRuntime: authModelRuntime,
  });
  const extensionSourcePolicy = new DesktopExtensionSourcePolicy({
    settings: extensionSettings,
    getBuiltinDefinitions: () => builtinExtensions,
    getCuratedDefinitions: () => curatedExtensions,
    getMarketplaceExtensions: () => marketplaceRegistry.getInternalSnapshot(),
    pluginConfigurations,
    marketplaceRoot: join(agentDir, "extensions"),
    curatedRoot: app.isPackaged ? join(process.resourcesPath, "extensions") : join(appDir, "../extensions"),
  });
  const updater = new AutoUpdateService({ app });
  const runtimeManifest = loadSidecarRuntimeManifest({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir,
  });
  const marketplaceCatalog = new MarketplaceCatalogService(marketplaceEndpoints, {
    desktopVersion: app.getVersion(),
    runtimeCompatibility: runtimeManifest.compatibility,
  });
  const marketplacePluginInstaller = new MarketplacePluginInstaller(
    marketplaceEndpoints,
    marketplaceRegistry,
    marketplaceLockDirectory,
    agentDir,
    app.getVersion(),
    runtimeManifest.compatibility,
    {
      reservedExtensionIds: new Set([
        ...builtinExtensions.map((extension) => extension.id),
        ...curatedExtensions.map((extension) => extension.id),
      ]),
    },
  );
  metadata = new MetadataWorkerClient(
    runtimeManifest,
    agentDir,
    userDataDir,
    (scope, text) => sidecarLog?.write(scope, text),
    marketplaceGenerationReferences,
  );
  const metadataClient = metadata;
  // supervisor 在两个 registry 之后才能构造（循环依赖）；回调必须容忍赋值前被触发，避免 TDZ 崩溃或 ack 饿死。
  let supervisor: SessionSupervisor | undefined;
  let subagentRegistry: SubagentWorkerRegistry | undefined;
  subagentRegistry = new SubagentWorkerRegistry({
    manifest: runtimeManifest,
    agentDir,
    ...(desktopBashPath ? { shellPath: desktopBashPath } : {}),
    getWorkspaceKey,
    log: (scope, text) => sidecarLog?.write(scope, text),
    catalogChanged: broadcastThreadCatalogUpdate,
    persistSession: (projectId, sessionFile, thread) =>
      metadataClient.registerExternal(projectId, projects.getCwd(projectId), sessionFile, thread),
    push: (payload, workerInstanceId, sidecarSequence) => {
      if (supervisor) supervisor.receive(payload, workerInstanceId, sidecarSequence);
      else subagentRegistry?.acknowledge(workerInstanceId, sidecarSequence);
    },
    resync: (projectId, threadId, reason) => supervisor?.resyncRequired(projectId, threadId, reason),
  });
  const activeSubagents = subagentRegistry;
  subagents = activeSubagents;
  const workers = new ThreadWorkerRegistry({
    manifest: runtimeManifest,
    metadata: metadataClient,
    userDataDir,
    agentDir,
    ...(desktopBashPath ? { shellPath: desktopBashPath } : {}),
    extensionSourcePolicy,
    generationReferences: marketplaceGenerationReferences,
    getCwd: (projectId) => projects.getCwd(projectId),
    getWorkspaceKey,
    push: (payload, workerInstanceId, sidecarSequence) => {
      if (supervisor) supervisor.receive(payload, workerInstanceId, sidecarSequence);
      else workers.acknowledge(workerInstanceId, sidecarSequence);
    },
    failed: (projectId, threadId, error) => {
      console.error(`Pi sidecar failed for ${projectId}/${threadId}:`, error);
      supervisor?.workerFailed(projectId, threadId, error);
    },
    resync: (projectId, threadId, reason) => supervisor?.resyncRequired(projectId, threadId, reason),
    catalogChanged: broadcastThreadCatalogUpdate,
    log: (scope, text) => sidecarLog?.write(scope, text),
    handleHostRequest: (request, emit) => activeSubagents.handleHostRequest(request, emit),
    hostWorkerFailed: (projectId, threadId) => activeSubagents.cancelThread(projectId, threadId),
    listSubagentThreads: (projectId) => activeSubagents.listThreads(projectId),
    isActiveSubagentThread: (projectId, threadId) => activeSubagents.isActiveThread(projectId, threadId),
    attachSubagent: (projectId, threadId) => activeSubagents.attach(projectId, threadId),
    cancelSubagent: (projectId, threadId) => activeSubagents.cancelActiveThread(projectId, threadId),
    acknowledgeSubagent: (workerInstanceId, sidecarSequence) =>
      activeSubagents.acknowledge(workerInstanceId, sidecarSequence),
    beginSubagentWorkspaceMutation: (workspaceKey) => activeSubagents.beginWorkspaceMutation(workspaceKey),
    endSubagentWorkspaceMutation: (workspaceKey) => activeSubagents.endWorkspaceMutation(workspaceKey),
    beginTerminalWorkspaceMutation: async (workspaceKey) => {
      const projectKeys = await Promise.all(
        (await projects.list())
          .filter((project) => project.available)
          .map(async (project) => ({ projectId: project.id, workspaceKey: await getWorkspaceKey(project.id) })),
      );
      const projectIds = projectKeys
        .filter((project) => project.workspaceKey === workspaceKey)
        .map((project) => project.projectId);
      return terminals?.beginWorkspaceRestore(projectIds) ?? (() => undefined);
    },
    cleanupSessionCheckpoints: (projectId, threadIds) =>
      deleteSessionCheckpoints(projects.getCwd(projectId), threadIds),
    beginSubagentProjectMutation: (projectId) => activeSubagents.beginProjectMutation(projectId),
    endSubagentProjectMutation: (projectId) => activeSubagents.endProjectMutation(projectId),
    beginSubagentTreeMutation: (projectId, parentThreadId) =>
      activeSubagents.beginThreadMutation(projectId, parentThreadId),
    endSubagentTreeMutation: (projectId, parentThreadId) =>
      activeSubagents.endThreadMutation(projectId, parentThreadId),
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
  );
  const providers = new ProvidersConfigService(models, auth, authModelRuntime);
  const desktopProviderEnvKeys = new Map(
    DesktopBuiltinProviderRegistry.getKnownProviderInfos().map((provider) => [provider.id, provider.envKeys]),
  );
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
    isDesktopProviderAvailable: async (providerId) => {
      const credential = await credentialStore.read(providerId);
      if (credential?.type === "oauth" || (credential?.type === "api_key" && Boolean(credential.key))) return true;
      return desktopProviderEnvKeys.get(providerId)?.some((envKey) => Boolean(process.env[envKey])) ?? false;
    },
    getProjectCwd: (projectId) => projects.getCwd(projectId),
  });
  registerIpc(
    projects,
    sessions,
    new FileService(projects),
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
        const results = await Promise.allSettled([
          workers.refreshAllModels(revision),
          activeSubagents.refreshAllModels(revision),
        ]);
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to refresh one or more active model runtimes");
        }
      },
      refreshMemoryConfiguration: async () => {
        extensionSourcePolicy.invalidate();
        await startedSupervisor.extensionSettingsChanged();
      },
      shell: {
        getStatus: async () => {
          const activeProject = await projects.getActive();
          const cwd = activeProject?.cwd ?? process.cwd();
          const configuredShellPath = SettingsManager.create(cwd, agentDir).getShellPath();
          const shellPath = configuredShellPath ?? desktopBashPath;
          if (!shellPath) {
            return {
              state: "missing" as const,
              message: "未找到 Git for Windows；WSL bash 不支持",
              installUrl: shellRuntimeInstallUrl(),
            };
          }
          try {
            const shell = getShellConfig(shellPath).shell;
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
    extensionSettings,
    subagentSettings,
    marketplaceEndpoints,
    marketplaceCatalog,
    marketplaceRegistry,
    marketplacePluginInstaller,
    pluginConfigurations,
    memorySettings,
    preferences,
  );
  createWindow();
  stopAutoUpdateChecks = scheduleAutoUpdateChecks(updater);
  stopMarketplaceGarbageCollection = scheduleMarketplaceGarbageCollection(marketplaceGarbageCollector, (text) =>
    sidecarLog?.write("marketplace", text),
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
