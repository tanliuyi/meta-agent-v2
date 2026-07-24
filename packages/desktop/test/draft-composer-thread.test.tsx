import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from "@assistant-ui/react";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DraftComposerThread } from "../src/renderer/src/components/chat/draft-composer-thread.tsx";
import { ModelSelect } from "../src/renderer/src/components/chat/model-select.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import type { DraftSessionConfig, Project } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "Project",
  cwd: "C:/workspace",
  lastOpenedAt: 1,
  available: true,
};

const config: DraftSessionConfig = {
  models: [
    {
      provider: "openai",
      id: "gpt",
      name: "GPT",
      contextWindow: 128_000,
      thinking: true,
      thinkingLevels: ["off", "high"],
    },
  ],
  commands: [],
  model: { provider: "openai", id: "gpt", name: "GPT" },
  thinkingLevel: "off",
  thinkingLevels: ["off", "high"],
  readiness: { state: "ready" },
};

describe("DraftComposerThread", () => {
  it("复用带样式的 assistant-ui Composer surface", () => {
    function TestSurface() {
      const runtime = useExternalStoreRuntime<ThreadMessage>({
        messages: [],
        isSendDisabled: true,
        onNew: async () => {},
      });
      return (
        <TooltipProvider>
          <AssistantRuntimeProvider runtime={runtime}>
            <DraftComposerThread
              projects={[project]}
              project={project}
              config={config}
              configLoading={false}
              phase="editing"
              onProjectChange={vi.fn()}
              onModelChange={vi.fn()}
              onThinkingChange={vi.fn()}
              onSubmit={vi.fn()}
            />
          </AssistantRuntimeProvider>
        </TooltipProvider>
      );
    }

    const markup = renderToStaticMarkup(createElement(TestSurface));

    expect(markup).toContain('data-draft-composer="true"');
  });

  it("模型列表为空时仍允许展开以触发刷新", () => {
    const markup = renderToStaticMarkup(
      <ModelSelect availableModels={[]} model={undefined} onOpen={vi.fn()} onValueChange={vi.fn()} />,
    );

    expect(markup).not.toContain(' disabled=""');
  });
});
