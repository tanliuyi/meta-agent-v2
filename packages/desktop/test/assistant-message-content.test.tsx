import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TestPart {
  type: "reasoning" | "tool-call" | "text" | "data";
  toolName?: string;
  text?: string;
  name?: string;
  data?: unknown;
}

interface TestToolUI {
  standalone?: boolean;
}

interface TestMessage {
  id: string;
  role: "user" | "assistant";
  content: TestPart[];
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
  useAuiState: (selector: (state: unknown) => unknown) => {
    const messages =
      viewState.runMessages.length > 0
        ? viewState.runMessages
        : [{ id: viewState.messageId, role: "assistant", content: viewState.parts }];
    return selector({
      message: {
        id: viewState.messageId,
        index: messages.findIndex(({ id }) => id === viewState.messageId),
        parts: viewState.parts,
        createdAt: new Date(0),
        status: { type: "complete" },
        metadata: { custom: { pi: { completedAt: viewState.completedAt } } },
      },
      thread: { messages },
      tools: { toolUIs: viewState.toolUIs },
    });
  },
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
    persistentContent,
    hasContent,
    running,
    completedAt,
    defaultOpenWhenComplete,
  }: {
    children: ReactNode;
    persistentContent?: ReactNode;
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
      {!hasContent || (!running && !defaultOpenWhenComplete) ? persistentContent : null}
    </div>
  ),
}));

vi.mock("../src/renderer/src/components/chat/tool-view.tsx", () => ({
  ToolView: () => <div data-testid="tool" />,
}));

vi.mock("../src/renderer/src/components/chat/pi-notice-view.tsx", () => ({
  PiNoticeView: ({ data }: { data: unknown }) => (
    <div data-testid="pi-notice">
      {data && typeof data === "object" && "content" in data && typeof data.content === "string" ? data.content : null}
    </div>
  ),
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
      { id: "user", role: "user", content: [{ type: "text", text: "问题" }] },
      { id: viewState.messageId, role: "assistant", content: viewState.parts },
      { id: "assistant-final", role: "assistant", content: [{ type: "text", text: "最终回复" }] },
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

  it("尾部 notification 在 activity 收起后仍渲染", () => {
    viewState.parts = [
      { type: "reasoning" },
      { type: "data", name: "pi-notice", data: { noticeType: "notification" } },
    ];

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain('data-testid="run-activity"');
    expect(markup).toContain('data-has-content="false"');
    expect(markup).toContain('data-testid="pi-notice"');
  });

  it("notification 不拆分同一次 run activity", () => {
    viewState.parts = [
      { type: "reasoning" },
      {
        type: "data",
        name: "pi-notice",
        data: { noticeType: "notification", notificationType: "info", content: "status" },
      },
      { type: "reasoning" },
    ];

    const markup = renderToStaticMarkup(<AssistantMessageContent isRunActivityRunning isMessageRunning />);

    expect(markup.match(/data-testid="run-activity"/g)).toHaveLength(1);
    expect(markup).toContain("status");
  });

  it("连续 info notification 参考 Pi TUI 仅显示最后一条状态", () => {
    viewState.parts = [
      {
        type: "data",
        name: "pi-notice",
        data: { noticeType: "notification", notificationType: "info", content: "TPS 10" },
      },
      {
        type: "data",
        name: "pi-notice",
        data: { noticeType: "notification", notificationType: "info", content: "TPS 20" },
      },
    ];

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).not.toContain("TPS 10");
    expect(markup).toContain("TPS 20");
    expect(markup.match(/data-testid="pi-notice"/g)).toHaveLength(1);
  });

  it("中间出现 assistant 内容时保留两条 info notification", () => {
    viewState.parts = [
      {
        type: "data",
        name: "pi-notice",
        data: { noticeType: "notification", notificationType: "info", content: "TPS 10" },
      },
      { type: "reasoning" },
      {
        type: "data",
        name: "pi-notice",
        data: { noticeType: "notification", notificationType: "info", content: "TPS 20" },
      },
    ];

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain("TPS 10");
    expect(markup).toContain("TPS 20");
    expect(markup.match(/data-testid="pi-notice"/g)).toHaveLength(2);
  });

  it("warning notification 不参与 info 状态替换", () => {
    viewState.parts = [
      {
        type: "data",
        name: "pi-notice",
        data: { noticeType: "notification", notificationType: "warning", content: "warning 1" },
      },
      {
        type: "data",
        name: "pi-notice",
        data: { noticeType: "notification", notificationType: "warning", content: "warning 2" },
      },
    ];

    const markup = renderToStaticMarkup(
      <AssistantMessageContent isRunActivityRunning={false} isMessageRunning={false} />,
    );

    expect(markup).toContain("warning 1");
    expect(markup).toContain("warning 2");
    expect(markup.match(/data-testid="pi-notice"/g)).toHaveLength(2);
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
