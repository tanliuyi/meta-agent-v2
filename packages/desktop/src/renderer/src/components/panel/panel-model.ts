import type { WorkbenchState } from "../../../../shared/contracts.ts";

export type WorkbenchPanelValue = Exclude<WorkbenchState["panel"], "chat">;

/** 将历史 chat Panel 值收敛到当前可见的默认文件 Panel。 */
export function normalizeWorkbenchPanel(panel: WorkbenchState["panel"] | null): WorkbenchPanelValue {
  return panel === "terminal" || panel === "tasks" ? panel : "files";
}

/** 校验 Radix Tabs 返回的值属于可见 Workbench Panel。 */
export function isWorkbenchPanelValue(value: string): value is WorkbenchPanelValue {
  return value === "terminal" || value === "files" || value === "tasks";
}
