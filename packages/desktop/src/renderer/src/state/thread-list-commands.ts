import type { Project, Thread } from "../../../shared/contracts.ts";

export interface ThreadListItemIdentity {
  id: string;
  remoteId?: string | undefined;
  custom?: Record<string, unknown> | undefined;
}

export interface PreventableThreadActionEvent {
  preventDefault(): void;
}

export interface DesktopAdapterThread {
  project: Project;
  threadId: string;
}

export const COLLAPSED_THREAD_COUNT = 5;
export const THREAD_EXPANSION_COUNT = 10;

export function nextThreadVisibleLimit(currentLimit: number, threadCount: number): number {
  return Math.min(threadCount, Math.max(currentLimit, COLLAPSED_THREAD_COUNT) + THREAD_EXPANSION_COUNT);
}

export function visibleRegularThreadIds(threads: readonly Thread[], limit: number): ReadonlySet<string> {
  return new Set(
    threads
      .filter(({ archived }) => !archived)
      .slice(0, limit)
      .map(({ id }) => id),
  );
}

/** 解析全局 assistant-ui item，并允许 thread 切换提交前使用显式目标 Project。 */
export function resolveDesktopAdapterThread(
  adapterThreadId: string,
  projects: readonly Project[],
  catalogs: Readonly<Record<string, readonly Thread[]>>,
  targetProject?: Project | null,
): DesktopAdapterThread {
  for (const project of projects) {
    const thread = catalogs[project.id]?.find(({ id }) => `${project.id}:${id}` === adapterThreadId);
    if (thread) return { project, threadId: thread.id };
  }
  if (targetProject) {
    const prefix = `${targetProject.id}:`;
    if (adapterThreadId.startsWith(prefix) && adapterThreadId.length > prefix.length) {
      return { project: targetProject, threadId: adapterThreadId.slice(prefix.length) };
    }
  }
  throw new Error(`Desktop session catalog 不包含 assistant-ui thread: ${adapterThreadId}`);
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

/** 将 assistant-ui item 映射回当前 Project 的 Pi session，并严格校验边界。 */
export function resolveDesktopThreadItem(
  item: ThreadListItemIdentity,
  projectId: string,
  threads: readonly Thread[],
): Thread {
  const remoteId = item.remoteId;
  if (!remoteId) throw new Error(`assistant-ui thread 缺少 remoteId: ${item.id}`);
  const thread = threads.find(({ id }) => id === remoteId);
  if (!thread) throw new Error(`Desktop session catalog 不包含 assistant-ui thread: ${remoteId}`);
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

export function shouldOpenThread(activeThreadId: string | null, threadId: string): boolean {
  return activeThreadId !== threadId;
}

export function nextRegularThreadId(threads: readonly Thread[], excludedThreadId: string): string | null {
  return threads.find(({ id, archived }) => id !== excludedThreadId && !archived)?.id ?? null;
}
