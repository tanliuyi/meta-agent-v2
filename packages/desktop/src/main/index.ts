import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu } from "electron";
import { CHANNELS } from "../shared/channels.ts";
import { FileService } from "./files/file-service.ts";
import { broadcastTerminalEvent, registerIpc } from "./ipc.ts";
import { SessionSupervisor } from "./pi/session-supervisor.ts";
import { ProjectStore } from "./store/project-store.ts";
import { TerminalSupervisor } from "./terminal/terminal-supervisor.ts";

let sessions: SessionSupervisor | undefined;
let terminals: TerminalSupervisor | undefined;
const appDir = dirname(fileURLToPath(import.meta.url));

if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
}

/** 创建主工作台窗口。 */
function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
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
      window.webContents.reload();
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
  Menu.setApplicationMenu(null);
  const projects = new ProjectStore(join(app.getPath("userData"), "desktop-state.json"));
  await projects.load();
  sessions = new SessionSupervisor(projects);
  terminals = new TerminalSupervisor(projects, broadcastTerminalEvent);
  registerIpc(projects, sessions, new FileService(projects), terminals);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
  if (!sessions && !terminals) return;
  event.preventDefault();
  const currentSessions = sessions;
  const currentTerminals = terminals;
  sessions = undefined;
  terminals = undefined;
  currentTerminals?.dispose();
  void (currentSessions?.dispose() ?? Promise.resolve()).finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
