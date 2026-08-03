import type { Thread } from "../../../shared/contracts.ts";
import { pinnedThreadKey } from "./thread-pinning-preference.ts";

export { collectThreadDescendantIds as threadDescendantIds } from "../../../shared/thread-tree.ts";

export interface ThreadListItemIdentity {
  id: string;
  remoteId?: string | undefined;
  custom?: Record<string, unknown> | undefined;
}

export interface PreventableThreadActionEvent {
  preventDefault(): void;
}

export const COLLAPSED_THREAD_COUNT = 5;
export const THREAD_EXPANSION_COUNT = 10;

/**
 * 在完整 catalog 树上做子树级显示过滤，保证父子关系不被拆散。
 * keep：只显示这些节点及其完整后代子树（置顶区）；
 * prune：剪除这些节点及其完整后代子树（普通区）。
 */
export type ThreadDisplayFilter =
  | { mode: "keep"; threadIds: ReadonlySet<string> }
  | { mode: "prune"; threadIds: ReadonlySet<string> };

export interface ThreadTreeNode {
  thread: Thread;
  children: ThreadTreeNode[];
}

export interface ThreadSiblingExpansion {
  parentThreadId: string;
  depth: number;
  threadCount: number;
  hasMore: boolean;
  expanded: boolean;
}

export interface VisibleThreadTreeItem {
  thread: Thread;
  depth: number;
  childCount: number;
  runningChildCount: number;
  expanded: boolean;
  ancestorContinuations: boolean[];
  isLastChild: boolean;
  siblingExpansions?: ThreadSiblingExpansion[];
}

export function nextThreadVisibleLimit(currentLimit: number, threadCount: number): number {
  return Math.min(threadCount, Math.max(currentLimit, COLLAPSED_THREAD_COUNT) + THREAD_EXPANSION_COUNT);
}

export function isThreadListExpanded(visibleLimit: number, threadCount: number): boolean {
  return visibleLimit > COLLAPSED_THREAD_COUNT && threadCount > COLLAPSED_THREAD_COUNT;
}

export function visibleThreadsByArchiveState(
  threads: readonly Thread[],
  archived: boolean,
  limit: number,
): readonly Thread[] {
  return threads.filter((thread) => thread.archived === archived).slice(0, limit);
}

export function threadTreeByArchiveState(
  threads: readonly Thread[],
  archived: boolean,
  rootLimit: number,
  pinnedThreadKeys: ReadonlySet<string> = new Set(),
  displayFilter?: ThreadDisplayFilter,
): ThreadTreeNode[] {
  const nodes = new Map<string, ThreadTreeNode>(
    threads.filter((thread) => thread.archived === archived).map((thread) => [thread.id, { thread, children: [] }]),
  );
  const roots: ThreadTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.thread.parentThreadId ? nodes.get(node.thread.parentThreadId) : undefined;
    if (parent && !wouldCreateThreadCycle(node.thread.id, parent, nodes)) parent.children.push(node);
    else roots.push(node);
  }
  if (displayFilter) applyThreadDisplayFilter(nodes, roots, displayFilter);
  const pinnedThreadIds = new Set<string>();
  for (const node of nodes.values()) {
    if (pinnedThreadKeys.has(pinnedThreadKey(node.thread.projectId, node.thread.id)))
      pinnedThreadIds.add(node.thread.id);
  }
  const prioritizedThreadIds = new Set(pinnedThreadIds);
  for (const root of roots) collectPrioritizedThreadIds(root, prioritizedThreadIds);
  for (const node of nodes.values()) {
    node.children.sort((left, right) => compareThreadNodes(left, right, pinnedThreadIds, prioritizedThreadIds));
  }
  roots.sort((left, right) => compareThreadNodes(left, right, pinnedThreadIds, prioritizedThreadIds));
  return roots.slice(0, rootLimit);
}

