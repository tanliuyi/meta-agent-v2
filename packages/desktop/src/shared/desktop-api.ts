import type {
  ClearedQueue,
  DraftSessionConfig,
  FileNode,
  HostResponse,
  Project,
  SessionBootstrap,
  SessionCommandResult,
  SessionControlState,
  SessionCreateInput,
  SessionEditInput,
  SessionPromptInput,
  SessionPushPayload,
  SessionReloadInput,
  TerminalEvent,
  TerminalSnapshot,
  TextFile,
  Thread,
  WorkbenchState,
} from "./contracts.ts";
import type { ModelsConfigSnapshot, SaveModelsConfigInput, SaveModelsConfigResult } from "./models-config-contracts.ts";

export type DesktopPlatform = "win32" | "darwin" | "linux";

export interface NodeRuntimeStatus {
  state: "ready" | "missing" | "invalid";
  path?: string;
  version?: string;
  requiredVersion: string;
  message: string;
  installUrl: string;
}

export interface NodeRuntimeProgress {
  phase: "checking" | "downloading" | "verifying" | "extracting" | "ready" | "error";
  percent: number;
  message: string;
  error?: string;
}

/** Renderer 可以调用的最小 Desktop API。 */
export interface DesktopApi {
  platform: DesktopPlatform;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  nodeRuntime: {
    getStatus(): Promise<NodeRuntimeStatus>;
    install(): Promise<NodeRuntimeStatus>;
    onProgress(listener: (progress: NodeRuntimeProgress) => void): () => void;
  };
  links: {
    open(url: string): Promise<void>;
  };
  models: {
    getConfig(): Promise<ModelsConfigSnapshot>;
    getConfigRevision(): Promise<string>;
    saveConfig(input: SaveModelsConfigInput): Promise<SaveModelsConfigResult>;
    openConfigExternally(): Promise<void>;
    setEditorDirty(dirty: boolean): boolean;
  };
  windowControls: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    onMaximizedChanged(listener: (maximized: boolean) => void): () => void;
  };
  projects: {
    list(): Promise<Project[]>;
    choose(): Promise<Project | null>;
    open(projectId: string): Promise<Project>;
    remove(projectId: string): Promise<void>;
    getActive(): Promise<Project | null>;
  };
  sessions: {
    list(projectId: string, includeArchived?: boolean): Promise<Thread[]>;
    getDraftConfig(projectId: string): Promise<DraftSessionConfig>;
    create(input: SessionCreateInput): Promise<SessionBootstrap>;
    attach(
      projectId: string,
      threadId: string,
      listener: (update: SessionPushPayload) => void,
    ): Promise<SessionBootstrap>;
    flush(): void;
    detach(): void;
    rename(projectId: string, threadId: string, title: string): Promise<void>;
    archive(projectId: string, threadId: string, archived: boolean): Promise<void>;
    remove(projectId: string, threadId: string): Promise<void>;
    prompt(input: SessionPromptInput): Promise<SessionCommandResult>;
    edit(input: SessionEditInput): Promise<SessionCommandResult>;
    reload(input: SessionReloadInput): Promise<SessionCommandResult>;
    cancel(projectId: string, threadId: string): Promise<void>;
    clearQueue(projectId: string, threadId: string): Promise<ClearedQueue>;
    compact(projectId: string, threadId: string): Promise<void>;
    setModel(projectId: string, threadId: string, provider: string, modelId: string): Promise<void>;
    setThinking(projectId: string, threadId: string, level: SessionControlState["thinkingLevel"]): Promise<void>;
    setEditorText(projectId: string, threadId: string, text: string): Promise<void>;
    respond(projectId: string, threadId: string, response: HostResponse): Promise<void>;
  };
  files: {
    list(projectId: string, path?: string, query?: string): Promise<FileNode[]>;
    read(projectId: string, path: string): Promise<TextFile>;
    resolvePath(path: string): Promise<string>;
    open(path: string): Promise<void>;
  };
  terminals: {
    open(
      projectId: string,
      threadId: string,
      terminalId: string,
      cols: number,
      rows: number,
    ): Promise<TerminalSnapshot>;
    write(projectId: string, threadId: string, terminalId: string, data: string): Promise<void>;
    resize(projectId: string, threadId: string, terminalId: string, cols: number, rows: number): Promise<void>;
    restart(
      projectId: string,
      threadId: string,
      terminalId: string,
      cols: number,
      rows: number,
    ): Promise<TerminalSnapshot>;
    onEvent(listener: (event: TerminalEvent) => void): () => void;
  };
  workbench: {
    get(projectId: string, threadId: string): Promise<WorkbenchState>;
    update(state: WorkbenchState): Promise<void>;
  };
}
