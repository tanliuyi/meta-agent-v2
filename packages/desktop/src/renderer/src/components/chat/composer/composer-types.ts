import type {
  DraftSessionConfig,
  PiQueueItem,
  PiThreadPhase,
  Project,
  SessionControlState,
} from "../../../../../shared/contracts.ts";
import type { DraftSelectablePlugin } from "../../../../../shared/desktop-extension-contracts.ts";

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
      onPluginsChange(enabledPluginIds: string[] | null): void;
      onSubmit(): Promise<void>;
    }
  | {
      mode: "session";
      projectId: string;
      threadId: string;
      model: SessionControlState["model"];
      models: SessionControlState["models"];
      commands: SessionControlState["commands"];
      context: SessionControlState["context"];
      thinkingLevel: SessionControlState["thinkingLevel"];
      thinkingLevels: SessionControlState["thinkingLevels"];
      readiness: SessionControlState["readiness"];
      phase: PiThreadPhase;
      queue: readonly PiQueueItem[];
      widgets: SessionControlState["extensionHost"]["widgets"];
      composerCommand: SessionControlState["extensionHost"]["composerCommand"];
      working?: SessionControlState["extensionHost"]["working"];
      commandsReady: boolean;
      modelsLoading: boolean;
      /** 会话级可选插件（含项目作用域外）；null 表示不可用。 */
      plugins: readonly DraftSelectablePlugin[] | null;
      /** 会话级激活子集；null 表示继承项目级。 */
      enabledPluginIds: string[] | null;
      pluginsLoading: boolean;
      pluginsDisabled: boolean;
      onClearQueue(): Promise<void>;
      onRefreshModels(): Promise<void>;
      onSetModel(provider: string, modelId: string): Promise<void>;
      onSetThinking(level: SessionControlState["thinkingLevel"]): Promise<void>;
      onPluginsChange(enabledPluginIds: string[] | null): void;
    };