export function flattenVisibleThreadTree(
  roots: readonly ThreadTreeNode[],
  expandedThreadIds: ReadonlySet<string>,
  childVisibleLimits: ReadonlyMap<string, number> = new Map(),
): VisibleThreadTreeItem[] {
  const visible: VisibleThreadTreeItem[] = [];
  const appendSiblings = (
    siblings: readonly ThreadTreeNode[],
    depth: number,
    ancestorContinuations: boolean[],
    parentThreadId?: string,
  ): void => {
    const visibleLimit = parentThreadId
      ? (childVisibleLimits.get(parentThreadId) ?? COLLAPSED_THREAD_COUNT)
      : siblings.length;
    const visibleSiblings = siblings.slice(0, visibleLimit);
    visibleSiblings.forEach((node, index) => {
      const isLastChild = index === visibleSiblings.length - 1;
      const expanded = node.children.length > 0 && expandedThreadIds.has(node.thread.id);
      visible.push({
        thread: node.thread,
        depth,
        childCount: node.children.length,
        runningChildCount: node.children.filter(({ thread }) => thread.running).length,
        expanded,
        ancestorContinuations,
        isLastChild,
      });
      if (expanded) {
        appendSiblings(
          node.children,
          depth + 1,
          depth === 0 ? [] : [...ancestorContinuations, !isLastChild],
          node.thread.id,
        );
      }
    });
    if (parentThreadId && siblings.length > COLLAPSED_THREAD_COUNT && visibleSiblings.length > 0) {
      const lastVisible = visible[visible.length - 1]!;
      lastVisible.siblingExpansions = [
        ...(lastVisible.siblingExpansions ?? []),
        {
          parentThreadId,
          depth,
          threadCount: siblings.length,
          hasMore: siblings.length > visibleLimit,
          expanded: isThreadListExpanded(visibleLimit, siblings.length),
        },
      ];
    }
  };
  appendSiblings(roots, 0, []);
  return visible;
}

function applyThreadDisplayFilter(
  nodes: Map<string, ThreadTreeNode>,
  roots: ThreadTreeNode[],
  filter: ThreadDisplayFilter,
): void {
  if (filter.mode === "prune") {
    const pruned = new Set<string>();
    for (const id of filter.threadIds) {
      const node = nodes.get(id);
      if (!node || pruned.has(id)) continue;
      pruned.add(id);
      collectNodeDescendantIds(node, pruned);
    }
    if (pruned.size === 0) return;
    for (const node of nodes.values()) {
      node.children = node.children.filter((child) => !pruned.has(child.thread.id));
    }
    for (let index = roots.length - 1; index >= 0; index--) {
      if (pruned.has(roots[index]!.thread.id)) roots.splice(index, 1);
    }
    return;
  }
  // keep：以 display 集合中最顶层的节点为根，保留其完整后代子树；
  // display 集合内的后代节点不重复成为根（避免同一子树重复展示）。
  const kept = filter.threadIds;
  roots.length = 0;
  for (const node of nodes.values()) {
    if (!kept.has(node.thread.id) || hasKeptAncestor(node, nodes, kept)) continue;
    roots.push(node);
  }
}

function collectNodeDescendantIds(node: ThreadTreeNode, collected: Set<string>): void {
  for (const child of node.children) {
    collected.add(child.thread.id);
    collectNodeDescendantIds(child, collected);
  }
}

function hasKeptAncestor(
  node: ThreadTreeNode,
  nodes: ReadonlyMap<string, ThreadTreeNode>,
  kept: ReadonlySet<string>,
): boolean {
  let parent = node.thread.parentThreadId ? nodes.get(node.thread.parentThreadId) : undefined;
  while (parent) {
    if (kept.has(parent.thread.id)) return true;
    parent = parent.thread.parentThreadId ? nodes.get(parent.thread.parentThreadId) : undefined;
  }
  return false;
}

function collectPrioritizedThreadIds(node: ThreadTreeNode, prioritizedThreadIds: Set<string>): boolean {
  const hasPinnedDescendant = node.children.some((child) => collectPrioritizedThreadIds(child, prioritizedThreadIds));
  if (hasPinnedDescendant) prioritizedThreadIds.add(node.thread.id);
  return prioritizedThreadIds.has(node.thread.id);
}

