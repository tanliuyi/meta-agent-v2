import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestPart {
  type: "reasoning" | "tool-call" | "text";
  toolName?: string;
  text?: string;
}

interface TestToolUI {
  standalone?: boolean;
}

interface TestMessage {
  id: string;
  role: "user" | "assistant";
  parts: TestPart[];
}

const viewState = vi.hoisted(() => ({
  parts: [] as TestPart[],
  toolUIs: {} as Record<string, TestToolUI[]>,
  completedAt: undefined as number | undefined,
  autoExpandRunning: true,
  showAvatars: false,
  messageId: "assistant-current",
  runMessages: [] as TestMessage[],
}));

vi.mock("@assistant-ui/react", () => ({
  ErrorPrimitive: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Message: () => null,
  },
  groupPartByType:
    (groups: Record<string, readonly string[]>) =>
    (part: TestPart, context: { toolUIs?: Record<string, TestToolUI[]> }) => {
      const standaloneTool =
        part.type === "tool-call" &&
        part.toolName !== undefined &&
        context.toolUIs?.[part.toolName]?.some((toolUI) => toolUI.standalone);
      return groups[standaloneTool ? "standalone-tool-call" : part.type] ?? [];
    },
  MessagePrimitive: {
    Error: ({ children }: { children: ReactNode }) => <>{children}</>,
    GroupedParts: ({
      children,
      groupBy,
    }: {
      children: (props: { part: Record<string, unknown>; children: ReactNode }) => ReactNode;
      groupBy: (part: TestPart, context: { toolUIs: Record<string, TestToolUI[]> }) => readonly string[];
    }) => {
      const chainChildren = viewState.parts.map((part) =>
        children({ part: { ...part, status: { type: "complete" } }, children: null }),
      );
      const groupedIndices = viewState.parts.flatMap((part, index) =>
        groupBy(part, { toolUIs: viewState.toolUIs })[0] === "group-runActivity" ? [index] : [],
      );
      if (groupedIndices.length === 0) return <>{chainChildren}</>;
      const chain = children({
        part: {
          type: "group-chainOfThought",
          indices: groupedIndices,
          status: { type: "complete" },
        },
        children: (
          <>
            {groupedIndices.map((index) => (
              <React.Fragment key={index}>{chainChildren[index]}</React.Fragment>
            ))}
          </>
        ),
      });
      return (
        <>
          {children({
            part: { type: "group-runActivity", indices: groupedIndices },
            children: chain,
          })}
          {chainChildren.map((child, index) =>
            groupedIndices.includes(index) ? null : <React.Fragment key={index}>{child}</React.Fragment>,
          )}
        </>
      );
    },
  },
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({
      message: {
        id: viewState.messageId,
        parts: viewState.parts,
        createdAt: new Date(0),
        status: { type: "complete" },
        metadata: { custom: { pi: { completedAt: viewState.completedAt } } },
      },
      thread: {
        messages:
          viewState.runMessages.length > 0
            ? viewState.runMessages
            : [{ id: viewState.messageId, role: "assistant", parts: viewState.parts }],
      },
      tools: { toolUIs: viewState.toolUIs },
    }),
}));

vi.mock("../src/renderer/src/state/thinking-visibility.tsx", () => ({
  useThinkingVisibility: () => ({
    showThinking: false,
    autoExpandRunning: viewState.autoExpandRunning,
    showAvatars: viewState.showAvatars,
  }),
}));

vi.mock("../src/renderer/src/components/assistant-ui/streamdown/streamdown-text.tsx", () => ({
  StreamdownText: () => <div data-testid="thinking-text" />,
}));

vi.mock("../src/renderer/src/components/chat/message/chain-of-thought-group.tsx", () => ({
  ChainOfThoughtGroup: ({ children, autoExpandRunning }: { children: ReactNode; autoExpandRunning: boolean }) => (
    <div data-testid="chain-group" data-auto-expand-running={autoExpandRunning}>
      {children}
    </div>
  ),
}));

vi.mock("../src/renderer/src/components/chat/message/run-activity-group.tsx", () => ({
  RunActivityGroup: ({
    children,
    hasContent,
    running,
    completedAt,
    defaultOpenWhenComplete,
  }: {
    children: ReactNode;
    hasContent: boolean;
    running: boolean;
    completedAt?: number;
    defaultOpenWhenComplete?: boolean;
  }) => (
    <div
      data-testid="run-activity"
      data-has-content={hasContent}
      data-running={running}
      data-completed-at={completedAt}
      data-default-open-when-complete={defaultOpenWhenComplete}
    >
      {hasContent ? children : null}
    </div>
  ),
}));

