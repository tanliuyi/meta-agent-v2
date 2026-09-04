import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions, webContents } from "electron";
import type {
  BrowserCloseTabRequest,
  BrowserCreateTabRequest,
  BrowserStateEvent,
} from "../shared/browser-contracts.ts";
import type { BrowserPasswordOffer } from "../shared/browser-data-contracts.ts";
import { CHANNELS } from "../shared/channels.ts";
import type { TerminalEvent, Thread } from "../shared/contracts.ts";
import type { ShellRuntimeProgress, ShellRuntimeStatus } from "../shared/desktop-api.ts";
import { BROWSER_IPC_CHANNELS, type BrowserIpcDependencies, registerBrowserIpc } from "./ipc/browser-ipc.ts";
import { PLUGIN_IPC_CHANNELS, type PluginIpcDependencies, registerPluginIpc } from "./ipc/plugin-ipc.ts";
import { registerSessionIpc, SESSION_IPC_CHANNELS, type SessionIpcDependencies } from "./ipc/session-ipc.ts";
import { registerSettingsIpc, SETTINGS_IPC_CHANNELS, type SettingsIpcDependencies } from "./ipc/settings-ipc.ts";
import { registerWorkspaceIpc, WORKSPACE_IPC_CHANNELS, type WorkspaceIpcDependencies } from "./ipc/workspace-ipc.ts";
import type { AutoUpdateService } from "./updater.ts";

interface RuntimeIpcDependencies {
  readonly refreshActiveModelRuntimes?: () => Promise<void>;
  readonly refreshMemoryConfiguration?: () => Promise<void>;
  readonly shell?: {
    getStatus(): Promise<ShellRuntimeStatus> | ShellRuntimeStatus;
    install(): Promise<ShellRuntimeStatus>;
    use(path: string): Promise<ShellRuntimeStatus>;
    onProgress(listener: (progress: ShellRuntimeProgress) => void): () => void;
  };
}

/** 主进程 IPC 各领域 registrar 所需的命名依赖集合。 */
export interface ApplicationIpcDependencies
  extends WorkspaceIpcDependencies,
    SessionIpcDependencies,
    SettingsIpcDependencies,
    PluginIpcDependencies,
    BrowserIpcDependencies {
  readonly runtime?: RuntimeIpcDependencies;
  readonly updater?: AutoUpdateService;
}

/** 已注册 IPC 资源的幂等释放句柄。 */
export interface IpcRegistration {
  dispose(): void;
}

const WINDOW_IPC_CHANNELS = [
  CHANNELS.windowMinimize,
  CHANNELS.windowToggleMaximize,
  CHANNELS.runtimeRestart,
  CHANNELS.windowClose,
] as const;
const SHELL_IPC_CHANNELS = [
  CHANNELS.shellRuntimeStatus,
  CHANNELS.shellRuntimeInstall,
  CHANNELS.shellRuntimeChoose,
] as const;
const UPDATER_IPC_CHANNELS = [
  CHANNELS.updaterGetState,
  CHANNELS.updaterCheck,
  CHANNELS.updaterDownload,
  CHANNELS.updaterInstall,
] as const;

/** 注册完成后的服务图；失败会撤销已注册的 handler 和 listener。 */
/** 按领域注册 IPC，并在失败或退出时只清理本次注册内容。 */
export function registerIpc(dependencies: ApplicationIpcDependencies): IpcRegistration {
  const subscriptions: Array<() => void> = [];
  const registeredChannels = new Set<string>();
  const track = (channels: readonly string[]): void => {
    for (const channel of channels) registeredChannels.add(channel);
  };
  const registerDomain = (allChannels: readonly string[], register: () => readonly string[]): void => {
    try {
      track(register());
    } catch (error) {
      track(allChannels);
      throw error;
    }
  };
  try {
    track(WINDOW_IPC_CHANNELS);
    registerWindowIpc(dependencies);
    registerDomain(WORKSPACE_IPC_CHANNELS, () => registerWorkspaceIpc(dependencies));
    registerDomain(SESSION_IPC_CHANNELS, () => registerSessionIpc(dependencies));
    registerDomain(SETTINGS_IPC_CHANNELS, () =>
      registerSettingsIpc({
        ...dependencies,
        refreshActiveModelRuntimes: dependencies.runtime?.refreshActiveModelRuntimes,
        refreshMemoryConfiguration: dependencies.runtime?.refreshMemoryConfiguration,
      }),
    );
    registerDomain(PLUGIN_IPC_CHANNELS, () => registerPluginIpc(dependencies));
    registerDomain(BROWSER_IPC_CHANNELS, () => registerBrowserIpc(dependencies));
    registerRuntimeIpc(dependencies, registeredChannels, subscriptions);
  } catch (error) {
    try {
      disposeRegistration(registeredChannels, subscriptions);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "IPC registration and rollback failed");
    }
    throw error;
  }

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeRegistration(registeredChannels, subscriptions);
    },
  };
}