function compareThreadNodes(
  left: ThreadTreeNode,
  right: ThreadTreeNode,
  pinnedThreadIds: ReadonlySet<string>,
  prioritizedThreadIds: ReadonlySet<string>,
): number {
  const leftPinned = pinnedThreadIds.has(left.thread.id);
  const rightPinned = pinnedThreadIds.has(right.thread.id);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const leftPrioritized = prioritizedThreadIds.has(left.thread.id);
  const rightPrioritized = prioritizedThreadIds.has(right.thread.id);
  if (leftPrioritized !== rightPrioritized) return leftPrioritized ? -1 : 1;
  if (left.thread.running !== right.thread.running) return left.thread.running ? -1 : 1;
  return right.thread.updatedAt - left.thread.updatedAt;
}

function wouldCreateThreadCycle(
  childId: string,
  parent: ThreadTreeNode,
  nodes: ReadonlyMap<string, ThreadTreeNode>,
): boolean {
  let current: ThreadTreeNode | undefined = parent;
  const visited = new Set<string>();
  while (current) {
    if (current.thread.id === childId || visited.has(current.thread.id)) return true;
    visited.add(current.thread.id);
    current = current.thread.parentThreadId ? nodes.get(current.thread.parentThreadId) : undefined;
  }
  return false;
}

/** 在 React bubble handler 与 primitive 内部 action 组合前阻止默认提交。 */
export function preventPrimitiveThreadAction(event: PreventableThreadActionEvent): void {
  event.preventDefault();
}

/** 阻止 primitive 默认 action，确保 Desktop controller 只执行一次命令。 */
export function runControlledThreadAction(event: PreventableThreadActionEvent, action: () => void): void {
  preventPrimitiveThreadAction(event);
  action();
}

/** Project 切换时忽略 external-store runtime 尚未替换的旧 Project item。 */
export function isDesktopThreadItemForProject(item: ThreadListItemIdentity, projectId: string): boolean {
  const itemProjectId = item.custom?.projectId;
  if (typeof itemProjectId !== "string") throw new Error(`assistant-ui thread 缺少 projectId: ${item.id}`);
  return itemProjectId === projectId;
}

/** 将 assistant-ui item 映射回当前 Project 的 Pi session；删除提交过渡帧允许 catalog 已先移除。 */
export function resolveDesktopThreadItem(
  item: ThreadListItemIdentity,
  projectId: string,
  threads: readonly Thread[],
): Thread | null {
  const remoteId = item.remoteId;
  if (!remoteId) throw new Error(`assistant-ui thread 缺少 remoteId: ${item.id}`);
  const thread = threads.find(({ id }) => id === remoteId);
  if (!thread) return null;
  if (thread.projectId !== projectId) throw new Error(`assistant-ui thread 不属于当前 Project: ${item.id}`);
  return thread;
}

/** 对同一 key 的异步 thread action 做 single-flight，并发布不可变 pending 快照。 */
export async function runPendingThreadAction(
  pending: Set<string>,
  key: string,
  publish: (snapshot: ReadonlySet<string>) => void,
  action: () => Promise<void>,
): Promise<boolean> {
  if (pending.has(key)) return false;
  pending.add(key);
  publish(new Set(pending));
  try {
    await action();
    return true;
  } finally {
    pending.delete(key);
    publish(new Set(pending));
  }
}

export function normalizeThreadTitle(title: string): string | null {
  const value = title.trim();
  return value.length > 0 ? value : null;
}

/**
 * 判断 candidateThreadId 是否为 ancestorThreadId 的后代（沿 parentThreadId 链上溯）。
 */
export function isThreadDescendantOf(
  threads: readonly Thread[],
  candidateThreadId: string,
  ancestorThreadId: string,
): boolean {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  let current = byId.get(candidateThreadId);
  const visited = new Set<string>();
  while (current?.parentThreadId) {
    if (current.parentThreadId === ancestorThreadId) return true;
    if (visited.has(current.parentThreadId)) return false;
    visited.add(current.parentThreadId);
    current = byId.get(current.parentThreadId);
  }
  return false;
}

export function shouldOpenThread(activeThreadId: string | null, threadId: string): boolean {
  return activeThreadId !== threadId;
}

export function nextRegularThreadId(threads: readonly Thread[], excludedThreadId: string): string | null {
  return threads.find(({ id, archived }) => id !== excludedThreadId && !archived)?.id ?? null;
}
