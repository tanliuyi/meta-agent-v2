import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { CHANNELS } from "../../shared/channels.ts";
import type { OpenLinkResult, WorkbenchState } from "../../shared/contracts.ts";
import { filePathWithoutLocation } from "../../shared/file-location.ts";
import type { FileService } from "../files/file-service.ts";
import type { ProjectFileWatcher } from "../files/file-watcher.ts";
import type { OfficeDocumentPreviewService } from "../files/office-document-preview-service.ts";
import type { ScmService } from "../scm/scm-service.ts";
import type { ProjectScmWatcher } from "../scm/scm-watcher.ts";
import type { ProjectStore } from "../store/project-store.ts";
import type { TerminalSupervisor } from "../terminal/terminal-supervisor.ts";
import { openPath } from "./ipc-shared.ts";

/** 工作区 IPC 所需的项目、文件、SCM 和 terminal 服务。 */
export interface WorkspaceIpcDependencies {
  readonly projects: ProjectStore;
  readonly scm: ScmService;
  readonly scmWatcher: ProjectScmWatcher;
  readonly files: FileService;
  readonly officeDocuments: OfficeDocumentPreviewService;
  readonly fileWatcher: ProjectFileWatcher;
  readonly terminals: TerminalSupervisor;
}

/** workspace registrar 可能注册的 channel 清单。 */
export const WORKSPACE_IPC_CHANNELS = [
  CHANNELS.linksOpen,
  CHANNELS.projectsList,
  CHANNELS.projectsActive,
  CHANNELS.projectsChoose,
  CHANNELS.projectsOpen,
  CHANNELS.projectsRename,
  CHANNELS.projectsOpenExternally,
  CHANNELS.projectsRemove,
  CHANNELS.projectsWorktrees,
  CHANNELS.scmGetSnapshot,
  CHANNELS.scmGetDiff,
  CHANNELS.scmStage,
  CHANNELS.scmUnstage,
  CHANNELS.scmDiscard,
  CHANNELS.scmWatch,
  CHANNELS.scmUnwatch,
  CHANNELS.filesList,
  CHANNELS.filesRead,
  CHANNELS.filesReadImage,
  CHANNELS.filesPreviewPdf,
  CHANNELS.filesPreviewOfficeDocument,
  CHANNELS.filesCancelOfficeDocumentPreview,
  CHANNELS.filesWatch,
  CHANNELS.filesUnwatch,
  CHANNELS.filesResolvePath,
  CHANNELS.filesOpen,
  CHANNELS.filesCopy,
  CHANNELS.filesCut,
  CHANNELS.filesPaste,
  CHANNELS.filesCreateFolder,
  CHANNELS.filesRename,
  CHANNELS.filesRemove,
  CHANNELS.terminalsOpen,
  CHANNELS.terminalsWrite,
  CHANNELS.terminalsResize,
  CHANNELS.terminalsRestart,
  CHANNELS.terminalsDispose,
  CHANNELS.workbenchGet,
  CHANNELS.workbenchUpdate,
] as const;

