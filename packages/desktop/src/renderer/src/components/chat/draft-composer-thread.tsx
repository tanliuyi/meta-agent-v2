import { ThreadPrimitive } from "@assistant-ui/react";
import { cn } from "@renderer/shared/lib/cn";
import type { DraftSessionConfig, Project, ThinkingLevel } from "../../../../shared/contracts.ts";
import type { DesktopExtensionDiagnostic } from "../../../../shared/desktop-extension-contracts.ts";
import { Composer } from "./composer/composer.tsx";
import { ComposerFeedback, type ComposerFeedbackTone } from "./composer/composer-feedback.tsx";

interface DraftComposerThreadProps {
  projects: readonly Project[];
  project: Project | null;
  config: DraftSessionConfig | null;
  configLoading: boolean;
  phase: "editing" | "materializing";
  error?: string | null;
  diagnostics?: readonly DesktopExtensionDiagnostic[];
  /** 固定项目（如侧边栏草稿），隐藏项目选择器。 */
  fixedProject?: boolean;
  /** 工作台 panel 内嵌草稿：隐藏标题并将 composer 靠下对齐。 */
  compact?: boolean;
  onProjectChange(projectId: string): Promise<void>;
  onModelChange(provider: string, modelId: string): void;
  onThinkingChange(level: ThinkingLevel): void;
  onSubmit(): Promise<void>;
}

/** Shared styled assistant-ui surface for the single renderer-only draft. */
export function DraftComposerThread({ compact = false, error, diagnostics = [], ...props }: DraftComposerThreadProps) {
  return (
    <ThreadPrimitive.Root
      className={cn(
        "thread-root aui-root aui-thread-root @container flex h-full flex-col bg-background",
        compact ? "justify-end" : "justify-center",
      )}
    >
      {compact ? null : (
        <h1 className="text-center mb-[68px] text-[32px]">
          在 <span className="draft-project-name">{props.project?.name}</span> 做什么？
        </h1>
      )}

      <div className="thread-footer relative shrink-0 bg-background">
        <div className="relative mx-auto flex w-full max-w-(--layout-draft-composer-max-width) flex-col gap-2 px-4 pb-4">
          <Composer mode="draft" {...props} />
          {error || diagnostics.length > 0 ? (
            <div className="composer-feedback-stack draft-composer-feedback">
              {error ? <ComposerFeedback tone="error" message={error} /> : null}
              {diagnostics.map((diagnostic) => {
                const feedback = extensionDiagnosticFeedback(diagnostic);
                return (
                  <ComposerFeedback
                    key={`${diagnostic.extensionId}:${diagnostic.phase}:${diagnostic.code}`}
                    tone={feedback.tone}
                    message={diagnostic.message}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}

function extensionDiagnosticFeedback(diagnostic: DesktopExtensionDiagnostic): {
  tone: ComposerFeedbackTone;
} {
  if (diagnostic.code === "DESKTOP_EXTENSION_SUPERSEDED_BY_DEVELOPMENT") {
    return { tone: "info" };
  }
  if (diagnostic.code === "DESKTOP_EXTENSION_ENTRY_UNAVAILABLE") {
    return { tone: "error" };
  }
  if (diagnostic.code === "DESKTOP_EXTENSION_LOAD_FAILED") {
    return { tone: "error" };
  }
  if (diagnostic.code === "DESKTOP_EXTENSION_REGISTRATION_FAILED") {
    return { tone: "error" };
  }
  return { tone: "error" };
}
