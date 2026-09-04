import { join } from "node:path";
import type { BrowserWindow as BrowserWindowType, Event, app as electronApp } from "electron";
import { BrowserWindow, Menu } from "electron";
import { CHANNELS } from "../../shared/channels.ts";
import type { FileChangeSet } from "../../shared/contracts.ts";
import { handleBrowserInternalPageRequests } from "../browser/browser-internal-page-protocol.ts";
import { handlePdfPreviewRequests } from "../files/pdf-preview-protocol.ts";
import {
  broadcastBrowserCloseTabRequest,
  broadcastBrowserCreateTabRequest,
  broadcastBrowserEvent,
  broadcastTerminalEvent,
  broadcastThreadCatalogUpdate,
  sendBrowserPasswordOffer,
} from "../ipc.ts";
import { BrowserCapabilityPort } from "../session/browser-capability-port.ts";
import { WorkspaceMutationPort } from "../session/workspace-mutation-port.ts";
import { handleLocalImageRequests } from "../settings/user-avatar-protocol.ts";
import { TrayController } from "../tray.ts";
import { AutoUpdateService, scheduleAutoUpdateChecks } from "../updater.ts";
import { WindowDirtyGuard } from "../window-dirty-guard.ts";
import { type BrowserServices, createBrowserServices } from "./browser-services.ts";
import { type CoreServices, createCoreServices } from "./core-services.ts";
import { registerApplicationIpc } from "./ipc-registration.ts";
import { createPluginServices, type PluginServices } from "./plugin-services.ts";
import { ResourceScope } from "./resource-scope.ts";
import { createDesktopRuntimeContext, type DesktopRuntimeContext } from "./runtime-context.ts";
import { createSessionServices, type SessionServices } from "./session-services.ts";
import { createWorkspaceServices, type WorkspaceServices } from "./workspace-services.ts";

type ApplicationState = "new" | "initializing" | "ready" | "starting" | "running" | "stopping" | "stopped";

interface ApplicationGraph {
  readonly context: DesktopRuntimeContext;
  readonly core: CoreServices;
  readonly plugins: PluginServices;
  readonly sessions: SessionServices;
  readonly workspace: WorkspaceServices;
  readonly browser: BrowserServices;
  readonly updater: AutoUpdateService;
}

/** 可替换的应用 factory 集合，供生命周期测试注入替身。 */
export interface DesktopApplicationFactories {
  readonly createRuntimeContext: typeof createDesktopRuntimeContext;
  readonly createCoreServices: typeof createCoreServices;
  readonly createPluginServices: typeof createPluginServices;
  readonly createSessionServices: typeof createSessionServices;
  readonly createWorkspaceServices: typeof createWorkspaceServices;
  readonly createBrowserServices: typeof createBrowserServices;
  readonly registerIpc: typeof registerApplicationIpc;
  readonly createUpdater: (app: typeof electronApp) => AutoUpdateService;
  readonly scheduleUpdates: typeof scheduleAutoUpdateChecks;
  readonly scheduleMarketplaceGc: typeof scheduleMarketplaceGarbageCollection;
}

/** DesktopApplication 的 Electron、窗口和 bootstrap 配置。 */
export interface DesktopApplicationOptions {
  readonly app: typeof electronApp;
  readonly appDir: string;
  readonly resourcesPath: string;
  readonly rendererUrl?: string;
  readonly installDevTools: () => Promise<void>;
  readonly createWindow: (dependencies: {
    dirtyGuard: WindowDirtyGuard;
    trayController: TrayController;
  }) => BrowserWindowType;
  readonly factories?: Partial<DesktopApplicationFactories>;
}