/** 注册项目、SCM、文件、terminal 和 workbench IPC。 */
export function registerWorkspaceIpc(dependencies: WorkspaceIpcDependencies): readonly string[] {
  const { projects, scm, scmWatcher, files, officeDocuments, fileWatcher, terminals } = dependencies;
  const officePreviewOwners = new Set<number>();
  ipcMain.handle(CHANNELS.linksOpen, (_event, projectId: string, target: string) =>
    openLink(projectId, target, projects),
  );
  ipcMain.handle(CHANNELS.projectsList, () => projects.list());
  ipcMain.handle(CHANNELS.projectsActive, () => projects.getActive());
  ipcMain.handle(CHANNELS.projectsChoose, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? null : projects.add(result.filePaths[0]);
  });
  ipcMain.handle(CHANNELS.projectsOpen, (_event, projectId: string) => projects.open(projectId));
  ipcMain.handle(CHANNELS.projectsRename, (_event, projectId: string, name: string) =>
    projects.rename(projectId, name),
  );
  ipcMain.handle(CHANNELS.projectsOpenExternally, async (_event, projectId: string) =>
    openPath(projects.getCwd(projectId)),
  );
  ipcMain.handle(CHANNELS.projectsRemove, async (_event, projectId: string) => {
    terminals.disposeProject(projectId);
    return projects.remove(projectId);
  });
  ipcMain.handle(CHANNELS.projectsWorktrees, (_event, projectId: string) => projects.listWorktrees(projectId));
  ipcMain.handle(CHANNELS.scmGetSnapshot, (_event, projectId: string) => scm.getSnapshot(projectId));
  ipcMain.handle(CHANNELS.scmGetDiff, (_event, projectId: string, path: string, staged?: boolean) =>
    scm.getDiff(projectId, path, staged),
  );
  ipcMain.handle(CHANNELS.scmStage, (_event, projectId: string, path: string) => scm.stage(projectId, path));
  ipcMain.handle(CHANNELS.scmUnstage, (_event, projectId: string, path: string) => scm.unstage(projectId, path));
  ipcMain.handle(CHANNELS.scmDiscard, (_event, projectId: string, path: string) => scm.discard(projectId, path));
  ipcMain.handle(CHANNELS.scmWatch, (_event, projectId: string) => scmWatcher.watch(projectId));
  ipcMain.handle(CHANNELS.scmUnwatch, (_event, projectId: string) => scmWatcher.unwatch(projectId));
  ipcMain.handle(CHANNELS.filesList, (event, projectId: string, path?: string, query?: string, requestGroup?: string) =>
    files.list(projectId, path, query, `${event.sender.id}\0${requestGroup ?? "default"}`),
  );
  ipcMain.handle(CHANNELS.filesRead, (_event, projectId: string, path: string) => files.read(projectId, path));
  ipcMain.handle(CHANNELS.filesReadImage, (_event, projectId: string, path: string) =>
    files.readImage(projectId, path),
  );
  ipcMain.handle(CHANNELS.filesPreviewPdf, (_event, projectId: string, path: string) =>
    files.previewPdf(projectId, path),
  );
  ipcMain.handle(CHANNELS.filesPreviewOfficeDocument, (event, projectId: string, path: string) => {
    const ownerId = event.sender.id;
    if (!officePreviewOwners.has(ownerId)) {
      officePreviewOwners.add(ownerId);
      event.sender.once("destroyed", () => {
        officePreviewOwners.delete(ownerId);
        officeDocuments.cancelOwner(ownerId);
      });
    }
    return officeDocuments.preview(ownerId, projectId, path);
  });
  ipcMain.handle(CHANNELS.filesCancelOfficeDocumentPreview, (event) => officeDocuments.cancelOwner(event.sender.id));
  ipcMain.handle(CHANNELS.filesWatch, (_event, projectId: string) => fileWatcher.watch(projectId));
  ipcMain.handle(CHANNELS.filesUnwatch, (_event, projectId: string) => fileWatcher.unwatch(projectId));
  ipcMain.handle(CHANNELS.filesResolvePath, (_event, projectId: string, path: string) =>
    resolveFilePath(projectId, path, projects),
  );
  ipcMain.handle(CHANNELS.filesOpen, async (_event, projectId: string, path: string) =>
    openPath(await resolveFilePath(projectId, path, projects)),
  );
  ipcMain.handle(CHANNELS.filesCopy, (_event, projectId: string, paths: string[]) => files.copy(projectId, paths));
  ipcMain.handle(CHANNELS.filesCut, (_event, projectId: string, paths: string[]) => files.cut(projectId, paths));
  ipcMain.handle(CHANNELS.filesPaste, (_event, projectId: string, destinationPath: string) =>
    files.paste(projectId, destinationPath),
  );
  ipcMain.handle(CHANNELS.filesCreateFolder, (_event, projectId: string, parentPath: string, name: string) =>
    files.createFolder(projectId, parentPath, name),
  );
  ipcMain.handle(CHANNELS.filesRename, (_event, projectId: string, path: string, name: string) =>
    files.rename(projectId, path, name),
  );
  ipcMain.handle(CHANNELS.filesRemove, (_event, projectId: string, path: string) => files.remove(projectId, path));
  ipcMain.handle(
    CHANNELS.terminalsOpen,
    (_event, projectId: string, threadId: string, terminalId: string, cols: number, rows: number) =>
      terminals.open(projectId, threadId, terminalId, cols, rows),
  );
  ipcMain.handle(
    CHANNELS.terminalsWrite,
    (_event, projectId: string, threadId: string, terminalId: string, data: string) =>
      terminals.write(projectId, threadId, terminalId, data),
  );
  ipcMain.handle(
    CHANNELS.terminalsResize,
    (_event, projectId: string, threadId: string, terminalId: string, cols: number, rows: number) =>
      terminals.resize(projectId, threadId, terminalId, cols, rows),
  );
  ipcMain.handle(
    CHANNELS.terminalsRestart,
    (_event, projectId: string, threadId: string, terminalId: string, cols: number, rows: number) =>
      terminals.restart(projectId, threadId, terminalId, cols, rows),
  );
  ipcMain.handle(CHANNELS.terminalsDispose, (_event, projectId: string, threadId: string, terminalId: string) =>
    terminals.disposeTerminal(projectId, threadId, terminalId),
  );
  ipcMain.handle(CHANNELS.workbenchGet, (_event, projectId: string, threadId: string) =>
    projects.getWorkbench(projectId, threadId),
  );
  ipcMain.handle(CHANNELS.workbenchUpdate, (_event, state: WorkbenchState) => projects.setWorkbench(state));
  return WORKSPACE_IPC_CHANNELS;
}

