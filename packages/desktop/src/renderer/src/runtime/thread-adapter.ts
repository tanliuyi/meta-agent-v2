import type { Project, Thread } from "../../../shared/contracts.ts";

export interface DesktopAdapterThread {
  project: Project;
  threadId: string;
}

/** 为 assistant-ui thread list 生成跨 Project 唯一的 item ID。 */
export function threadAdapterId(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`;
}

/** 解析全局 assistant-ui item，并允许 thread 切换提交前使用显式目标 Project。 */
export function resolveDesktopAdapterThread(
  adapterThreadId: string,
  projects: readonly Project[],
  catalogs: Readonly<Record<string, readonly Thread[]>>,
  targetProject?: Project | null,
): DesktopAdapterThread {
  for (const project of projects) {
    const thread = catalogs[project.id]?.find(({ id }) => threadAdapterId(project.id, id) === adapterThreadId);
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