const DEFAULT_FACTORIES: DesktopApplicationFactories = {
  createRuntimeContext: createDesktopRuntimeContext,
  createCoreServices,
  createPluginServices,
  createSessionServices,
  createWorkspaceServices,
  createBrowserServices,
  registerIpc: registerApplicationIpc,
  createUpdater: (app) => new AutoUpdateService({ app }),
  scheduleUpdates: scheduleAutoUpdateChecks,
  scheduleMarketplaceGc: scheduleMarketplaceGarbageCollection,
};

/** Desktop 主进程组合根：负责服务图、窗口启动和分阶段资源释放。 */
export class DesktopApplication {
  readonly dirtyGuard: WindowDirtyGuard;
  readonly trayController: TrayController;
  private readonly options: DesktopApplicationOptions;
  private readonly factories: DesktopApplicationFactories;
  private readonly resources = new ResourceScope();
  private graph: ApplicationGraph | undefined;
  private state: ApplicationState = "new";
  private initialization: Promise<void> | undefined;
  private startup: Promise<void> | undefined;
  private disposal: Promise<void> | undefined;
  private quitGuardPending = false;

  /** 创建尚未初始化的桌面应用组合根。 */
  constructor(options: DesktopApplicationOptions) {
    this.options = options;
    this.factories = { ...DEFAULT_FACTORIES, ...options.factories };
    this.dirtyGuard = new WindowDirtyGuard({
      beforeReload: (window) => this.graph?.sessions.sessions.detachAll(window.webContents.id),
    });
    this.trayController = new TrayController({
      platform: process.platform,
      isPackaged: options.app.isPackaged,
      appDir: options.appDir,
      resourcesPath: options.resourcesPath,
      quit: () => options.app.quit(),
    });
  }

  /** 幂等构造服务图并完成启动前准备。 */
  initialize(): Promise<void> {
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }

  /** 幂等注册 IPC、创建窗口并启动后台任务。 */
  start(): Promise<void> {
    this.startup ??= this.startOnce();
    return this.startup;
  }

  /** 应用运行中创建一个主窗口；其他状态下返回 undefined。 */
  openWindow(): BrowserWindowType | undefined {
    if (this.state !== "running") return undefined;
    return this.options.createWindow({ dirtyGuard: this.dirtyGuard, trayController: this.trayController });
  }

  /** 处理 before-quit，协调 dirty guard 和分阶段资源释放。 */
  requestQuit(event: Event): void {
    if (this.state === "stopped") return;
    const windows = BrowserWindow.getAllWindows();
    if (!this.dirtyGuard.isApplicationQuitConfirmed() && this.dirtyGuard.hasDirtyWindows(windows)) {
      event.preventDefault();
      if (!this.quitGuardPending) {
        this.quitGuardPending = true;
        void this.dirtyGuard
          .confirmApplicationQuit(windows)
          .then((confirmed) => {
            if (confirmed) {
              this.trayController.markQuitting();
              this.options.app.quit();
            }
          })
          .finally(() => {
            this.quitGuardPending = false;
          });
      }
      return;
    }
    this.trayController.markQuitting();
    event.preventDefault();
    if (this.state === "stopping") return;
    void this.dispose()
      .catch((error) => console.error("Desktop shutdown failed:", error))
      .finally(() => this.options.app.quit());
  }

