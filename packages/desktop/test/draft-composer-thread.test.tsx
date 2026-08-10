import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from "@assistant-ui/react";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DraftComposerThread } from "../src/renderer/src/components/chat/draft-composer-thread.tsx";
import { ModelSelect } from "../src/renderer/src/components/chat/model-select.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import type { DraftSessionConfig, Project } from "../src/shared/contracts.ts";

vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({ record: { key: "test-session" } }),
}));

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
  extensions: { extensionSetGeneration: "test-generation", diagnostics: [] },
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
    expect(markup).toContain("draft-composer-drawer");
    expect(markup).toContain("max-w-(--layout-draft-composer-max-width)");
    expect(markup).not.toContain("max-w-(--layout-thread-max-width)");
  });

  it("将本地插件覆盖提示收敛为具体的信息反馈", () => {
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
              diagnostics={[
                {
                  extensionId: "pi.web-access",
                  source: "marketplace",
                  phase: "resolve",
                  code: "DESKTOP_EXTENSION_SUPERSEDED_BY_DEVELOPMENT",
                  message: "本地插件“Web Access”已覆盖市场插件“Web Access”，当前使用本地版本。",
                },
              ]}
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

    expect(markup).toContain('class="composer-feedback" data-tone="info"');
    expect(markup).not.toContain("本地插件优先");
    expect(markup).toContain("本地插件“Web Access”已覆盖市场插件“Web Access”");
    expect(markup).toContain("当前使用本地版本");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("composer-feedback-title");
    expect(markup).toContain("composer-feedback-icon");
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("composer-error");
  });

  it("compact 模式隐藏标题并靠下对齐（侧边栏草稿）", () => {
    function TestCompactSurface() {
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
              fixedProject
              compact
              onProjectChange={vi.fn()}
              onModelChange={vi.fn()}
              onThinkingChange={vi.fn()}
              onSubmit={vi.fn()}
            />
          </AssistantRuntimeProvider>
        </TooltipProvider>
      );
    }

    const markup = renderToStaticMarkup(createElement(TestCompactSurface));

    expect(markup).not.toContain("做什么");
    expect(markup).toContain("bg-background justify-end");
    expect(markup).not.toContain("bg-background justify-center");
    expect(markup).toContain('data-draft-composer="true"');
    expect(markup).not.toContain("draft-composer-drawer");
  });

  it("非 compact 模式保留标题与居中（路由新会话）", () => {
    function TestRoutedSurface() {
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

    const markup = renderToStaticMarkup(createElement(TestRoutedSurface));

    expect(markup).toContain("做什么");
    expect(markup).toContain('class="draft-project-name"');
    expect(markup).toContain("bg-background justify-center");
  });

  it("模型列表为空时仍允许展开以触发刷新", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ModelSelect availableModels={[]} model={undefined} onOpen={vi.fn()} onValueChange={vi.fn()} />
      </TooltipProvider>,
    );

    expect(markup).not.toContain(' disabled=""');
    expect(markup).toContain('aria-label="选择模型"');
  });

  it("已有模型时后台刷新不替换当前模型标签", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ModelSelect availableModels={config.models} model={config.model} loading onValueChange={vi.fn()} />
      </TooltipProvider>,
    );

    expect(markup).toContain('aria-label="选择模型"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain(' disabled=""');
    expect(markup).toContain("GPT");
    expect(markup).not.toContain("加载模型");
  });

  it("模型列表加载时显示进度并禁用选择器", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <ModelSelect availableModels={[]} model={undefined} loading onValueChange={vi.fn()} />
      </TooltipProvider>,
    );

    expect(markup).toContain('aria-label="正在加载模型"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("加载模型");
  });
});
