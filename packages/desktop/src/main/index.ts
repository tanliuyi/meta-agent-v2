import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { installExtension, REACT_DEVELOPER_TOOLS } from "electron-devtools-installer";
import windowStateKeeper from "electron-window-state";
import { CHANNELS } from "../shared/channels.ts";
import { DesktopApplication } from "./bootstrap/application.ts";
import { resolveDesktopRuntimeDirectories } from "./bootstrap/runtime-context.ts";
import { registerBrowserInternalScheme } from "./browser/browser-internal-page-protocol.ts";
import { installBrowserWebviewSecurity } from "./browser/browser-webview-policy.ts";
import { registerPdfPreviewScheme } from "./files/pdf-preview-protocol.ts";
import { registerLocalImageSchemes } from "./settings/user-avatar-protocol.ts";
import { parseRuntimeSetupSelection, runRuntimeSetup } from "./sidecar/runtime-setup.ts";
import type { TrayController } from "./tray.ts";
import type { WindowDirtyGuard } from "./window-dirty-guard.ts";

const appDir = dirname(fileURLToPath(import.meta.url));
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

const application = new DesktopApplication({
  app,
  appDir,
  resourcesPath: process.resourcesPath,
  ...(process.env.ELECTRON_RENDERER_URL ? { rendererUrl: process.env.ELECTRON_RENDERER_URL } : {}),
  installDevTools: installReactDevTools,
  createWindow,
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  if (runtimeSetupSelection) {
    const { userDataDir, agentDir } = resolveDesktopRuntimeDirectories(app);
    try {
      await runRuntimeSetup(userDataDir, agentDir, runtimeSetupSelection);
      app.exit(0);
    } catch (error) {
      console.error("Runtime setup failed:", error);
      app.exit(1);
    }
    return;
  }
  try {
    await application.start();
  } catch (error) {
    console.error("Desktop startup failed:", error);
    app.exit(1);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) application.openWindow();
});

app.on("before-quit", (event) => application.requestQuit(event));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

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
function createWindow(dependencies: { dirtyGuard: WindowDirtyGuard; trayController: TrayController }): BrowserWindow {
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
  dependencies.dirtyGuard.attach(window);
  dependencies.trayController.attach(window);
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
      void dependencies.dirtyGuard.requestReload(window);
    } else if (isDevToolsKey && (isMac ? input.alt && !input.shift : input.shift && !input.alt)) {
      event.preventDefault();
      window.webContents.toggleDevTools();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(appDir, "../renderer/index.html"));
  return window;
}
