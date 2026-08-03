import type { FocusEvent } from "react";
import type { FileNode } from "../../../../../shared/contracts.ts";

const TREE_ITEM_SELECTOR = '[role="treeitem"]';

/** 虚拟化树的扁平行：节点行或目录加载占位行。 */
export interface FileTreeRow {
  kind: "node" | "loading";
  path: string;
  depth: number;
  open: boolean;
  node?: FileNode;
}

/** 将最近聚焦的 treeitem 设为唯一 Tab 停靠点，不触发 React render。 */
export function setFileTreeRovingTabStop(event: FocusEvent<HTMLButtonElement>): void {
  const tree = event.currentTarget.closest<HTMLElement>('[role="tree"]');
  if (!tree) return;
  for (const item of tree.querySelectorAll<HTMLButtonElement>(TREE_ITEM_SELECTOR)) item.tabIndex = -1;
  event.currentTarget.tabIndex = 0;
}

export type FileTreeNavigationAction = { kind: "move"; index: number } | { kind: "toggle" } | null;

/** 键盘翻页步长（PageUp/PageDown 一次移动的行数）。 */
export const FILE_TREE_PAGE_SIZE = 20;

/**
 * 基于扁平行数组实现 ARIA tree 的方向键、Home/End、翻页与目录展开收起契约。
 * 与 DOM 渲染无关，可在虚拟滚动下直接使用。
 */
export function fileTreeKeyNavigation(
  rows: readonly FileTreeRow[],
  index: number,
  key: string,
): FileTreeNavigationAction {
  const row = rows[index];
  if (!row || row.kind !== "node" || !row.node) return null;

  const isDirectory = row.node.type === "directory";
  if (key === "ArrowDown") return moveIfInRange(rows, index + 1);
  if (key === "ArrowUp") return moveIfInRange(rows, index - 1);
  if (key === "PageDown") return moveIfInRange(rows, index + FILE_TREE_PAGE_SIZE);
  if (key === "PageUp") return moveIfInRange(rows, index - FILE_TREE_PAGE_SIZE);
  if (key === "Home") return rows.length > 0 ? { kind: "move", index: 0 } : null;
  if (key === "End") return rows.length > 0 ? { kind: "move", index: rows.length - 1 } : null;
  if (key === "ArrowRight") {
    if (!isDirectory) return null;
    if (!row.open) return { kind: "toggle" };
    return moveIfInRange(rows, index + 1);
  }
  if (key === "ArrowLeft") {
    if (isDirectory && row.open) return { kind: "toggle" };
    for (let candidate = index - 1; candidate >= 0; candidate--) {
      if (rows[candidate].depth < row.depth) return { kind: "move", index: candidate };
    }
    return null;
  }
  return null;
}

function moveIfInRange(rows: readonly FileTreeRow[], index: number): FileTreeNavigationAction {
  return index >= 0 && index < rows.length ? { kind: "move", index } : null;
}
