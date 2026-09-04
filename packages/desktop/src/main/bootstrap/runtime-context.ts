import { homedir } from "node:os";
import { join } from "node:path";
import type { app as electronApp } from "electron";
import { locateGitForWindowsBash, locateManagedBash } from "../sidecar/managed-shell-locator.ts";
import { ShellRuntimeInstaller } from "../sidecar/shell-runtime-installer.ts";
import { SidecarLog } from "../sidecar/sidecar-log.ts";
import { loadSidecarRuntimeManifest, type SidecarRuntimeManifest } from "../sidecar/sidecar-runtime-manifest.ts";

/** 创建主进程运行时上下文所需的 Electron 路径和应用信息。 */
export interface DesktopRuntimeContextOptions {
  readonly app: Pick<typeof electronApp, "getPath" | "isPackaged">;
  readonly appDir: string;
  readonly resourcesPath: string;
}

/** runtime setup 阶段可提前解析的持久化目录。 */
export interface DesktopRuntimeDirectories {
  readonly userDataDir: string;
  readonly agentDir: string;
}

/** 启动期间由各 bootstrap factory 共享的只读运行时上下文。 */
export interface DesktopRuntimeContext {
  readonly appDir: string;
  readonly userDataDir: string;
  readonly agentDir: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly manifest: SidecarRuntimeManifest;
  readonly shellInstaller: ShellRuntimeInstaller;
  readonly shellPath?: string;
  readonly sidecarLog: SidecarLog;
}

/** 构造主进程服务共享的路径、运行时和 shell 上下文。 */
/** 校验 sidecar manifest，并构造日志、shell 与持久化路径上下文。 */
export function createDesktopRuntimeContext(options: DesktopRuntimeContextOptions): DesktopRuntimeContext {
  const { app, appDir, resourcesPath } = options;
  const { userDataDir, agentDir } = resolveDesktopRuntimeDirectories(app);
  const shellInstaller = new ShellRuntimeInstaller(userDataDir, () => undefined);
  const managedBashPath = locateManagedBash({
    isPackaged: app.isPackaged,
    resourcesPath,
    appDir,
  });
  const installedBashPath = shellInstaller.installedBashPath();
  const shellPath = managedBashPath ?? installedBashPath ?? locateGitForWindowsBash();
  const manifest = loadSidecarRuntimeManifest({
    isPackaged: app.isPackaged,
    resourcesPath,
    appDir,
  });
  const sidecarLog = new SidecarLog(userDataDir);
  sidecarLog.write("main", `Sidecar log initialized at ${sidecarLog.path}`);

  return {
    appDir,
    userDataDir,
    agentDir,
    isPackaged: app.isPackaged,
    resourcesPath,
    manifest,
    shellInstaller,
    ...(shellPath ? { shellPath } : {}),
    sidecarLog,
  };
}

/** runtime setup 只需要目录，不能提前加载或校验 sidecar manifest。 */
/** 只解析 runtime setup 必需的目录，不读取或校验 sidecar manifest。 */
export function resolveDesktopRuntimeDirectories(app: Pick<typeof electronApp, "getPath">): DesktopRuntimeDirectories {
  return {
    userDataDir: app.getPath("userData"),
    agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  };
}
