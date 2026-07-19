import type { SessionControlState, WorkbenchState } from "../../../shared/contracts.ts";

/**
 * Desktop renderer 可触发的命令集合。
 *
 * 命令只在事件发生时读取 store 的最新快照，视图无需为回调订阅无关状态。
 */
export interface DesktopActions {
  chooseProject(): Promise<void>;
  loadProjectThreads(projectId: string): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  beginDraft(projectId?: string): Promise<void>;
  selectDraftProject(projectId: string): Promise<void>;
  selectDraftModel(provider: string, modelId: string): void;
  selectDraftThinking(level: SessionControlState["thinkingLevel"]): void;
  submitDraft(): Promise<void>;
  discardDraft(): Promise<void>;
  openThread(projectId: string, threadId: string): Promise<void>;
  renameThread(projectId: string, threadId: string, title: string): Promise<void>;
  setThreadArchived(projectId: string, threadId: string, archived: boolean): Promise<void>;
  removeThread(projectId: string, threadId: string): Promise<void>;
  clearQueue(): Promise<void>;
  compactSession(): Promise<void>;
  updateWorkbench(value: Partial<WorkbenchState>): void;
  clearError(): void;
}
