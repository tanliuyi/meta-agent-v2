import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const viewState = vi.hoisted(() => ({
  parts: [] as Array<{ type: "reasoning" | "tool-call" }>,
}));

vi.mock("@assistant-ui/react", () => ({
  ErrorPrimitive: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Message: () => null,
  },
  groupPartByType: () => () => [],
  MessagePrimitive: {
    Error: ({ children }: { children: ReactNode }) => <>{children}</>,
    GroupedParts: ({
      children,
    }: {
      children: (props: { part: Record<string, unknown>; children: ReactNode }) => ReactNode;
    }) => {
      const chainChildren = viewState.parts.map((part) =>
        children({ part: { ...part, status: { type: "complete" } }, children: null }),
      );
      const chain = children({
        part: {
          type: "group-chainOfThought",
          indices: viewState.parts.map((_, index) => index),
          status: { type: "complete" },
        },
        children: (
          <>
            {chainChildren.map((child, index) => (
              <React.Fragment key={index}>{child}</React.Fragment>
            ))}
          </>
        ),
      });
      return children({ part: { type: "group-runActivity" }, children: chain });
    },
  },
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({ message: { parts: viewState.parts, createdAt: new Date(0), status: { type: "complete" } } }),
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
  RunActivityGroup: ({ children }: { children: ReactNode }) => <div data-testid="run-activity">{children}</div>,
}));

vi.mock("../src/renderer/src/components/chat/tool-view.tsx", () => ({
  ToolView: () => <div data-testid="tool" />,
}));

vi.mock("../src/renderer/src/components/chat/pi-notice-view.tsx", () => ({
  PiNoticeView: () => null,
}));

import { AssistantMessageContent } from "../src/renderer/src/components/chat/message/assistant-message-content.tsx";

describe("AssistantMessageContent thinking visibility", () => {
  it("关闭 Thinking 时不渲染纯 reasoning group", () => {
    viewState.parts = [{ type: "reasoning" }];

    const markup = renderToStaticMarkup(<AssistantMessageContent isRunActivityRunning={false} />);

    expect(markup).toContain('data-testid="run-activity"');
    expect(markup).not.toContain('data-testid="chain-group"');
    expect(markup).not.toContain('data-testid="thinking-text"');
  });

  it("关闭 Thinking 时保留含工具的折叠组，但隐藏 reasoning 正文", () => {
    viewState.parts = [{ type: "reasoning" }, { type: "tool-call" }];

    const markup = renderToStaticMarkup(<AssistantMessageContent isRunActivityRunning={false} />);

    expect(markup).toContain('data-testid="run-activity"');
    expect(markup).toContain('data-testid="chain-group"');
    expect(markup).toContain('data-testid="tool"');
    expect(markup).not.toContain('data-testid="thinking-text"');
  });
});