  /** 幂等释放应用资源，并等待正在进行的初始化收敛。 */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce();
    return this.disposal;
  }

  private async disposeOnce(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    try {
      await this.initialization?.catch(() => undefined);
      await this.resources.dispose();
    } finally {
      this.graph = undefined;
      this.state = "stopped";
    }
  }

  private async initializeOnce(): Promise<void> {
    if (this.state !== "new") throw new Error(`Cannot initialize desktop application from ${this.state}`);
    this.state = "initializing";
    try {
      handleLocalImageRequests();
      handleBrowserInternalPageRequests(join(this.options.appDir, "../renderer"), this.options.rendererUrl);
      Menu.setApplicationMenu(null);
      const context = this.factories.createRuntimeContext({
        app: this.options.app,
        appDir: this.options.appDir,
        resourcesPath: this.options.resourcesPath,
      });
      this.resources.add("sidecar log", "logging", context.sidecarLog);
      const [core, plugins] = await Promise.all([
        this.factories.createCoreServices(context),
        this.factories.createPluginServices(context, { desktopVersion: this.options.app.getVersion() }),
        this.options.installDevTools(),
      ]);
      if (this.state === "stopping") throw new Error("Desktop application initialization was stopped");
      handlePdfPreviewRequests(core.projects);
      const workspaceMutation = new WorkspaceMutationPort();
      const browserCapability = new BrowserCapabilityPort();
      const sessions = this.factories.createSessionServices({
        context,
        core,
        plugins,
        workspaceMutation,
        browserCapability,
        publishCatalogChanged: broadcastThreadCatalogUpdate,
        reportWorkerFailure: (projectId, threadId, error) =>
          console.error(`Pi sidecar failed for ${projectId}/${threadId}:`, error),
      });
      this.resources.add("session services", "session", sessions);
      const workspace = this.factories.createWorkspaceServices({
        context,
        core,
        plugins,
        sessions,
        workspaceMutation,
        publishScmChanged: broadcastScmChanged,
        publishFileChanged: broadcastFileChanged,
        publishTerminalEvent: broadcastTerminalEvent,
      });
      this.resources.add("workspace services", "workspace", workspace);
      const browser = await this.factories.createBrowserServices({
        context,
        capability: browserCapability,
        rendererUrl: this.options.rendererUrl,
        publishState: broadcastBrowserEvent,
        publishCreateTab: broadcastBrowserCreateTabRequest,
        publishCloseTab: broadcastBrowserCloseTabRequest,
        publishPasswordOffer: sendBrowserPasswordOffer,
      });
      this.resources.add("browser services", "browser", browser);
      const updater = this.factories.createUpdater(this.options.app);
      this.graph = { context, core, plugins, sessions, workspace, browser, updater };
      this.state = "ready";
    } catch (error) {
      await this.rollback(error);
    }
  }

  private async startOnce(): Promise<void> {
    await this.initialize();
    if (!this.graph || this.state !== "ready") throw new Error("Desktop application initialization did not complete");
    this.state = "starting";
    try {
      const registration = this.factories.registerIpc({
        ...this.graph,
        dirtyGuard: this.dirtyGuard,
      });
      this.resources.add("IPC registration", "background", registration);
      const window = this.options.createWindow({ dirtyGuard: this.dirtyGuard, trayController: this.trayController });
      this.resources.add("main window", "background", {
        dispose: () => {
          if (!window.isDestroyed()) window.destroy();
        },
      });
      this.resources.add("auto update checks", "background", {
        dispose: this.factories.scheduleUpdates(this.graph.updater),
      });
      this.resources.add("marketplace garbage collection", "background", {
        dispose: this.factories.scheduleMarketplaceGc(this.graph.plugins.marketplaceGarbageCollector, (text) =>
          this.graph?.context.sidecarLog.write("marketplace", text),
        ),
      });
      this.resources.add("tray", "background", this.trayController);
      this.state = "running";
    } catch (error) {
      await this.rollback(error);
    }
  }

  private async rollback(startupError: unknown): Promise<never> {
    try {
      await this.resources.dispose();
    } catch (cleanupError) {
      this.state = "stopped";
      throw new AggregateError([startupError, cleanupError], "Desktop startup and rollback failed");
    }
    this.state = "stopped";
    throw startupError;
  }
}

function scheduleMarketplaceGarbageCollection(
  collector: PluginServices["marketplaceGarbageCollector"],
  log: (text: string) => void,
): () => void {
  const collect = async (): Promise<void> => {
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

function broadcastScmChanged(projectId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.scmChanged, { projectId });
  }
}

function broadcastFileChanged(change: FileChangeSet): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.filesChanged, change);
  }
}
