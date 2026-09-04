import { getShellConfig, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ShellRuntimeStatus } from "../../shared/desktop-api.ts";
import { type IpcRegistration, registerIpc } from "../ipc.ts";
import { SHELL_RUNTIME_VERSION, shellRuntimeInstallUrl } from "../sidecar/shell-runtime-installer.ts";
import { saveShellRuntimePath } from "../sidecar/shell-runtime-settings.ts";
import { validateBashRuntime } from "../sidecar/shell-runtime-validator.ts";
import type { AutoUpdateService } from "../updater.ts";
import type { WindowDirtyGuard } from "../window-dirty-guard.ts";
import type { BrowserServices } from "./browser-services.ts";
import type { CoreServices } from "./core-services.ts";
import type { PluginServices } from "./plugin-services.ts";
import type { DesktopRuntimeContext } from "./runtime-context.ts";
import type { SessionServices } from "./session-services.ts";
import type { WorkspaceServices } from "./workspace-services.ts";

/** 将 bootstrap 服务图映射为 IPC 命名依赖。 */
export interface ApplicationIpcServices {
  readonly context: DesktopRuntimeContext;
  readonly core: CoreServices;
  readonly plugins: PluginServices;
  readonly sessions: SessionServices;
  readonly workspace: WorkspaceServices;
  readonly browser: BrowserServices;
  readonly updater: AutoUpdateService;
  readonly dirtyGuard: WindowDirtyGuard;
}

/** 将完整服务图转换为 IPC 的命名依赖对象。 */
/** 注册完整桌面应用的所有领域 IPC。 */
export function registerApplicationIpc(services: ApplicationIpcServices): IpcRegistration {
  const { context, core, plugins, sessions, workspace, browser, updater, dirtyGuard } = services;
  return registerIpc({
    projects: core.projects,
    sessions: sessions.sessions,
    scm: workspace.scm,
    scmWatcher: workspace.scmWatcher,
    files: core.files,
    officeDocuments: workspace.officeDocuments,
    fileWatcher: workspace.fileWatcher,
    terminals: workspace.terminals,
    models: core.models,
    auth: core.auth,
    providers: core.providers,
    settings: core.settings,
    dirtyGuard,
    runtime: {
      refreshActiveModelRuntimes: () => sessions.refreshActiveModelRuntimes(),
      refreshMemoryConfiguration: () => sessions.refreshMemoryConfiguration(),
      shell: createShellRuntimeDependencies(context, core),
    },
    updater,
    extensions: plugins.extensionSettings,
    subagents: sessions.subagentSettings,
    marketplaceEndpoints: plugins.marketplaceEndpoints,
    marketplaceCatalog: plugins.marketplaceCatalog,
    marketplaceRegistry: plugins.marketplaceRegistry,
    marketplaceInstaller: plugins.marketplaceInstaller,
    pluginConfigurations: plugins.pluginConfigurations,
    memorySettings: core.memorySettings,
    autoTitle: core.autoTitleSettings,
    preferences: core.preferences,
    browser: browser.manager,
  });
}

function createShellRuntimeDependencies(context: DesktopRuntimeContext, core: CoreServices) {
  const activeCwd = async (): Promise<string> => (await core.projects.getActive())?.cwd ?? process.cwd();
  return {
    getStatus: async (): Promise<ShellRuntimeStatus> => {
      const cwd = await activeCwd();
      const configuredShellPath = SettingsManager.create(cwd, context.agentDir).getShellPath();
      const shellPath = configuredShellPath ?? context.shellPath;
      if (!shellPath) {
        return {
          state: "missing",
          message: "未找到 Git for Windows；WSL bash 不支持",
          installUrl: shellRuntimeInstallUrl(),
        };
      }
      try {
        const shell = getShellConfig(shellPath).shell;
        const runtime = await validateBashRuntime(shell);
        return {
          state: "ready",
          path: runtime.path,
          version: shell === context.shellInstaller.installedBashPath() ? SHELL_RUNTIME_VERSION : runtime.version,
          message: `Git Bash ${runtime.version} 可用`,
          installUrl: shellRuntimeInstallUrl(),
        };
      } catch (error) {
        return {
          state: configuredShellPath ? "invalid" : "missing",
          path: shellPath,
          message: error instanceof Error ? error.message : String(error),
          installUrl: shellRuntimeInstallUrl(),
        };
      }
    },
    install: async (): Promise<ShellRuntimeStatus> => {
      const cwd = await activeCwd();
      const status = await context.shellInstaller.install();
      if (!status.path) throw new Error("Git Bash 安装完成但未返回可执行文件路径");
      await saveShellRuntimePath(cwd, context.agentDir, status.path);
      return status;
    },
    use: async (path: string): Promise<ShellRuntimeStatus> => {
      const cwd = await activeCwd();
      const runtime = await validateBashRuntime(path);
      await saveShellRuntimePath(cwd, context.agentDir, runtime.path);
      return {
        state: "ready",
        path: runtime.path,
        version: runtime.version,
        message: `Git Bash ${runtime.version} 可用`,
        installUrl: shellRuntimeInstallUrl(),
      };
    },
    onProgress: (listener: Parameters<DesktopRuntimeContext["shellInstaller"]["onProgress"]>[0]) =>
      context.shellInstaller.onProgress(listener),
  };
}
