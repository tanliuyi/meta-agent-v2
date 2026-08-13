import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  quote: {
    text: "第一段引用",
    messageId: "assistant-1",
    quotes: [
      {
        text: "第一段引用",
        messageId: "assistant-1",
        tags: ["浏览器标注", "div #main", "https://example.com"],
      },
      {
        text: "第二段引用",
        messageId: "assistant-2",
        tags: ["浏览器标注", "元素 textarea", "选择器 #chat-textarea"],
      },
    ],
  },
}));

vi.mock("@assistant-ui/react", () => ({
  useAui: () => ({
    composer: () => ({ setQuote: vi.fn() }),
    thread: () => ({ composer: () => ({ getState: () => ({ quote: fixture.quote }), setQuote: vi.fn() }) }),
  }),
  useAuiState: (selector: (state: unknown) => unknown) => selector({ composer: { quote: fixture.quote } }),
}));

vi.mock("@radix-ui/react-popover", () => ({
  Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({
    children,
    className,
    "aria-label": ariaLabel,
  }: {
    children?: ReactNode;
    className?: string;
    "aria-label"?: string;
  }) => (
    <div className={className} aria-label={ariaLabel}>
      {children}
    </div>
  ),
}));

import { ComposerQuotes } from "../src/renderer/src/components/chat/composer/composer-quotes.tsx";
import { SessionModalContext } from "../src/renderer/src/components/session-modal-context.ts";

describe("ComposerQuotes UI", () => {
  it("默认显示数量，并为每条引用保留 hover 预览与删除入口", () => {
    const markup = renderToStaticMarkup(<ComposerQuotes />);

    expect(markup).toContain('aria-label="2 条引用"');
    expect(markup).toContain("2 条引用");
    expect(markup).toContain("composer-quotes-trigger");
    expect(markup).toContain("composer-quotes-preview");
    expect(markup).toContain("1.");
    expect(markup).toContain("第一段引用");
    expect(markup).toContain("浏览器标注");
    expect(markup).toContain("composer-quotes-preview-tag-icon");
    expect(markup).toContain("div #main");
    expect(markup).toContain("https://example.com");
    expect(markup).toContain("2.");
    expect(markup).toContain("第二段引用");
    expect(markup).toContain("textarea #chat-textarea");
    expect(markup).not.toContain("元素 div");
    expect(markup).not.toContain("元素 textarea");
    expect(markup).not.toContain("选择器 #chat-textarea");
    expect(markup).not.toContain("链接 https://example.com");
    expect(markup).not.toContain("所选文本：");
    expect(markup).toContain("移除全部引用");
    expect(markup).toContain("移除第 1 条引用");
    expect(markup).toContain("移除第 2 条引用");
  });

  it("普通聊天保持 popover 默认层级", () => {
    const markup = renderToStaticMarkup(<ComposerQuotes />);

    expect(markup).toContain("z-(--stack-popover)");
    expect(markup).not.toContain("z-(--stack-menu)");
  });

  it("全屏会话 modal 内把引用预览提升到 menu 层级", () => {
    const markup = renderToStaticMarkup(
      <SessionModalContext.Provider value>
        <ComposerQuotes />
      </SessionModalContext.Provider>,
    );

    // tailwind-merge 会用后传入的 z-(--stack-menu) 覆盖默认 z-(--stack-popover)。
    expect(markup).toContain("z-(--stack-menu)");
    expect(markup).not.toContain("z-(--stack-popover)");
  });
});
