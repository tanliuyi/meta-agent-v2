import type { SessionIdentity } from "../runtime/pi-session-store.ts";

export interface SettingsSearch {
  returnProjectId?: string;
  returnThreadId?: string;
  /** 从新会话草稿进入设置页时缓存的草稿项目，返回时恢复到 /new 的选择。 */
  draftProjectId?: string;
}

/** Keeps settings return navigation structured and limited to a real session identity. */
export function validateSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  const returnProjectId = typeof search.returnProjectId === "string" ? search.returnProjectId : undefined;
  const returnThreadId = typeof search.returnThreadId === "string" ? search.returnThreadId : undefined;
  const draftProjectId = typeof search.draftProjectId === "string" ? search.draftProjectId : undefined;
  return {
    ...(returnProjectId && returnThreadId ? { returnProjectId, returnThreadId } : {}),
    ...(draftProjectId ? { draftProjectId } : {}),
  };
}

export function settingsReturnSession(search: SettingsSearch): SessionIdentity | null {
  return search.returnProjectId && search.returnThreadId
    ? { projectId: search.returnProjectId, threadId: search.returnThreadId }
    : null;
}

/** 从新会话草稿进入设置页时，返回要恢复的草稿项目。 */
export function settingsReturnDraftProject(search: SettingsSearch): string | null {
  return search.draftProjectId ?? null;
}
