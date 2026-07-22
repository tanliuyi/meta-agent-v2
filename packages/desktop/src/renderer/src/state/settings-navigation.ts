import type { SessionIdentity } from "../runtime/pi-session-store.ts";

export interface SettingsSearch {
  returnProjectId?: string;
  returnThreadId?: string;
}

/** Keeps settings return navigation structured and limited to a real session identity. */
export function validateSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  const returnProjectId = typeof search.returnProjectId === "string" ? search.returnProjectId : undefined;
  const returnThreadId = typeof search.returnThreadId === "string" ? search.returnThreadId : undefined;
  return returnProjectId && returnThreadId ? { returnProjectId, returnThreadId } : {};
}

export function settingsReturnSession(search: SettingsSearch): SessionIdentity | null {
  return search.returnProjectId && search.returnThreadId
    ? { projectId: search.returnProjectId, threadId: search.returnThreadId }
    : null;
}
