import type { FocusEvent, KeyboardEvent } from "react";
import type { FileNode } from "../../../../shared/contracts.ts";

const TREE_ITEM_SELECTOR = '[role="treeitem"]';

/** 将最近聚焦的 treeitem 设为唯一 Tab 停靠点，不触发 React render。 */
export function setFileTreeRovingTabStop(event: FocusEvent<HTMLButtonElement>): void {
  const tree = event.currentTarget.closest<HTMLElement>('[role="tree"]');
  if (!tree) return;
  for (const item of tree.querySelectorAll<HTMLButtonElement>(TREE_ITEM_SELECTOR)) item.tabIndex = -1;
  event.currentTarget.tabIndex = 0;
}

/** 实现 ARIA tree 的方向键、Home/End 与目录展开收起契约。 */
export function handleFileTreeKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  node: FileNode,
  onOpen: (node: FileNode) => void,
): void {
  const tree = event.currentTarget.closest<HTMLElement>('[role="tree"]');
  if (!tree) return;
  const items = [...tree.querySelectorAll<HTMLButtonElement>(TREE_ITEM_SELECTOR)];
  const index = items.indexOf(event.currentTarget);
  if (index === -1) return;

  let target: HTMLButtonElement | undefined;
  if (event.key === "ArrowDown") target = items[index + 1];
  else if (event.key === "ArrowUp") target = items[index - 1];
  else if (event.key === "Home") target = items[0];
  else if (event.key === "End") target = items.at(-1);
  else if (event.key === "ArrowRight" && node.type === "directory") {
    if (event.currentTarget.getAttribute("aria-expanded") === "false") onOpen(node);
    else if (
      Number(items[index + 1]?.getAttribute("aria-level")) > Number(event.currentTarget.getAttribute("aria-level"))
    ) {
      target = items[index + 1];
    }
  } else if (event.key === "ArrowLeft") {
    if (node.type === "directory" && event.currentTarget.getAttribute("aria-expanded") === "true") onOpen(node);
    else {
      const level = Number(event.currentTarget.getAttribute("aria-level"));
      target = items
        .slice(0, index)
        .toReversed()
        .find((item) => Number(item.getAttribute("aria-level")) < level);
    }
  } else return;

  event.preventDefault();
  if (!target) return;
  for (const item of items) item.tabIndex = -1;
  target.tabIndex = 0;
  target.focus();
}
