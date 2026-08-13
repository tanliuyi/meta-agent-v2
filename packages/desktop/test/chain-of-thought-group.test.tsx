import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@assistant-ui/react", () => ({
  groupPartByType: () => () => [],
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({ message: { parts: [{ type: "reasoning", text: "thinking" }] } }),
}));

vi.mock("../src/renderer/src/components/assistant-ui/reasoning/reasoning-root.tsx", () => ({
  ReasoningRoot: ({
    autoOpen,
    autoExpand,
    streaming,
    children,
  }: {
    autoOpen?: boolean;
    autoExpand?: boolean;
    streaming?: boolean;
    children: ReactNode;
  }) => (
    <div data-auto-open={autoOpen} data-auto-expand={autoExpand} data-streaming={streaming}>
      {children}
    </div>
  ),
}));

vi.mock("../src/renderer/src/components/assistant-ui/reasoning/reasoning-trigger.tsx", () => ({
  ReasoningTrigger: () => null,
}));

vi.mock("../src/renderer/src/components/assistant-ui/reasoning/reasoning-content.tsx", () => ({
  ReasoningContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../src/renderer/src/components/assistant-ui/reasoning/reasoning-text.tsx", () => ({
  ReasoningText: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ChainOfThoughtGroup } from "../src/renderer/src/components/chat/message/chain-of-thought-group.tsx";
import { SessionModalContext } from "../src/renderer/src/components/session-modal-context.ts";

describe("ChainOfThoughtGroup", () => {
  it("配置开启时在 running 阶段自动展开内层分组", () => {
    const markup = renderToStaticMarkup(
      <ChainOfThoughtGroup indices={[0]} running hasFollowingText={false} autoExpandRunning stateKey="chain">
        thinking
      </ChainOfThoughtGroup>,
    );

    expect(markup).toContain('data-auto-open="true"');
    expect(markup).toContain('data-auto-expand="true"');
    expect(markup).toContain('data-streaming="true"');
  });

  it("配置关闭时不自动展开内层分组", () => {
    const markup = renderToStaticMarkup(
      <ChainOfThoughtGroup indices={[0]} running hasFollowingText={false} autoExpandRunning={false} stateKey="chain">
        thinking
      </ChainOfThoughtGroup>,
    );

    expect(markup).toContain('data-auto-open="true"');
    expect(markup).toContain('data-auto-expand="false"');
    expect(markup).toContain('data-streaming="true"');
  });

  it("全屏会话 modal 内默认不展开（autoOpen 与 autoExpand 均关闭）", () => {
    const markup = renderToStaticMarkup(
      <SessionModalContext.Provider value>
        <ChainOfThoughtGroup indices={[0]} running hasFollowingText={false} autoExpandRunning stateKey="chain">
          thinking
        </ChainOfThoughtGroup>
      </SessionModalContext.Provider>,
    );

    // modal 内即使 running 且配置开启，也默认收起；用户手动展开由 ReasoningRoot 的
    // stateKey 记忆（userOpen 优先），不会被强制收起。
    expect(markup).toContain('data-auto-open="false"');
    expect(markup).toContain('data-auto-expand="false"');
    expect(markup).toContain('data-streaming="true"');
  });

  it("modal 上下文不影响普通聊天的默认展开行为", () => {
    const markup = renderToStaticMarkup(
      <ChainOfThoughtGroup indices={[0]} running hasFollowingText={false} autoExpandRunning stateKey="chain">
        thinking
      </ChainOfThoughtGroup>,
    );

    // 无 Provider 时 context 默认 false，普通聊天保持现有自动展开。
    expect(markup).toContain('data-auto-open="true"');
    expect(markup).toContain('data-auto-expand="true"');
  });
});
