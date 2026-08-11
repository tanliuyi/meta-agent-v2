import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelIconSource } from "../src/renderer/src/components/assistant-ui/model-selector/model-selector-icons.tsx";
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
  pi: {
    status: { type: "complete" },
    provenance: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "medium" },
  },
}));

vi.mock("@assistant-ui/react", () => ({
  useAui: () => ({
    thread: () => ({ composer: () => ({ setQuote: () => undefined }) }),
  }),
  MessagePrimitive: {
    Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

describe("AssistantMessage avatar", () => {
  beforeEach(() => {
    viewState.showAvatars = true;
    viewState.messageId = "assistant-1";
    viewState.messages = [{ id: "assistant-1", role: "assistant" }];
    viewState.pi = {
      status: { type: "complete" },
      provenance: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "medium" },
    };
  });

  it("关闭显示头像时不渲染头像身份栏", () => {
    viewState.showAvatars = false;

    const html = renderToStaticMarkup(<AssistantMessage />);

    expect(html).not.toContain("message-avatar");
    expect(html).not.toContain('data-slot="message-avatar-header"');
    expect(html).toContain('data-autohide="not-last"');
    expect(html).not.toContain('data-compact="true"');
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

  it("头像模式使用模型品牌头像而不是聚合 provider 头像", () => {
    viewState.pi = {
      status: { type: "complete" },
      provenance: { provider: "openrouter", model: "google/gemini-3.1-pro-preview", thinkingLevel: "medium" },
    };

    const html = renderToStaticMarkup(<AssistantMessage />);
    const modelIcon = getModelIconSource(
      "openrouter",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.1-pro-preview",
    );

    expect(modelIcon).toBeDefined();
    expect(html).toContain(escapeHtmlAttribute(modelIcon!));
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

  it("piAssistantProvenance 从 custom 元数据提取 provider、模型与思考等级", () => {
    expect(piAssistantProvenance({ pi: { provenance: { provider: "deepseek", model: "deepseek-chat" } } })).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(
      piAssistantProvenance({
        pi: { provenance: { provider: "deepseek", model: "deepseek-chat", thinkingLevel: "high" } },
      }),
    ).toEqual({ provider: "deepseek", model: "deepseek-chat", thinkingLevel: "high" });
    expect(piAssistantProvenance({ pi: { kind: "notice" } })).toBeUndefined();
    expect(piAssistantProvenance({ pi: { provenance: { provider: "deepseek" } } })).toBeUndefined();
    expect(piAssistantProvenance({ pi: null })).toBeUndefined();
    expect(piAssistantProvenance(null)).toBeUndefined();
  });
});
