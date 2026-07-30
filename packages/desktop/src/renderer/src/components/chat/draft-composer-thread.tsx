import { ThreadPrimitive } from "@assistant-ui/react";
import type { DraftSessionConfig, Project, ThinkingLevel } from "../../../../shared/contracts.ts";
import { Composer } from "./composer/composer.tsx";

interface DraftComposerThreadProps {
  projects: readonly Project[];
  project: Project | null;
  config: DraftSessionConfig | null;
  configLoading: boolean;
  phase: "editing" | "materializing";
  onProjectChange(projectId: string): Promise<void>;
  onModelChange(provider: string, modelId: string): void;
  onThinkingChange(level: ThinkingLevel): void;
  onSubmit(): Promise<void>;
}

/** Shared styled assistant-ui surface for the single renderer-only draft. */
export function DraftComposerThread(props: DraftComposerThreadProps) {
  return (
    <ThreadPrimitive.Root className="thread-root aui-root aui-thread-root @container flex h-full flex-col justify-center bg-background">
      <h1 className="text-center mb-[68px] text-[32px]">
        在 <span className="underline decoration-dashed decoration-1">{props.project?.name}</span> 做什么？
      </h1>

      <div className="thread-footer relative shrink-0 bg-background">
        <div className="relative mx-auto flex w-full max-w-(--layout-thread-max-width) flex-col gap-2 px-4 pb-4">
          <Composer mode="draft" {...props} />
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}
