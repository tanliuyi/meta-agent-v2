import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { Menu, nativeImage, Tray } from "electron";

export interface TrayControllerDependencies {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** 主进程输出目录（out/main），用于解析开发期源码树下的构建资源。 */
  appDir: string;
  resourcesPath: string;
  quit: () => void;
}

/** Windows 托盘图标路径：发布版从 resources 读取，开发版读取仓库 build/icon.ico。 */
export function resolveTrayIconPath(deps: TrayControllerDependencies): string | undefined {
  if (deps.platform !== "win32") return undefined;
  return deps.isPackaged ? join(deps.resourcesPath, "tray-icon.ico") : join(deps.appDir, "../../build/icon.ico");
}

/** 系统托盘控制器：Windows 上关闭按钮只隐藏窗口到托盘，托盘菜单恢复窗口或真正退出。 */
export class TrayController {
  private readonly deps: TrayControllerDependencies;
  private tray: Tray | undefined;
  private quitting = false;

  constructor(deps: TrayControllerDependencies) {
    this.deps = deps;
  }

  /** 创建托盘并接管窗口的关闭行为；非 Windows 或图标加载失败时返回 false（不拦截关闭）。 */
  attach(window: BrowserWindow): boolean {
    if (this.tray) return true;
    const iconPath = resolveTrayIconPath(this.deps);
    if (!iconPath) return false;
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      console.warn(`Tray icon 加载失败: ${iconPath}`);
      return false;
    }
    const tray = new Tray(icon);
    tray.setToolTip("Meta Agent");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示主窗口", click: () => showMainWindow(window) },
        { type: "separator" },
        { label: "退出", click: () => this.deps.quit() },
      ]),
    );
    tray.on("click", () => showMainWindow(window));
    this.tray = tray;
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
    return true;
  }

  /** 应用退出流程开始后放行窗口关闭（托盘菜单退出、系统退出等）。 */
  markQuitting(): void {
    this.quitting = true;
  }

  /** 销毁托盘图标，幂等；应用退出流程中调用。 */
  dispose(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
}

function showMainWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