function registerWindowIpc(dependencies: ApplicationIpcDependencies): void {
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
    if (owner) void dependencies.dirtyGuard.requestClose(owner);
  });
}

function registerRuntimeIpc(
  dependencies: ApplicationIpcDependencies,
  registeredChannels: Set<string>,
  subscriptions: Array<() => void>,
): void {
  const shell = dependencies.runtime?.shell;
  if (shell) {
    for (const channel of SHELL_IPC_CHANNELS) registeredChannels.add(channel);
    ipcMain.handle(CHANNELS.shellRuntimeStatus, () => shell.getStatus());
    ipcMain.handle(CHANNELS.shellRuntimeInstall, () => shell.install());
    ipcMain.handle(CHANNELS.shellRuntimeChoose, async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: OpenDialogOptions = {
        title: "选择 Git Bash 可执行文件",
        properties: ["openFile"],
        filters: [{ name: "Bash executable", extensions: ["exe"] }],
      };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      const path = result.filePaths[0];
      return result.canceled || !path ? null : shell.use(path);
    });
    subscriptions.push(
      shell.onProgress((progress) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(CHANNELS.shellRuntimeProgress, progress);
        }
      }),
    );
  }
  const updater = dependencies.updater;
  if (!updater) return;
  for (const channel of UPDATER_IPC_CHANNELS) registeredChannels.add(channel);
  ipcMain.handle(CHANNELS.updaterGetState, () => updater.getState());
  ipcMain.handle(CHANNELS.updaterCheck, () => updater.check());
  ipcMain.handle(CHANNELS.updaterDownload, () => updater.download());
  ipcMain.handle(CHANNELS.updaterInstall, async () => {
    const confirmed = await dependencies.dirtyGuard.confirmApplicationQuit(BrowserWindow.getAllWindows());
    if (confirmed) updater.install();
  });
  subscriptions.push(
    updater.subscribe((state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(CHANNELS.updaterStateChanged, state);
        }
      }
    }),
  );
}

function disposeRegistration(channels: ReadonlySet<string>, subscriptions: Array<() => void>): void {
  const errors: unknown[] = [];
  for (const unsubscribe of subscriptions.splice(0)) {
    try {
      unsubscribe();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const channel of channels) {
    try {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose IPC registration");
}

/** 向所有 renderer 广播低频 thread catalog 更新。 */
/** 广播 session catalog 更新给所有 renderer。 */
export function broadcastThreadCatalogUpdate(thread: Thread): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.sessionsCatalogChanged, thread);
  }
}

/** 向所有 renderer 广播 PTY 增量事件。 */
/** 广播 terminal 增量事件给所有 renderer。 */
export function broadcastTerminalEvent(event: TerminalEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.terminalsEvent, event);
  }
}

/** 向所有 renderer 广播内置浏览器状态。 */
/** 广播浏览器状态变化给所有 renderer。 */
export function broadcastBrowserEvent(event: BrowserStateEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.browserStateChanged, event);
  }
}

/** 广播由工具触发的浏览器建 tab 请求。 */
export function broadcastBrowserCreateTabRequest(request: BrowserCreateTabRequest): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.browserCreateTabRequest, request);
  }
}

/** 广播由工具触发的浏览器关 tab 请求。 */
export function broadcastBrowserCloseTabRequest(request: BrowserCloseTabRequest): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.browserCloseTabRequest, request);
  }
}

/** 将密码保存提示发送给提交表单的 renderer。 */
export function sendBrowserPasswordOffer(offer: BrowserPasswordOffer, ownerWebContentsId: number): void {
  const owner = webContents.fromId(ownerWebContentsId);
  if (owner && !owner.isDestroyed()) owner.send(CHANNELS.browserPasswordOffer, offer);
}
