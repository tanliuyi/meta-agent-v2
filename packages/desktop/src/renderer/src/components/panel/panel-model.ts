import type { WorkbenchState } from "../../../../shared/contracts.ts";

export const PROJECT_EDITOR_TAB_DRAG_MIME = "application/x-meta-agent-editor-tab";
export const PROJECT_FILE_DRAG_MIME = "application/x-meta-agent-project-file";

interface ClosedWorkbenchFileState {
  openFiles: string[];
  activeFile: string | undefined;
}

export interface ClosedProjectDocumentTabs {
  tabs: string[];
  mru: string[];
  activeTab: string | undefined;
}

export interface WorkbenchFileOpenState {
  openFiles: string[];
  activeFile: string;
  previewFile: string | undefined;
}

export interface FilePathSegment {
  label: string;
  path: string;
  directory: boolean;
}

export function filePathSegments(path: string): FilePathSegment[] {
  const labels = path.split("/").filter(Boolean);
  return labels.map((label, index) => ({
    label,
    path: labels.slice(0, index + 1).join("/"),
    directory: index < labels.length - 1,
  }));
}

/** 相对路径的父目录；根目录返回空字符串。 */
export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const OFFICE_DOCUMENT_EXTENSIONS = new Set(["docx", "pptx", "xlsx"]);

function extensionOf(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? null : path.slice(dot + 1).toLowerCase();
}

/** 判断路径是否为支持预览的图片文件。 */
export function isImagePath(path: string): boolean {
  const extension = extensionOf(path);
  return extension !== null && IMAGE_EXTENSIONS.has(extension);
}

/** 判断路径是否为可由 OfficeCLI 预览的 OOXML 文档。 */
export function isOfficeDocumentPath(path: string): boolean {
  const extension = extensionOf(path);
  return extension !== null && OFFICE_DOCUMENT_EXTENSIONS.has(extension);
}

/** 判断路径是否为 PDF 文档。 */
export function isPdfPath(path: string): boolean {
  return extensionOf(path) === "pdf";
}

/** 在当前活动 tab 中打开文件，并去除可能出现的重复目标 tab。 */
export function replaceActiveWorkbenchFile(
  openFiles: readonly string[],
  activeFile: string | null,
  path: string,
): ClosedWorkbenchFileState {
  const nextOpenFiles =
    activeFile && openFiles.includes(activeFile)
      ? openFiles.map((openPath) => (openPath === activeFile ? path : openPath))
      : [...openFiles, path];
  return {
    openFiles: [...new Set(nextOpenFiles)],
    activeFile: path,
  };
}

/** 关闭文件并在需要时选择原位置右侧、否则左侧的相邻文件。 */
export function closeWorkbenchFile(
  openFiles: readonly string[],
  activeFile: string | null,
  path: string,
): ClosedWorkbenchFileState | null {
  const closedIndex = openFiles.indexOf(path);
  if (closedIndex === -1) return null;
  const nextOpenFiles = openFiles.filter((openPath) => openPath !== path);
  return {
    openFiles: nextOpenFiles,
    activeFile:
      activeFile === path ? nextOpenFiles[Math.min(closedIndex, nextOpenFiles.length - 1)] : (activeFile ?? undefined),
  };
}

