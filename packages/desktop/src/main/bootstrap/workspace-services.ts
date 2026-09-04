import { join } from "node:path";
import type { FileChangeSet, TerminalEvent } from "../../shared/contracts.ts";
import { ProjectFileWatcher } from "../files/file-watcher.ts";
import { OfficeDocumentPreviewService } from "../files/office-document-preview-service.ts";
import { ScmService } from "../scm/scm-service.ts";
import { ProjectScmWatcher } from "../scm/scm-watcher.ts";
import type { WorkspaceMutationPort } from "../session/workspace-mutation-port.ts";
import { createTerminalShellResolver, TerminalSupervisor } from "../terminal/terminal-supervisor.ts";
import type { CoreServices } from "./core-services.ts";
import type { PluginServices } from "./plugin-services.ts";
import type { DesktopRuntimeContext } from "./runtime-context.ts";
import type { SessionServices } from "./session-services.ts";

/** 工作区文件、SCM、终端和 Office 预览服务集合。 */
export interface WorkspaceServices {
  readonly scm: ScmService;
  readonly scmWatcher: ProjectScmWatcher;
  readonly fileWatcher: ProjectFileWatcher;
  readonly terminals: TerminalSupervisor;
  readonly officeDocuments: OfficeDocumentPreviewService;
  dispose(): void;
}

/** 工作区服务构造所需的依赖和 renderer 广播回调。 */
export interface WorkspaceServicesOptions {
  readonly context: DesktopRuntimeContext;
  readonly core: Pick<CoreServices, "projects">;
  readonly plugins: Pick<PluginServices, "pluginConfigurations">;
  readonly sessions: Pick<SessionServices, "workers">;
  readonly workspaceMutation: WorkspaceMutationPort;
  readonly publishScmChanged: (projectId: string) => void;
  readonly publishFileChanged: (change: FileChangeSet) => void;
  readonly publishTerminalEvent: (event: TerminalEvent) => void;
}

/** 构造工作区文件、SCM、终端和 Office 预览服务。 */
/** 构造工作区服务；中途失败时回滚已创建的 watcher 和 terminal。 */
export function createWorkspaceServices(options: WorkspaceServicesOptions): WorkspaceServices {
  const { context, core, plugins, sessions, workspaceMutation } = options;
  const scm = new ScmService(core.projects);
  const scmWatcher = new ProjectScmWatcher(core.projects, options.publishScmChanged);
  const fileWatcher = new ProjectFileWatcher(core.projects, options.publishFileChanged);
  let terminals: TerminalSupervisor | undefined;
  try {
    terminals = new TerminalSupervisor(
      core.projects,
      options.publishTerminalEvent,
      createTerminalShellResolver(context.agentDir, context.shellPath),
      (projectId, threadId) => sessions.workers.getSessionCwd(projectId, threadId),
    );
    workspaceMutation.bind(terminals);
    const officeDocuments = new OfficeDocumentPreviewService(core.projects, {
      cacheDir: join(context.userDataDir, "cache", "office-document-preview"),
      getConfiguration: async () => {
        try {
          const { values } = await plugins.pluginConfigurations.getRuntimeConfiguration("pi.officecli");
          return {
            installed: true,
            binaryPath: typeof values.binaryPath === "string" ? values.binaryPath : undefined,
            dataDir: typeof values.dataDir === "string" ? values.dataDir : undefined,
            version: typeof values.version === "string" ? values.version : undefined,
            autoDownload: typeof values.autoDownload === "boolean" ? values.autoDownload : undefined,
          };
        } catch {
          return {};
        }
      },
    });
    return createWorkspaceServiceResult(scm, scmWatcher, fileWatcher, terminals, officeDocuments, workspaceMutation);
  } catch (error) {
    if (terminals) {
      workspaceMutation.unbind(terminals);
      terminals.dispose();
    }
    fileWatcher.dispose();
    scmWatcher.stopAll();
    throw error;
  }
}

function createWorkspaceServiceResult(
  scm: ScmService,
  scmWatcher: ProjectScmWatcher,
  fileWatcher: ProjectFileWatcher,
  terminals: TerminalSupervisor,
  officeDocuments: OfficeDocumentPreviewService,
  workspaceMutation: WorkspaceMutationPort,
): WorkspaceServices {
  let disposed = false;
  return {
    scm,
    scmWatcher,
    fileWatcher,
    terminals,
    officeDocuments,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const [name, dispose] of [
        ["terminal capability", () => workspaceMutation.unbind(terminals)],
        ["SCM watcher", () => scmWatcher.stopAll()],
        ["file watcher", () => fileWatcher.dispose()],
        ["terminals", () => terminals.dispose()],
      ] as const) {
        try {
          dispose();
        } catch (error) {
          errors.push(new Error(`Failed to dispose ${name}`, { cause: error }));
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose workspace services");
    },
  };
}
