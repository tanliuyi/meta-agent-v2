export interface DesktopActions {
  chooseProject(): Promise<void>;
  loadProjectThreads(projectId: string): Promise<void>;
  refreshProjectThreads(projectId: string): Promise<void>;
  activateProject(projectId: string): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  prewarmThread(projectId: string, threadId: string): void;
  renameThread(projectId: string, threadId: string, title: string): Promise<void>;
  setThreadArchived(projectId: string, threadId: string, archived: boolean): Promise<void>;
  removeThread(projectId: string, threadId: string): Promise<void>;
  clearError(): void;
}
