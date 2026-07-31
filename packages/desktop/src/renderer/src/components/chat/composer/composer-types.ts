import type {
  DraftSessionConfig,
  PiQueueItem,
  PiThreadPhase,
  Project,
  SessionControlState,
} from "../../../../../shared/contracts.ts";

export type ComposerProps =
  | {
      mode: "draft";
      projects: readonly Project[];
      project: Project | null;
      config: DraftSessionConfig | null;
      configLoading: boolean;
      phase: "editing" | "materializing";
      /** 固定项目（如侧边栏草稿），隐藏项目选择器。 */
      fixedProject?: boolean;
      onProjectChange(projectId: string): Promise<void>;
      onModelChange(provider: string, modelId: string): void;
      onThinkingChange(level: SessionControlState["thinkingLevel"]): void;
      onSubmit(): Promise<void>;
    }
  | {
      mode: "session";
      projectId: string;
      threadId: string;
      model: SessionControlState["model"];
      models: SessionControlState["models"];
      commands: SessionControlState["commands"];
      thinkingLevel: SessionControlState["thinkingLevel"];
      thinkingLevels: SessionControlState["thinkingLevels"];
      readiness: SessionControlState["readiness"];
      phase: PiThreadPhase;
      queue: readonly PiQueueItem[];
      widgets: SessionControlState["extensionHost"]["widgets"];
      composerCommand: SessionControlState["extensionHost"]["composerCommand"];
      commandsReady: boolean;
      modelsLoading: boolean;
      onClearQueue(): Promise<void>;
      onRefreshModels(): Promise<void>;
      onSetModel(provider: string, modelId: string): Promise<void>;
      onSetThinking(level: SessionControlState["thinkingLevel"]): Promise<void>;
    };
