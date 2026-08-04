import type { WorkbenchState } from "../../../../shared/contracts.ts";

interface ClosedWorkbenchFileState {
  openFiles: string[];
  activeFile: string | undefined;
}

export interface WorkbenchFileOpenState {
  openFiles: string[];
  activeFile: string;
  previewFile: string;
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

/** 判断路径是否为支持预览的图片文件。 */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
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
    const replaced = openFiles.map((openPath) => (openPath === previewFile ? path : openPath));
    return {
      openFiles: replaced.includes(path) ? replaced : [...replaced, path],
      activeFile: path,
      previewFile: path,
    };
  }
  return {
    openFiles: openFiles.includes(path) ? [...openFiles] : [...openFiles, path],
    activeFile: path,
    previewFile: path,
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
