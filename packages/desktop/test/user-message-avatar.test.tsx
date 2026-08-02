import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserMessage } from "../src/renderer/src/components/chat/message/user-message.tsx";
import { userAvatarInitial } from "../src/renderer/src/shared/lib/user-avatar-initial.ts";

const viewState = vi.hoisted(() => ({
  showAvatars: true,
  editing: false,
  hasAttachments: false,
  userName: "Tan",
  userAvatarPath: null as string | null,
  messageId: "user-2",
  messages: [
    { id: "assistant-1", role: "assistant" },
    { id: "user-2", role: "user" },
  ],
}));

const userRoot = vi.hoisted(() => ({ classNames: [] as string[] }));

vi.mock("@assistant-ui/react", () => ({
  MessagePrimitive: {
    Root: ({ children, className }: { children?: ReactNode; className?: string }) => {
      userRoot.classNames.push(className ?? "");
      return <div>{children}</div>;
    },
  },
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({
      message: {
        id: viewState.messageId,
        composer: { isEditing: viewState.editing },
        attachments: viewState.hasAttachments ? [{ id: "attachment-1" }] : [],
      },
      thread: { messages: viewState.messages },
    }),
}));

vi.mock("../src/renderer/src/state/thinking-visibility.tsx", () => ({
  useThinkingVisibility: () => ({
    showAvatars: viewState.showAvatars,
    userName: viewState.userName,
    userAvatarPath: viewState.userAvatarPath,
  }),
}));

vi.mock("../src/renderer/src/components/chat/message/user-message-content.tsx", () => ({
  UserMessageContent: () => null,
}));

vi.mock("../src/renderer/src/components/chat/message/user-message-action-bar.tsx", () => ({
  UserMessageActionBar: ({ autohide }: { autohide?: "always" | "never" }) => (
    <span data-slot="user-message-action-bar" data-autohide={autohide} />
  ),
}));

vi.mock("../src/renderer/src/components/assistant-ui/attachment/user-message-attachments.tsx", () => ({
  UserMessageAttachments: ({ align }: { align?: "start" | "end" }) => (
    <span data-slot="user-message-attachments" data-align={align} />
  ),
}));

describe("UserMessage avatar", () => {
  beforeEach(() => {
    viewState.showAvatars = true;
    viewState.editing = false;
    viewState.hasAttachments = false;
    viewState.userName = "Tan";
    viewState.userAvatarPath = null;
    viewState.messageId = "user-2";
    viewState.messages = [
      { id: "assistant-1", role: "assistant" },
      { id: "user-2", role: "user" },
    ];
    userRoot.classNames = [];
  });

  it("开启显示头像时在消息上方渲染左对齐身份栏，消息铺满宽度", () => {
    const html = renderToStaticMarkup(<UserMessage />);

    expect(html).toContain("message-avatar");
    expect(html).toContain("message-avatar-user-default");
    expect(html).toContain(">T</span>");
    expect(html).toContain("message-avatar-name-user");
    expect(html).toContain('data-slot="message-avatar-header"');
    expect(html).toContain("mt-8");
    expect(html).toContain("Tan");
    expect(html).toContain('data-slot="user-message-action-bar"');
    expect(html).toContain('data-autohide="always"');
    expect(html).toContain("aui-user-message-content-wrapper min-w-0");
    expect(html).toContain("mt-1 w-full");
    expect(html).toContain("sticky top-0");
    expect(html).toContain("aui-user-message-footer flex w-full items-center min-h-7");
    expect(html.indexOf("aui-user-message-content-wrapper")).toBeLessThan(html.indexOf("aui-user-message-footer"));
    expect(html).not.toContain("max-w-");
    expect(userRoot.classNames[0]).not.toContain("grid-cols-");
    expect(userRoot.classNames[0]).toContain("contents");
    expect(userRoot.classNames[0]).not.toContain("sticky");
    expect(html).toContain("aui-user-message-sticky");
  });

  it("使用路径 URL 渲染自定义用户头像", () => {
    viewState.userAvatarPath = "/Users/tan/avatar.png";

    const html = renderToStaticMarkup(<UserMessage />);

    expect(html).toContain("meta-agent-avatar://local/image?path=%2FUsers%2Ftan%2Favatar.png");
    expect(html).not.toContain("message-avatar-user-default");
  });

  it("开启显示头像时附件跟随消息内容左对齐", () => {
    viewState.hasAttachments = true;

    const html = renderToStaticMarkup(<UserMessage />);

    expect(html).toContain('data-slot="user-message-attachments"');
    expect(html).toContain('data-align="start"');
  });

  it("线程首条用户消息保留较小顶部间距", () => {
    viewState.messageId = "user-1";
    viewState.messages = [{ id: "user-1", role: "user" }];

    const html = renderToStaticMarkup(<UserMessage />);

    expect(html).toContain("mt-3");
    expect(html).not.toContain("mt-8");
  });

  it("关闭显示头像时不渲染身份栏且不保留横向 padding", () => {
    viewState.showAvatars = false;
    viewState.hasAttachments = true;

    const html = renderToStaticMarkup(<UserMessage />);

    expect(html).not.toContain("message-avatar");
    expect(html).toContain("aui-user-message-footer");
    expect(html).toContain('data-slot="user-message-action-bar"');
    expect(html).toContain('data-autohide="always"');
    expect(userRoot.classNames[0]).not.toContain("grid-cols-");
    expect(userRoot.classNames[0]).not.toContain("px-2");
    expect(userRoot.classNames[0]).not.toContain("sticky");
    expect(userRoot.classNames[0]).not.toContain("contents");
    expect(userRoot.classNames[0]).toContain("content-visibility:auto");
    expect(html).toContain("relative w-fit max-w-[85%] self-end");
    expect(html).not.toContain("mt-1 w-full");
    expect(html).toContain('data-align="end"');
  });
});

describe("userAvatarInitial", () => {
  it.each([
    ["用户", "用"],
    [" Tan ", "T"],
    ["😀 Codex", "😀"],
    ["  ", "用"],
  ])("从 %s 生成 %s", (userName, expected) => {
    expect(userAvatarInitial(userName)).toBe(expected);
  });
});
