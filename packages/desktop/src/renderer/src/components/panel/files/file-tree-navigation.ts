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

export interface FileTreeStickyModel {
  readonly parentIndices: readonly (number | null)[];
  readonly endIndices: readonly number[];
}

export interface FileTreeStickyRow {
  readonly index: number;
  readonly position: number;
}

/** 预计算每行的父目录与子树末尾，供滚动热路径常量时间查找。 */
export function buildFileTreeStickyModel(rows: readonly FileTreeRow[]): FileTreeStickyModel {
  const parentIndices: Array<number | null> = Array.from({ length: rows.length }, () => null);
  const endIndices = rows.map((_, index) => index);
  const ancestors: number[] = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    while (ancestors.length > 0 && rows[ancestors[ancestors.length - 1]].depth >= row.depth) {
      const ancestorIndex = ancestors.pop();
      if (ancestorIndex !== undefined) endIndices[ancestorIndex] = index - 1;
    }
    parentIndices[index] = ancestors.at(-1) ?? null;
    if (row.kind === "node" && row.open && row.node?.type === "directory") ancestors.push(index);
  }

  for (const ancestorIndex of ancestors) endIndices[ancestorIndex] = rows.length - 1;
  return { parentIndices, endIndices };
}

/**
 * VS Code AbstractTree sticky scroll 的固定行高版本：逐层查找吸顶区底部的祖先，
 * 默认最多占视口 40%、最多 7 行，并在子树末尾将最末行向上推出。
 */
export function fileTreeStickyRows(
  rows: readonly FileTreeRow[],
  model: FileTreeStickyModel,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  maxItemCount = 7,
): FileTreeStickyRow[] {
  if (rows.length === 0 || scrollTop <= 0 || viewportHeight <= 0 || rowHeight <= 0) return [];

  const maximumHeight = viewportHeight * 0.4;
  const stickyRows: FileTreeStickyRow[] = [];
  let previousIndex: number | null = null;
  let stickyHeight = 0;

  while (stickyRows.length < maxItemCount) {
    const visibleIndex = Math.min(rows.length - 1, Math.floor((scrollTop + stickyHeight) / rowHeight));
    const candidateIndex = ancestorUnderPrevious(model.parentIndices, visibleIndex, previousIndex);
    if (candidateIndex === null) break;

    const candidate = rows[candidateIndex];
    const isExpandedDirectory = candidate.kind === "node" && candidate.open && candidate.node?.type === "directory";
    if (candidateIndex === visibleIndex && !isExpandedDirectory) break;
    if (scrollTop + stickyHeight <= candidateIndex * rowHeight) break;

    const subtreeBottom = (model.endIndices[candidateIndex] + 1) * rowHeight - scrollTop;
    const position =
      stickyHeight + rowHeight > subtreeBottom && stickyHeight <= subtreeBottom
        ? subtreeBottom - rowHeight
        : stickyHeight;
    if (position + rowHeight > maximumHeight) break;

    stickyRows.push({ index: candidateIndex, position });
    previousIndex = candidateIndex;
    stickyHeight += rowHeight;
  }

  return stickyRows;
}

function ancestorUnderPrevious(
  parentIndices: readonly (number | null)[],
  index: number,
  previousIndex: number | null,
): number | null {
  let currentIndex = index;
  let parentIndex = parentIndices[currentIndex] ?? null;
  while (parentIndex !== null) {
    if (parentIndex === previousIndex) return currentIndex;
    currentIndex = parentIndex;
    parentIndex = parentIndices[currentIndex] ?? null;
  }
  return previousIndex === null ? currentIndex : null;
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