async function openLink(projectId: string, target: string, projects: ProjectStore): Promise<OpenLinkResult> {
  const value = target.trim();
  if (!value) throw new Error("Cannot open an empty link");
  const localTarget = value.split(/[?#]/, 1)[0];
  if (!localTarget) throw new Error("Cannot open a link without a file path");
  if (isAbsolute(localTarget)) return openLocalPath(projectId, decodeURIComponent(localTarget), projects);
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    return openLocalPath(projectId, resolve(projects.getCwd(projectId), decodeURIComponent(localTarget)), projects);
  }
  if (url.protocol === "file:") return openLocalPath(projectId, fileURLToPath(url), projects);
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:") {
    await shell.openExternal(url.href);
    return { openInApp: false };
  }
  throw new Error(`Unsupported link protocol: ${url.protocol}`);
}

async function openLocalPath(projectId: string, absolutePath: string, projects: ProjectStore): Promise<OpenLinkResult> {
  const normalizedPath = normalizeLocalFilePath(absolutePath);
  const cwd = projects.getCwd(projectId);
  const rel = relative(cwd, normalizedPath);
  if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    let isDirectory = false;
    try {
      isDirectory = statSync(resolve(cwd, rel)).isDirectory();
    } catch {
      /* 读取侧报告不可访问路径。 */
    }
    if (!isDirectory) return { openInApp: true, path: rel.split(sep).join("/") };
  }
  await openPath(normalizedPath);
  return { openInApp: false };
}

function normalizeLocalFilePath(path: string): string {
  const pathWithoutLocation = filePathWithoutLocation(path);
  if (pathWithoutLocation === path) return path;
  try {
    if (statSync(path).isFile()) return path;
  } catch {
    /* 继续检查候选路径。 */
  }
  try {
    if (statSync(pathWithoutLocation).isFile()) return pathWithoutLocation;
  } catch {
    /* 保留原路径。 */
  }
  return path;
}

async function resolveFilePath(projectId: string, path: string, projects: ProjectStore): Promise<string> {
  const value = path.trim();
  if (!value) throw new Error("Cannot resolve an empty file path");
  return isAbsolute(value) ? value : resolve(projects.getCwd(projectId), value);
}
