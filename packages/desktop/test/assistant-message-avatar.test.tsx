import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistantMessage,
  piAssistantProvenance,
} from "../src/renderer/src/components/chat/message/assistant-message.tsx";

interface MessageRow {
  id: string;
  role: string;
}

const viewState = vi.hoisted(() => ({
  showAvatars: true,
  messageId: "assistant-1",
  messages: [{ id: "assistant-1", role: "assistant" }] as MessageRow[],
  pi: { status: { type: "complete" }, provenance: { provider: "anthropic", model: "claude-sonnet-4-5" } },
}));

const messageRoot = vi.hoisted(() => ({ classNames: [] as string[] }));

vi.mock("@assistant-ui/react", () => ({
  useAui: () => ({
    thread: () => ({ composer: () => ({ setQuote: () => undefined }) }),
  }),
  MessagePrimitive: {
    Root: ({ children, className }: { children?: ReactNode; className?: string }) => {
      messageRoot.classNames.push(className ?? "");
      return <div>{children}</div>;
    },
  },
  useAuiState: (selector: (state: unknown) => unknown) => {
    const state = {
      thread: { isRunning: false, messages: viewState.messages },
      message: {
        id: viewState.messageId,
        isLast: true,
        status: { type: "complete" },
        metadata: { custom: { pi: viewState.pi } },
      },
    };
    const selected = selector(state);
    if (!Object.is(selected, selector(state))) throw new Error("useAuiState selector must return a stable value");
    return selected;
  },
}));

vi.mock("../src/renderer/src/state/thinking-visibility.tsx", () => ({
  useThinkingVisibility: () => ({ showAvatars: viewState.showAvatars }),
}));

vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({
    record: {
      stores: {
        runActivity: {
          hasParticipated: () => false,
          markParticipated: () => {},
          reset: () => {},
        },
      },
    },
  }),
}));

vi.mock("../src/renderer/src/components/chat/message/assistant-message-content.tsx", () => ({
  AssistantMessageContent: () => null,
}));

vi.mock("../src/renderer/src/components/chat/message/assistant-message-action-bar.tsx", () => ({
  AssistantMessageActionBar: ({ autohide, compact }: { autohide?: "not-last" | "never"; compact?: boolean }) => (
    <span data-slot="assistant-message-action-bar" data-autohide={autohide} data-compact={compact} />
  ),
}));

describe("AssistantMessage avatar", () => {
  beforeEach(() => {
    viewState.showAvatars = true;
    viewState.messageId = "assistant-1";
    viewState.messages = [{ id: "assistant-1", role: "assistant" }];
    viewState.pi = { status: { type: "complete" }, provenance: { provider: "anthropic", model: "claude-sonnet-4-5" } };
    messageRoot.classNames = [];
  });

  it("关闭显示头像时不渲染头像身份栏", () => {
    viewState.showAvatars = false;

    const html = renderToStaticMarkup(<AssistantMessage />);

    expect(html).not.toContain("message-avatar");
    expect(html).not.toContain('data-slot="message-avatar-header"');
    expect(html).toContain('data-autohide="not-last"');
    expect(html).not.toContain('data-compact="true"');
  });

  it("开启显示头像且为首条 assistant 时在内容上方渲染 provider 与模型名", () => {
    const html = renderToStaticMarkup(<AssistantMessage />);

    expect(html).toContain("message-avatar");
    expect(html).toContain('<img src="');
    expect(html).toContain('alt=""');
    expect(html).toContain('data-autohide="never"');
    expect(html).toContain('data-compact="true"');
    expect(messageRoot.classNames[0]).toContain("aui-assistant-message-avatar-mode");
    expect(html).toContain("gap-2 pb-1");
    expect(messageRoot.classNames[0]).not.toContain("grid-cols-");
    expect(html.indexOf('data-slot="message-avatar-header"')).toBeLessThan(
      html.indexOf('data-slot="assistant-message-content-wrapper"'),
    );
  });

  it("同一轮（run）中后续 assistant 消息不重复头像", () => {
    viewState.messages = [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" },
      { id: "assistant-2", role: "assistant" },
    ];
    viewState.messageId = "assistant-2";

    const html = renderToStaticMarkup(<AssistantMessage />);

    expect(html).not.toContain("message-avatar");
  });

  it("用户消息后的首条 assistant 消息显示头像", () => {
    viewState.messages = [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" },
    ];
    viewState.messageId = "assistant-1";

    const html = renderToStaticMarkup(<AssistantMessage />);

    expect(html).toContain("message-avatar");
  });

  it("无 provenance 的消息（notice）不渲染头像", () => {
    viewState.pi = { kind: "notice" };

    const html = renderToStaticMarkup(<AssistantMessage />);

    expect(html).not.toContain("message-avatar");
  });

  it("头像右侧渲染模型名", () => {
    const html = renderToStaticMarkup(<AssistantMessage />);

    expect(html).toContain('class="message-avatar-name"');
    expect(html).toContain("claude-sonnet-4-5");
  });

  it("无品牌图标的 provider 使用统一的 assistant 默认头像", () => {
    viewState.pi = { status: { type: "complete" }, provenance: { provider: "kimi", model: "kimi-k2" } };

    const html = renderToStaticMarkup(<AssistantMessage />);

    expect(html).toContain("message-avatar-assistant-default");
    expect(html).toContain("message-avatar-assistant-image");
    expect(html).toContain("data:image/svg+xml");
    expect(html).not.toContain("lucide-");
    expect(html).not.toContain(">K</span>");
  });

  it("piAssistantProvenance 从 custom 元数据提取 provider 与模型", () => {
    expect(piAssistantProvenance({ pi: { provenance: { provider: "deepseek", model: "deepseek-chat" } } })).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(piAssistantProvenance({ pi: { kind: "notice" } })).toBeUndefined();
    expect(piAssistantProvenance({ pi: { provenance: { provider: "deepseek" } } })).toBeUndefined();
    expect(piAssistantProvenance({ pi: null })).toBeUndefined();
    expect(piAssistantProvenance(null)).toBeUndefined();
  });
});
