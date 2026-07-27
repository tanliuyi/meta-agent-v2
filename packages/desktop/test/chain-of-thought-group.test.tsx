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

describe("ChainOfThoughtGroup", () => {
  it("配置开启时在 running 阶段自动展开内层分组", () => {
    const markup = renderToStaticMarkup(
      <ChainOfThoughtGroup indices={[0]} running hasFollowingText={false} autoExpandRunning>
        thinking
      </ChainOfThoughtGroup>,
    );

    expect(markup).toContain('data-auto-open="true"');
    expect(markup).toContain('data-auto-expand="true"');
    expect(markup).toContain('data-streaming="true"');
  });

  it("配置关闭时不自动展开内层分组", () => {
    const markup = renderToStaticMarkup(
      <ChainOfThoughtGroup indices={[0]} running hasFollowingText={false} autoExpandRunning={false}>
        thinking
      </ChainOfThoughtGroup>,
    );

    expect(markup).toContain('data-auto-open="true"');
    expect(markup).toContain('data-auto-expand="false"');
    expect(markup).toContain('data-streaming="true"');
  });
});