/** Filter stale keys, preserve stored order, then append newly opened editors. */
export function reconcileProjectDocumentTabs(available: readonly string[], stored: readonly string[]): string[] {
  const availableSet = new Set(available);
  const seen = new Set<string>();
  const tabs: string[] = [];
  for (const key of [...stored, ...available]) {
    if (!availableSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    tabs.push(key);
  }
  return tabs;
}

/** Record an editor as most recently active while dropping stale and duplicate keys. */
export function activateProjectDocumentTab(mru: readonly string[], tabs: readonly string[], key: string): string[] {
  const tabSet = new Set(tabs);
  return [key, ...mru, ...tabs].filter(
    (candidate, index, values) => tabSet.has(candidate) && values.indexOf(candidate) === index,
  );
}

/** Close an editor using VS Code's default recent-editor selection policy. */
export function closeProjectDocumentTab(
  tabs: readonly string[],
  mru: readonly string[],
  activeTab: string | undefined,
  key: string,
): ClosedProjectDocumentTabs | null {
  const closedIndex = tabs.indexOf(key);
  if (closedIndex === -1) return null;
  const nextTabs = tabs.filter((candidate) => candidate !== key);
  const nextMru = mru.filter((candidate) => candidate !== key && nextTabs.includes(candidate));
  if (activeTab !== key) return { tabs: nextTabs, mru: nextMru, activeTab };
  return {
    tabs: nextTabs,
    mru: nextMru,
    activeTab: nextMru[0] ?? nextTabs[Math.min(closedIndex, nextTabs.length - 1)],
  };
}

/** Open an editor at the end or replace a preview editor in place. */
export function openProjectDocumentTab(tabs: readonly string[], key: string, replaceKey?: string): string[] {
  if (tabs.includes(key))
    return replaceKey && replaceKey !== key ? tabs.filter((tab) => tab !== replaceKey) : [...tabs];
  const replaceIndex = replaceKey ? tabs.indexOf(replaceKey) : -1;
  if (replaceIndex === -1) return [...tabs, key];
  const next = [...tabs];
  next.splice(replaceIndex, 1, key);
  return next;
}

/** Move one editor tab before another, preserving all other positions. */
export function moveProjectDocumentTab(tabs: readonly string[], source: string, target: string): string[] {
  const sourceIndex = tabs.indexOf(source);
  const targetIndex = tabs.indexOf(target);
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return [...tabs];
  const next = [...tabs];
  next.splice(sourceIndex, 1);
  next.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, source);
  return next;
}

export interface OpenPinnedWorkbenchFileState {
  openFiles: string[];
  activeFile: string;
  previewFile: string | undefined;
}

/** Open a file as a pinned editor without replacing an existing preview editor. */
export function openPinnedWorkbenchFile(
  openFiles: readonly string[],
  previewFile: string | undefined,
  path: string,
): OpenPinnedWorkbenchFileState {
  return {
    openFiles: openFiles.includes(path) ? [...openFiles] : [...openFiles, path],
    activeFile: path,
    previewFile: previewFile === path ? undefined : previewFile,
  };
}

/**
 * 单击打开文件（VS Code 预览 tab 行为）：
 * 已有预览 tab 且目标不同时原地替换；否则追加为新预览 tab。
 */
export function openWorkbenchFileAsPreview(
  openFiles: readonly string[],
  previewFile: string | undefined,
  path: string,
): WorkbenchFileOpenState {
  if (previewFile && previewFile !== path) {
    if (openFiles.includes(path)) {
      return {
        openFiles: openFiles.filter((openPath) => openPath !== previewFile),
        activeFile: path,
        previewFile: undefined,
      };
    }
    const previewIndex = openFiles.indexOf(previewFile);
    if (previewIndex === -1) {
      return {
        openFiles: [...openFiles, path],
        activeFile: path,
        previewFile: path,
      };
    }
    return {
      openFiles: openFiles.map((openPath) => (openPath === previewFile ? path : openPath)),
      activeFile: path,
      previewFile: path,
    };
  }
  const alreadyOpen = openFiles.includes(path);
  return {
    openFiles: alreadyOpen ? [...openFiles] : [...openFiles, path],
    activeFile: path,
    previewFile: alreadyOpen ? previewFile : path,
  };
}

/** 固定预览 tab（树/标签页双击或 pin 按钮）；非预览目标返回 null。 */
export function pinWorkbenchFile(previewFile: string | undefined, path: string): { previewFile: undefined } | null {
  return previewFile === path ? { previewFile: undefined } : null;
}

/** 计算展开给定路径所需的缺失父目录链；已全部展开时返回 null。 */
export function missingExpandedDirectories(expandedPaths: readonly string[], path: string): string[] | null {
  const missing = filePathSegments(path)
    .filter((segment) => segment.directory)
    .map((segment) => segment.path)
    .filter((parent) => !expandedPaths.includes(parent));
  return missing.length > 0 ? missing : null;
}

/** 打开文件为预览 tab，并展开其父目录链（对齐 VS Code explorer.autoReveal）。 */
export function openWorkbenchFilePatch(
  workbench: Pick<WorkbenchState, "openFiles" | "previewFile" | "expandedPaths">,
  path: string,
): Partial<WorkbenchState> {
  const opened = openWorkbenchFileAsPreview(workbench.openFiles, workbench.previewFile, path);
  const missingDirectories = missingExpandedDirectories(workbench.expandedPaths, path);
  return {
    ...opened,
    ...(missingDirectories ? { expandedPaths: [...workbench.expandedPaths, ...missingDirectories] } : {}),
  };
}
