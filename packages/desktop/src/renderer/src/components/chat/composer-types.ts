import type { DraftSessionConfig, Project, SessionControlState } from "../../../../shared/contracts.ts";
import type { DraftSessionState } from "../../state/desktop-model.ts";

export type ComposerProps =
  | {
      mode: "draft";
      projects: readonly Project[];
      project: Project | null;
      config: DraftSessionConfig | null;
      configLoading: boolean;
      phase: DraftSessionState["phase"];
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
      widgets: SessionControlState["extensionUi"]["widgets"];
      editorRevision: number;
      editorText: string | undefined;
      onClearQueue(): Promise<void>;
    };
