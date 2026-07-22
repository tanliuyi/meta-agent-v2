import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestPart {
  type: "reasoning" | "tool-call";
  toolName?: string;
}

interface TestToolUI {
  standalone?: boolean;
}

const viewState = vi.hoisted(() => ({
  parts: [] as TestPart[],
  toolUIs: {} as Record<string, TestToolUI[]>,
  completedAt: undefined as number | undefined,
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
        parts: viewState.parts,
        createdAt: new Date(0),
        status: { type: "complete" },
        metadata: { custom: { pi: { completedAt: viewState.completedAt } } },
      },
      tools: { toolUIs: viewState.toolUIs },
    }),
}));

vi.mock("../src/renderer/src/state/thinking-visibility.tsx", () => ({
  useThinkingVisibility: () => ({ showThinking: false }),
}));

vi.mock("../src/renderer/src/components/assistant-ui/streamdown/streamdown-text.tsx", () => ({
  StreamdownText: () => <div data-testid="thinking-text" />,
}));

vi.mock("../src/renderer/src/components/chat/message/chain-of-thought-group.tsx", () => ({
  ChainOfThoughtGroup: ({ children }: { children: ReactNode }) => <div data-testid="chain-group">{children}</div>,
}));

vi.mock("../src/renderer/src/components/chat/message/run-activity-group.tsx", () => ({
  RunActivityGroup: ({
    children,
    hasContent,
    running,
    completedAt,
  }: {
    children: ReactNode;
    hasContent: boolean;
    running: boolean;
    completedAt?: number;
  }) => (
    <div
      data-testid="run-activity"
      data-has-content={hasContent}
      data-running={running}
      data-completed-at={completedAt}
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
