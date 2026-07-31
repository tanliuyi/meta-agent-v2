import type { WorkbenchState } from "../../../../shared/contracts.ts";

export type WorkbenchPanelValue = Exclude<WorkbenchState["panel"], "chat">;

interface ClosedWorkbenchFileState {
  openFiles: string[];
  activeFile: string | undefined;
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

/** 将历史 chat Panel 值收敛到当前可见的默认文件 Panel。 */
export function normalizeWorkbenchPanel(panel: WorkbenchState["panel"] | null): WorkbenchPanelValue {
  return panel === "terminal" || panel === "tasks" ? panel : "files";
}

/** 校验 Radix Tabs 返回的值属于可见 Workbench Panel。 */
export function isWorkbenchPanelValue(value: string): value is WorkbenchPanelValue {
  return value === "terminal" || value === "files" || value === "tasks";
}