vi.mock("../src/renderer/src/components/chat/tool-view.tsx", () => ({
  ToolView: () => <div data-testid="tool" />,
}));

vi.mock("../src/renderer/src/components/chat/pi-notice-view.tsx", () => ({
  PiNoticeView: () => null,
}));

import { AssistantMessageContent } from "../src/renderer/src/components/chat/message/assistant-message-content.tsx";

describe("AssistantMessageContent thinking visibility", () => {
  beforeEach(() => {
    viewState.parts = [];
    viewState.toolUIs = {};
    viewState.completedAt = undefined;
    viewState.autoExpandRunning = true;
    viewState.showAvatars = false;
    viewState.messageId = "assistant-current";
    viewState.runMessages = [];
  });

  it("关闭 Thinking 时不渲染纯 reasoning group", () => {
    viewState.parts = [{ type: "reasoning" }];

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain('data-testid="run-activity"');
    expect(markup).toContain('data-has-content="false"');
    expect(markup).not.toContain('data-testid="chain-group"');
    expect(markup).not.toContain('data-testid="thinking-text"');
  });

  it("关闭 Thinking 时保留含工具的折叠组，但隐藏 reasoning 正文", () => {
    viewState.parts = [{ type: "reasoning" }, { type: "tool-call" }];

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain('data-testid="run-activity"');
    expect(markup).toContain('data-has-content="true"');
    expect(markup).toContain('data-testid="chain-group"');
    expect(markup).toContain('data-testid="tool"');
    expect(markup).not.toContain('data-testid="thinking-text"');
  });

  it("仅将 running 自动展开配置传给 Thinking 工具组", () => {
    viewState.parts = [{ type: "reasoning" }, { type: "tool-call" }];
    viewState.autoExpandRunning = false;

    const markup = renderToStaticMarkup(<AssistantMessageContent isRunActivityRunning isMessageRunning />);

    expect(markup).toContain('data-testid="run-activity"');
    expect(markup).toContain('data-auto-expand-running="false"');
  });

  it("仅在头像模式收紧内容组间距", () => {
    viewState.showAvatars = true;

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain("flex flex-col gap-2");
    expect(markup).not.toContain("flex flex-col gap-3 text-sm/6");
  });

  it("头像模式没有最终回复时让历史 activity 默认展开", () => {
    viewState.showAvatars = true;
    viewState.parts = [{ type: "reasoning" }, { type: "tool-call" }];

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain('data-default-open-when-complete="true"');
  });

  it("头像模式存在最终回复时让历史 activity 默认折叠", () => {
    viewState.showAvatars = true;
    viewState.parts = [{ type: "reasoning" }, { type: "tool-call" }, { type: "text", text: "最终回复" }];

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain('data-default-open-when-complete="false"');
  });

  it("同一 run 的最终回复位于后续 assistant 消息时仍默认折叠", () => {
    viewState.showAvatars = true;
    viewState.parts = [{ type: "reasoning" }, { type: "tool-call" }];
    viewState.runMessages = [
      { id: "user", role: "user", parts: [{ type: "text", text: "问题" }] },
      { id: viewState.messageId, role: "assistant", parts: viewState.parts },
      { id: "assistant-final", role: "assistant", parts: [{ type: "text", text: "最终回复" }] },
    ];

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain('data-default-open-when-complete="false"');
  });

  it("将 repository 中的完成时间传给历史 activity", () => {
    viewState.parts = [{ type: "reasoning" }];
    viewState.completedAt = 12_000;

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain('data-completed-at="12000"');
  });

  it("standalone tool 不压制独立 running indicator", () => {
    viewState.parts = [{ type: "tool-call", toolName: "ask_user" }];
    viewState.toolUIs = { ask_user: [{ standalone: true }] };

    const markup = renderToStaticMarkup(<AssistantMessageContent isRunActivityRunning isMessageRunning />);

    expect(markup).toContain('data-testid="run-activity"');
    expect(markup).toContain('data-running="true"');
    expect(markup).toContain('data-has-content="false"');
    expect(markup).toContain('data-testid="tool"');
  });
});
